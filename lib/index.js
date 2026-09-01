// bgjobs — DSH 持久插件（host 半）
// schtasks 托管的后台任务：提交工具、日志监视、退出通知、网页状态路由。
//
// 机制（2026-09-01 实测；v0.1.8 修复三个实测 bug）：
//   - 任务由 Windows 任务计划程序服务托管，与 DSH 进程/终端无关；
//   - 插件在 DSH 进程内直接 spawn schtasks（不经过 pwsh 沙箱，免提权审批）；
//   - 用户命令原样写入子 bat（cmd.bat），run.bat 用 `call cmd.bat >> log 2>&1`
//     整体重定向。不能逐行追加重定向：会把 `for ... do (`、`)` 等块行破坏成
//     cmd 语法错误（实测 exit=255 秒死、不写 exitcode → 任务永远 running + 任务
//     计划残留）；bat 开头 chcp 65001 使日志以 UTF-8 写入（cmd 默认 GBK 会乱码）；
//     末尾写 exitcode 并自删任务；
//   - /Create /ST=now+60s 后立即 /Run 会双跑（/Run 立即一次 + /ST 整分再触发一次，
//     实测 17:54:30 与 17:55:00 两次日志），故 /Run 成功后立即 /Delete 任务计划，
//     bat 末尾与 done 兜底的 /Delete 变成无害 no-op；
//   - 日志尾部：每秒按字节位置增量读（TextDecoder 流式解码，避免截断多字节
//     UTF-8）；任务完成检测事件驱动：fs.watch 监视任务目录，exitcode.txt
//     出现即触发 → 状态迁移 done → agents.followup 通知创建任务的 agent 会话，
//     tick 每 5s 兜底补查防 watch 丢事件；done 后 DSH 侧再 fire-and-forget
//     一次 schtasks /Delete 兜底（bat 正常已自删，防中途退出残留任务计划）；
//   - webServer 前缀路由 /bgjobs/* 供客户端面板轮询；
//   - done 任务在内存注册表保留 24h 后剪枝（job.json 已落盘终态，剪枝不丢历史）。
//
// cmd 陷阱备忘：`echo %var%>file` 当 var 为数字时被解析成句柄重定向
// （0 字节文件、输出丢失），必须写成 `> file echo %var%`。

import { promises as fsp, watch } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

export const name = 'bgjobs'
export const inject = ['tools', 'timer', 'systemPrompt']

const TAIL_CAP = 100 * 1024
const DONE_RETENTION_MS = 24 * 60 * 60 * 1000
const SPAWN_TIMEOUT_MS = 30000
const SCHTASKS = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\schtasks.exe'

// ── 中央任务索引（离线管理工具 dsh-bgjobs.ps1 的定位锚点）──────────────
// 索引只存 jobDir 当"地图"，不存状态：状态永远实时读 <jobDir>/job.json。
// 因此 DSH 离线期间任务完成、或索引过期，都不影响正确性。
// 路径：$DSH_HOME/bgjobs/index.json（DSH_HOME 与 harness resolveDshHome 同规则）。
const INDEX_VERSION = 1

/** 解析 DSH home；与 harness `resolveDshHome()` 同规则（env 优先，默认 ~/.dsh）。 */
export function resolveBgjobsHome() {
  const fromEnv = process.env.DSH_HOME
  const home = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : path.join(os.homedir(), '.dsh')
  return path.resolve(home)
}

/** 中央索引文件路径。 */
export function bgjobsIndexPath(home = resolveBgjobsHome()) {
  return path.join(home, 'bgjobs', 'index.json')
}

/** 读取索引；缺失/损坏返回空索引（损坏不抛错，引导 index rebuild）。 */
export async function readBgjobsIndex(home = resolveBgjobsHome()) {
  try {
    const raw = await fsp.readFile(bgjobsIndexPath(home), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.jobs)) return { version: INDEX_VERSION, updatedAt: 0, jobs: [] }
    return { version: INDEX_VERSION, updatedAt: Number(parsed.updatedAt) || 0, jobs: parsed.jobs }
  } catch (e) {
    return { version: INDEX_VERSION, updatedAt: 0, jobs: [] }
  }
}

/** 整体覆写索引；写失败静默（索引是地图，不影响插件主流程）。 */
export async function writeBgjobsIndex(index, home = resolveBgjobsHome()) {
  try {
    const dir = path.dirname(bgjobsIndexPath(home))
    await fsp.mkdir(dir, { recursive: true })
    const payload = { version: INDEX_VERSION, updatedAt: Date.now(), jobs: index.jobs }
    await fsp.writeFile(bgjobsIndexPath(home), JSON.stringify(payload, null, 2), 'utf8')
  } catch (e) { /* 静默 */ }
}

/** 索引写串行化队列：多个 fire-and-forget 更新并发时避免读-改-写互相覆盖。 */
let indexWriteChain = Promise.resolve()

/** 读-改-写：mutator 接收并修改 jobs 数组，随后整体覆写。串行执行。 */
export function updateBgjobsIndex(mutator, home = resolveBgjobsHome()) {
  const task = indexWriteChain.then(async () => {
    const index = await readBgjobsIndex(home)
    mutator(index.jobs)
    await writeBgjobsIndex(index, home)
  })
  indexWriteChain = task.catch(() => {})
  return task
}

/**
 * 从磁盘扫描已知 job 目录重建索引：给定工作区根目录列表，找到每个
 * `.dsh/bgjobs/<id>/job.json`（避开 `*` 注释终止符）。
 */
export async function rebuildBgjobsIndex(workdirs, home = resolveBgjobsHome()) {
  const jobs = []
  for (const raw of workdirs) {
    const workdir = strip(String(raw))
    if (!workdir) continue
    const jobsDir = path.join(workdir, '.dsh', 'bgjobs')
    let names = []
    try { names = await fsp.readdir(jobsDir) } catch (e) { continue }
    for (const n of names) {
      try {
        const jsonPath = path.join(jobsDir, n, 'job.json')
        const meta = JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
        if (!meta || !meta.id || !meta.logPath) continue
        jobs.push({
          id: meta.id,
          jobDir: meta.jobDir || path.dirname(jsonPath),
          workdir,
          name: String(meta.name || meta.id),
          createdBySession: String(meta.createdBySession || ''),
          createdAt: Number(meta.createdAt) || 0,
        })
      } catch (e) { /* 非任务目录 */ }
    }
  }
  jobs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  const index = { version: INDEX_VERSION, updatedAt: Date.now(), jobs }
  await writeBgjobsIndex(index, home)
  return index
}


/** 去掉路径尾部反斜杠；盘符根路径（C:\）保留尾部 `\`。 */
export function strip(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  return /^[a-zA-Z]:$/.test(s) ? s + '\\' : s
}

/** 取错误信息，避免 `[object Object]`。 */
export function errorMsg(e) {
  return (e && e.message) || String(e)
}

/** 从 exitcode.txt 文本解析退出码；无数字返回 null。 */
export function parseExitCode(text) {
  const m = /(-?\d+)/.exec(String(text))
  return m ? Number(m[1]) : null
}

/**
 * 生成任务 bat（run.bat）：用 `call cmd.bat >> log 2>&1` 整体重定向用户命令，
 * 避免逐行重定向破坏 for/if 等块结构；bat 开头 chcp 65001 保证日志 UTF-8；
 * 末尾写 exitcode 并自删任务计划。
 */
export function buildBat(job) {
  const cmdPath = job.meta.cmdPath || path.join(path.dirname(job.meta.jsonPath), 'cmd.bat')
  const lines = [
    '@echo off',
    '>nul chcp 65001',
    'cd /d "' + job.meta.workdir + '"',
    'call "' + cmdPath + '" >> "' + job.meta.logPath + '" 2>&1',
    'set "bgrc=%errorlevel%"',
    '>> "' + job.meta.logPath + '" echo [BGJOB] exit code: %bgrc%',
    '> "' + job.meta.exitcodePath + '" echo %bgrc%',
    'schtasks /Delete /TN ' + job.meta.taskName + ' /F >nul 2>&1',
  ]
  return lines.join('\r\n') + '\r\n'
}

/** 生成用户命令子 bat（cmd.bat）：命令原样保留（含空行/缩进），保证块结构正常解析。 */
export function buildCmdBat(job) {
  return String(job.meta.command).split(/\r?\n/).join('\r\n') + '\r\n'
}

/**
 * 模型可见的后台任务使用指引（system prompt guidance）。
 * 镜像 dsh-ai4scholar 的 buildGuidance：纯文本构建，注明工具族、何时用、注意事项。
 */
export function buildBgjobsGuidance() {
  return [
    '可用的后台任务工具：',
    '- bgjob_submit: 把命令提交为独立于 DSH 进程的后台任务（Windows 任务计划程序托管，关 DSH/关终端不影响）。适用于长任务：下载/同步/编译/仿真/批量脚本等。command 为 bat 语法（多行逐行执行；for 循环变量写 %%i）；命令含 exit/goto 会提前终止 bat 导致 exitcode 不写入；workdir 必须是工作区内绝对路径。',
    '- bgjob_status: 查询后台任务状态（running/done）、退出码、日志尾部。',
    '长任务交给 bgjob_submit 而不是前台执行；任务完成时网页顶部弹出 Toast 提示（不注入会话消息）。',
  ].join('\n')
}

/** 执行一次 schtasks 调用；测试通过 setSchtasksRunner 替换。 */
export function setSchtasksRunner(fn) { runner = fn }
let runner = (argv, cwd) => spawnRun(argv, cwd)

function spawnRun(argv, cwd) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true })
    } catch (e) {
      resolve({ exitCode: null, stdout: '', stderr: 'spawn failed: ' + errorMsg(e) })
      return
    }
    let out = ''
    let err = ''
    let timedOut = false
    const cap = (s) => (s.length > 65536 ? s.slice(-65536) : s)
    const done = (result) => { clearTimeout(timer); resolve(result) }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* 已退出 */ }
    }, SPAWN_TIMEOUT_MS)
    child.stdout.on('data', (c) => { out = cap(out + c.toString('utf8')) })
    child.stderr.on('data', (c) => { err = cap(err + c.toString('utf8')) })
    child.on('error', (e) => done({ exitCode: null, stdout: out, stderr: 'spawn error: ' + errorMsg(e) }))
    child.on('close', (code) => done({
      exitCode: code,
      stdout: out,
      stderr: timedOut ? `timed out after ${SPAWN_TIMEOUT_MS}ms: ` + err : err,
    }))
  })
}

export function apply(ctx) {
  const registry = new Map()

  // 完成通知从"注入会话 user 消息"改为"client 半 UI toast"（v0.1.8）：
  // host 侧不再调 agent.followup，避免污染会话流；client 轮询 /bgjobs/state
  // 检测到新 done 任务后自行弹 toast（幂等）。job.json 仍是终态事实源。

  // 增量读日志：按字节位置只读新增部分，TextDecoder 流式模式在块边界暂存
  // 不完整的多字节序列，避免把截断字符解码成乱码。
  const readLog = async (job) => {
    let handle
    try {
      handle = await fsp.open(job.meta.logPath, 'r')
      const { size } = await handle.stat()
      if (size < job.pos) {
        // 日志被截断/重建：回到文件头并清空尾部展示。
        job.pos = 0
        job.tail = ''
      }
      const delta = size - job.pos
      if (delta <= 0) return
      const buffer = Buffer.alloc(delta)
      const { bytesRead } = await handle.read(buffer, 0, delta, job.pos)
      job.pos += bytesRead
      if (bytesRead <= 0) return
      const text = job.decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
      if (text.length > 0) job.tail = (job.tail + text).slice(-TAIL_CAP)
    } catch (e) { /* 日志尚未创建 */ }
    finally {
      if (handle) await handle.close().catch(() => {})
    }
  }

  // 完成检测（事件驱动 + 兜底轮询双通道）：
  //   - 主通道：fs.watch 监视 job 目录，exitcode.txt 出现/追加时触发（合并突发，
  //     200ms 节流），完成延迟从秒级降到亚秒级；
  //   - 兜底通道：tick 每 COMPLETION_FALLBACK_MS 补查一次，防 Windows watch
  //     丢事件/目录事件被合并。
  const COMPLETION_FALLBACK_MS = 5000
  const startWatch = (job) => {
    if (job.watch) return
    try {
      // 老格式 job.json 可能没有 jobDir 字段：由 jsonPath 推导任务目录。
      const jobDir = job.meta.jobDir || path.dirname(job.meta.jsonPath)
      const watcher = watch(jobDir, { persistent: false }, (_event, filename) => {
        // 只对 exitcode.txt 触发完成检查；日志追加不检查（日志走 tick 增量读）。
        // filename 可能为 null（部分平台），此时退化为照常检查。
        if (filename !== null && filename !== 'exitcode.txt') return
        if (job.checkTimer) return
        job.checkTimer = setTimeout(() => {
          job.checkTimer = undefined
          checkCompletion(job).catch(() => {})
        }, 200)
      })
      watcher.on('error', () => { closeWatch(job) })
      job.watch = watcher
    } catch (e) { /* watch 不可用：靠 tick 兜底 */ }
  }
  const closeWatch = (job) => {
    if (job.checkTimer) { clearTimeout(job.checkTimer); job.checkTimer = undefined }
    if (job.watch) { try { job.watch.close() } catch { /* 已关闭 */ } ; job.watch = undefined }
  }
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
  const checkCompletion = async (job) => {
    job.lastCompletionCheck = Date.now()
    if (job.status !== 'running') return
    // 完成前最后补读一次日志：exitcode.txt 由 bat 在日志 marker 之后写入，
    // 此时日志已完整，补读可捕获最后一次 tick 之后写入的行（如 [BGJOB] marker）。
    await readLog(job)
    try {
      const ecText = await fsp.readFile(job.meta.exitcodePath, 'utf8')
      const exitCode = parseExitCode(ecText)
      if (exitCode === null) return
      job.status = 'done'
      job.exitCode = exitCode
      job.finishedAt = Date.now()
      // 刷掉流式解码器缓冲区里最后一段日志。
      job.tail = (job.tail + job.decoder.decode()).slice(-TAIL_CAP)
      closeWatch(job)
      try {
        await fsp.writeFile(job.meta.jsonPath, JSON.stringify(Object.assign({}, job.meta, { status: 'done', exitCode, finishedAt: job.finishedAt })), 'utf8')
      } catch (e) { /* 尽力而为 */ }
      // 完成通知由 client 半轮询弹 toast（v0.1.8），host 侧不再注入会话消息。
      // 兜底删除任务计划：bat 正常跑完已自删，这里防 bat 中途退出残留。
      // 只读到 exitcode.txt（bat 最后写入物）才删，不会误删 running 任务。
      runner([SCHTASKS, '/Delete', '/TN', job.meta.taskName, '/F'], job.meta.workdir).catch(() => {})
    } catch (e) { /* 尚未结束 */ }
  }

  const submitJob = async (jobName, command, workdirRaw, createdBySession) => {
    const workdir = strip(String(workdirRaw))
    const jobId = 'bg-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36)
    const taskName = 'dsh-bgj-' + jobId
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    const logPath = jobDir + '\\stdout.log'
    const exitcodePath = jobDir + '\\exitcode.txt'
    const jsonPath = jobDir + '\\job.json'
    const batPath = jobDir + '\\run.bat'
    const cmdPath = jobDir + '\\cmd.bat'
    const cleanupDir = () => fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    const deleteTask = () => runner([SCHTASKS, '/Delete', '/TN', taskName, '/F'], workdir)
    try {
      await fsp.mkdir(jobDir, { recursive: true })
    } catch (e) {
      return { ok: false, error: 'create job dir failed: ' + errorMsg(e) }
    }
    const meta = {
      id: jobId, name: String(jobName), workdir, taskName, jobDir,
      logPath, exitcodePath, jsonPath, cmdPath, command: String(command),
      createdBySession: String(createdBySession || ''), createdAt: Date.now(), status: 'running',
    }
    const job = { id: jobId, meta, status: 'running', exitCode: undefined, pos: 0, tail: '', decoder: new TextDecoder(), watch: undefined, checkTimer: undefined, lastCompletionCheck: 0 }
    try {
      await fsp.writeFile(cmdPath, buildCmdBat(job), 'utf8')
      await fsp.writeFile(batPath, buildBat(job), 'utf8')
      await fsp.writeFile(jsonPath, JSON.stringify(meta), 'utf8')
    } catch (e) {
      await cleanupDir()
      return { ok: false, error: 'write job files failed: ' + errorMsg(e) }
    }
    const d = new Date(Date.now() + 60000)
    const st = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
    const create = await runner([SCHTASKS, '/Create', '/TN', taskName, '/TR', '"' + batPath + '"', '/SC', 'ONCE', '/ST', st, '/F'], workdir)
    if (create.exitCode !== 0) {
      await cleanupDir()
      return { ok: false, error: 'schtasks create failed: ' + create.stderr + create.stdout }
    }
    const run = await runner([SCHTASKS, '/Run', '/TN', taskName], workdir)
    if (run.exitCode !== 0) {
      // /Create 已成功但 /Run 失败：先删任务计划，再删目录，防系统残留 dsh-bgj-* 任务。
      await deleteTask()
      await cleanupDir()
      return { ok: false, error: 'schtasks run failed: ' + run.stderr + run.stdout }
    }
    // /Run 已触发执行：立即删任务计划，防 /ST（now+60s）整分再触发导致任务双跑。
    // bat 末尾的自删与 done 兜底的 /Delete 此后均为无害 no-op；DSH 崩溃恢复靠
    // job.json 与中央索引，与任务计划是否存在无关。
    await deleteTask().catch(() => {})
    registry.set(jobId, job)
    startWatch(job)
    indexUpsert(job)
    return { ok: true, jobId, taskName, logPath }
  }

  let ticking = false
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      if (!recovered) recovered = await recover()
      const now = Date.now()
      for (const job of Array.from(registry.values())) {
        if (job.status === 'running') {
          await readLog(job)
          // 兜底完成检查：watch 丢失事件或不可用时，每 COMPLETION_FALLBACK_MS 补查。
          if (now - job.lastCompletionCheck >= COMPLETION_FALLBACK_MS) {
            await checkCompletion(job)
          }
        } else if (job.finishedAt !== undefined && now - job.finishedAt > DONE_RETENTION_MS) {
          closeWatch(job)
          registry.delete(job.id)
          indexRemove(job.id)
        }
      }
    } finally {
      ticking = false
    }
  }
  const disposeTick = ctx.interval(() => tick().catch(() => {}), 1000)

  // 启动恢复：扫描工作区的 .dsh/bgjobs/*/job.json，重新挂接上次 DSH 进程留下的任务
  // （running 的继续跟踪；done 的直接显示终态，不重复通知）。
  // 冷启动时 workspaceRegistry 可能尚未就绪：每个 tick 重试，直到成功。
  let recovered = false
  const recover = async () => {
    const wsReg = ctx.get('workspaceRegistry')
    if (wsReg === undefined) return false
    let workspaces = []
    try { workspaces = wsReg.list() } catch (e) { return false }
    for (const ws of workspaces) {
      const root = ws && ws.path ? strip(String(ws.path)) : ''
      if (!root) continue
      const jobsDir = root + '\\.dsh\\bgjobs'
      let names = []
      try { names = await fsp.readdir(jobsDir) } catch (e) { continue }
      for (const n of names) {
        try {
          const meta = JSON.parse(await fsp.readFile(jobsDir + '\\' + n + '\\job.json', 'utf8'))
          if (!meta || !meta.id || !meta.logPath || registry.has(meta.id)) continue
          registry.set(meta.id, {
            id: meta.id, meta,
            status: meta.status === 'done' ? 'done' : 'running',
            exitCode: meta.exitCode, pos: 0, tail: '',
            finishedAt: meta.finishedAt,
            decoder: new TextDecoder(), watch: undefined, checkTimer: undefined, lastCompletionCheck: 0,
          })
          if (meta.status !== 'done') startWatch(registry.get(meta.id))
          indexUpsert(registry.get(meta.id))
        } catch (e) { /* 非任务目录 */ }
      }
    }
    return true
  }

  const view = (job) => ({
    id: job.id, name: job.meta.name, status: job.status,
    exitCode: job.exitCode === undefined ? null : job.exitCode,
    logPath: job.meta.logPath, tail: job.tail, workdir: job.meta.workdir,
  })

  // 删除一个任务（网页端"删除/拖拽到垃圾篓"与"一键清理"共用）：
  // running 先 schtasks /End 再 /Delete；done 只 /Delete（bat 可能已自删，幂等）；
  // 随后删除 job 目录、从 registry 与中央索引移除。
  const removeJob = async (jobId) => {
    const job = registry.get(String(jobId))
    if (job === undefined) return { ok: false, error: 'job not found: ' + jobId }
    closeWatch(job)
    if (job.status === 'running') {
      await runner([SCHTASKS, '/End', '/TN', job.meta.taskName], job.meta.workdir).catch(() => {})
    }
    await runner([SCHTASKS, '/Delete', '/TN', job.meta.taskName, '/F'], job.meta.workdir).catch(() => {})
    await fsp.rm(job.meta.jobDir, { recursive: true, force: true }).catch(() => {})
    registry.delete(job.id)
    indexRemove(job.id)
    return { ok: true, removed: job.id }
  }

  // 一键清理：删除所有已完成（done）任务，包括异常退出（exitCode !== 0）。
  const cleanupDone = async () => {
    const removed = []
    for (const job of Array.from(registry.values())) {
      if (job.status !== 'done') continue
      const r = await removeJob(job.id)
      if (r.ok) removed.push(job.id)
    }
    return { ok: true, removed }
  }

  // 客户端面板轮询路由
  const disposeRoutes = ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      const url = new URL(String(req.url || '/'), 'http://localhost')
      const pathname = url.pathname
      const writeJson = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      if (pathname === '/bgjobs/state') {
        writeJson(200, { ok: true, jobs: Array.from(registry.values()).map(view) })
        return
      }
      if (pathname === '/bgjobs/delete') {
        const id = url.searchParams.get('id')
        if (!id) { writeJson(400, { ok: false, error: 'missing id' }); return }
        writeJson(200, await removeJob(id))
        return
      }
      if (pathname === '/bgjobs/cleanup') {
        writeJson(200, await cleanupDone())
        return
      }
      res.writeHead(404)
      res.end()
    }
    return webCtx.webServer.register({ kind: 'prefix', path: '/bgjobs', handler })
  })

  // ── 工具 ──
  const disposeSubmit = ctx.tools.register({
    name: 'bgjob_submit',
    description: '把命令提交为独立于 DSH 进程的后台任务：用户命令原样写入子 bat，经 schtasks 一次性任务交由任务计划程序服务托管（日志 UTF-8、末尾写 exitcode、自删任务计划），关 DSH/关终端不影响。网页「后台任务监控」面板实时显示输出，任务退出时自动通知创建它的 agent。command 支持多行与 for/if 块结构（bat 语法，循环变量用 %%i），原样写入子 bat 执行；workdir 必须是 DSH 工作区内的绝对路径（任务文件与日志写在 <workdir>/.dsh/bgjobs/<id>/ 下）。',
    presentCall: (args) => ({
      card: 'generic',
      title: '提交后台任务',
      kind: 'execute',
      rawInput: args && typeof args.name === 'string' ? args.name : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '任务名（显示在监控面板与完成通知里）' },
        command: { type: 'string', description: '要执行的命令（可多行；bat 语法，如 for 循环变量用 %%i；for/if 块结构原样保留）' },
        workdir: { type: 'string', description: '工作目录绝对路径（DSH 工作区内）' },
      },
      required: ['name', 'command', 'workdir'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          taskName: { type: 'string' },
          logPath: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const createdBySession = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
      return submitJob(args.name, args.command, args.workdir, createdBySession)
    },
  })

  const disposeStatus = ctx.tools.register({
    name: 'bgjob_status',
    description: '查询一个 bgjob_submit 提交的后台任务状态：running/done、exitCode、最近输出尾部与日志路径。',
    presentCall: (args) => ({
      card: 'generic',
      title: '查询后台任务',
      rawInput: args && typeof args.jobId === 'string' ? args.jobId : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string', description: '任务 id（bgjob_submit 返回的 jobId）' },
      },
      required: ['jobId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          exitCode: {},
          logPath: { type: 'string' },
          tail: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const job = registry.get(String(args.jobId))
      if (!job) return { error: 'job not found: ' + args.jobId }
      return {
        id: job.id, name: job.meta.name, status: job.status,
        exitCode: job.exitCode === undefined ? null : job.exitCode,
        logPath: job.meta.logPath, tail: job.tail.slice(-4000),
      }
    },
  })

  // 模型可见的使用指引（system prompt section；镜像 dsh-ai4scholar 的 guidance）。
  const disposeGuidance = ctx.systemPrompt.section({
    name: 'tool:bgjobs',
    order: 150,
    text: buildBgjobsGuidance(),
  })

  return () => {
    disposeTick()
    for (const job of registry.values()) closeWatch(job)
    for (const d of [disposeSubmit, disposeStatus]) { try { d() } catch (e) { /* noop */ } }
    if (typeof disposeRoutes === 'function') { try { disposeRoutes() } catch (e) { /* noop */ } }
    try { disposeGuidance() } catch (e) { /* noop */ }
  }
}
