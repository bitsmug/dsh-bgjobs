// bgjobs core —— 任务注册表/索引/只读查询域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// 仅依赖 store（registry 内存表）与纯函数模块；被 watch/wait/jobs/web/tools 各域消费。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { readBgjobsIndex, updateBgjobsIndex } from '../index-store.js'
import { strip, parseExitCode } from '../util.js'

export function createRegistry(ctx, store) {
  const registry = store.registry

  // ── 结果交付标记（notify 视图）：全任务 pending→delivered ──────────────────
  // delivered = 任务结果已进入创建者 agent 上下文：完成通知投递成功（by='notify'）
  // 或某次 wait 返回了它的结果（by='wait'）。先到者生效，不覆盖（notifiedBy 记首通道）。
  const markDelivered = async (job, by) => {
    if (job.meta.notifiedAt !== undefined && job.meta.notifiedAt !== null) return false
    const at = Date.now()
    job.meta.notifiedAt = at
    job.meta.notifiedBy = by
    try {
      await fsp.writeFile(job.meta.jsonPath, JSON.stringify(Object.assign({}, job.meta,
        { status: job.status, ...(job.status === 'done' ? { exitCode: job.exitCode, finishedAt: job.finishedAt } : {}) })), 'utf8')
    } catch (e) { /* 尽力而为 */ }
    return true
  }
  // 按 jobId 交付：registry 命中走内存 job；否则定位磁盘 job.json 补标记回写（尽力）。
  const markDeliveredId = async (jobId, by) => {
    const j = registry.get(String(jobId))
    if (j) return markDelivered(j, by)
    try {
      const jobDir = await locateJobDir(jobId)
      if (!jobDir) return false
      const p = path.join(jobDir, 'job.json')
      const meta = JSON.parse(await fsp.readFile(p, 'utf8'))
      if (!meta || meta.id !== jobId || (meta.notifiedAt !== undefined && meta.notifiedAt !== null)) return false
      meta.notifiedAt = Date.now()
      meta.notifiedBy = by
      await fsp.writeFile(p, JSON.stringify(meta), 'utf8')
      return true
    } catch (e) { return false }
  }
  /** 任务交付状态（快照/列表用）。 */
  const deliveredOf = (job) => (
    job.meta.notifiedAt === undefined || job.meta.notifiedAt === null
      ? { notified: false, notifiedAt: null, notifiedBy: null }
      : { notified: true, notifiedAt: Number(job.meta.notifiedAt), notifiedBy: job.meta.notifiedBy || 'notify' }
  )
  // 索引写入（静默）：索引只存 jobDir 当"地图"，状态仍实时读 job.json。
  const indexUpsert = (job) => {
    updateBgjobsIndex((jobs) => {
      const existing = jobs.find((j) => j.id === job.id)
      const entry = {
        id: job.id,
        jobDir: job.meta.jobDir || path.dirname(job.meta.jsonPath),
        workdir: job.meta.workdir,
        name: String(job.meta.name || job.id),
        createdBySession: String(job.meta.createdBySession || ''),
        createdAt: Number(job.meta.createdAt) || 0,
      }
      if (existing) Object.assign(existing, entry)
      else jobs.push(entry)
    }).catch(() => {})
  }
  const indexRemove = (id) => {
    updateBgjobsIndex((jobs) => {
      const at = jobs.findIndex((j) => j.id === id)
      if (at >= 0) jobs.splice(at, 1)
    }).catch(() => {})
  }

  const view = (job) => ({
    id: job.id, name: job.meta.name, status: job.status,
    exitCode: job.exitCode === undefined ? null : job.exitCode,
    logPath: job.meta.logPath, tail: job.tail, workdir: job.meta.workdir,
    sandbox: job.meta.sandbox || 'off',
    // 面板按 finishedAt 判断「清理 24h 前」：done 任务必有；running 为 null。
    finishedAt: job.finishedAt === undefined || job.finishedAt === null ? null : job.finishedAt,
    // notify（交付）标记：面板展示 已通知/待通知。
    ...deliveredOf(job),
  })

  // 按 jobId 定位任务目录：中央索引优先（全局地图），工作区扫描兜底；找不到返回 ''。
  // 只做定位，不改任何状态。statusFromDisk 与 /bgjobs/log 路由共用。
  const locateJobDir = async (jobId) => {
    let jobDir = ''
    try {
      const index = await readBgjobsIndex()
      const entry = index.jobs.find((j) => j.id === jobId)
      jobDir = entry && entry.jobDir ? String(entry.jobDir) : ''
    } catch (e) { /* 索引不可读，走工作区扫描 */ }
    if (!jobDir) {
      const wsReg = ctx.get('workspaceRegistry')
      if (wsReg !== undefined) {
        let workspaces = []
        try { workspaces = wsReg.list() } catch (e) { return '' }
        for (const ws of workspaces) {
          const root = ws && ws.path ? strip(String(ws.path)) : ''
          if (!root) continue
          const jobsRoot = root + '\\.dsh\\bgjobs'
          let names = []
          try { names = await fsp.readdir(jobsRoot) } catch (e) { continue }
          if (names.includes(jobId)) { jobDir = jobsRoot + '\\' + jobId; break }
        }
      }
    }
    return jobDir
  }

  // bgjob_status 的磁盘回退：内存注册表未命中（典型：DSH 会话重启后旧 id 不再被
  // 追踪，但 schtasks 托管的任务仍在运行）时，从中央索引或工作区扫描定位 jobDir，
  // 实时读 job.json / exitcode.txt / 日志尾部，返回与内存路径同构的结果。
  // 只读查询：绝不调用 schtasks /End//Delete 或 removeJob 等终止逻辑。
  const statusFromDisk = async (jobId) => {
    const jobDir = await locateJobDir(jobId)
    if (!jobDir) return null
    let meta
    try {
      meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    } catch (e) { return null }
    if (!meta || meta.id !== jobId) return null
    let status = meta.status === 'done' ? 'done' : 'running'
    let exitCode = meta.exitCode
    if (status === 'running') {
      // job.json 尚未写终态：补查 exitcode.txt（bat 最后写入物，出现即任务已结束）。
      try {
        const ec = parseExitCode(await fsp.readFile(meta.exitcodePath || path.join(jobDir, 'exitcode.txt'), 'utf8'))
        if (ec !== null) { status = 'done'; exitCode = ec }
      } catch (e) { /* 尚未结束 */ }
    }
    let tail = ''
    try {
      const text = await fsp.readFile(meta.logPath || path.join(jobDir, 'stdout.log'), 'utf8')
      tail = text.slice(-4000)
    } catch (e) { /* 日志尚未创建 */ }
    return {
      id: jobId, name: meta.name, status,
      exitCode: exitCode === undefined || exitCode === null ? null : exitCode,
      logPath: meta.logPath, tail,
      sandbox: meta.sandbox || 'off',
      finishedAt: meta.finishedAt === undefined || meta.finishedAt === null ? null : meta.finishedAt,
      createdAt: meta.createdAt === undefined || meta.createdAt === null ? null : Number(meta.createdAt),
      notified: meta.notifiedAt !== undefined && meta.notifiedAt !== null,
      notifiedAt: meta.notifiedAt === undefined || meta.notifiedAt === null ? null : Number(meta.notifiedAt),
      notifiedBy: meta.notifiedAt === undefined || meta.notifiedAt === null ? null : (meta.notifiedBy || 'notify'),
    }
  }

  // /bgjobs/log 用：按需从磁盘读任务日志尾部（client 展开 done 任务且快照无输出时调用）。
  // 只读、不写内存快照。返回：undefined = 任务不存在；'' = 日志缺失/为空；字符串 = 日志尾部。
  const readJobLogTail = async (jobId, capChars) => {
    const reg = registry.get(String(jobId))
    let logPath = reg && reg.meta && reg.meta.logPath ? reg.meta.logPath : ''
    if (!logPath) {
      const jobDir = await locateJobDir(jobId)
      if (!jobDir) return undefined
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
        if (!meta || meta.id !== jobId) return undefined
        logPath = meta.logPath || path.join(jobDir, 'stdout.log')
      } catch (e) { return undefined }
    }
    try {
      const text = await fsp.readFile(logPath, 'utf8')
      return text.slice(-capChars)
    } catch (e) { return '' }
  }

  return {
    api: {
      markDelivered, markDeliveredId, deliveredOf,
      indexUpsert, indexRemove,
      view, locateJobDir, statusFromDisk, readJobLogTail,
    },
    dispose: [],
  }
}
