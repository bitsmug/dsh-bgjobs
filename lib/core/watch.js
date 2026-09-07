// bgjobs core —— 完成检测/恢复域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// 事件驱动（fs.watch）+ 兜底轮询（tick）双通道；跨域调用经 deps 注入的 api 解析。

import { promises as fsp, watch } from 'node:fs'
import path from 'node:path'
import { parseExitCode, strip, TAIL_CAP } from '../util.js'
import { shouldNotifyForExit } from '../notify-policy.js'
import { SCHTASKS, runSchtasks } from '../runners.js'
import { readBgjobsIndex } from '../index-store.js'

export function createWatch(ctx, store, deps) {
  const registry = store.registry
  const { deliverCompletionNotice } = deps.notify
  const { markDelivered, indexUpsert } = deps.registry

  // 完成通知从"注入会话 user 消息"改为"client 半 UI toast"（v0.1.8）；
  // v0.1.31 起 notify 参数 opt-in 恢复 host 侧会话内通知（上方 deliverCompletionNotice），
  // 缺省仍 toast-only。client 轮询 /bgjobs/state 检测新 done 任务弹 toast（幂等）。

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
        // 事件回调整体 try/catch/finally 防护：任何一步异常都不能抛回 libuv
        //（Windows 上监听目录被删除等场景 libuv 可能触发原生断言/事件回调异常）。
        try {
          // 只对 exitcode.txt 触发完成检查；日志追加不检查（日志走 tick 增量读）。
          // filename 可能为 null（部分平台），此时退化为照常检查。
          if (filename !== null && filename !== 'exitcode.txt') return
          if (job.checkTimer) return
          job.checkTimer = setTimeout(() => {
            try {
              job.checkTimer = undefined
              checkCompletion(job).catch(() => {})
            } catch { job.checkTimer = undefined }
          }, 200)
        } catch { /* 事件处理失败：靠 tick 兜底 */ }
      })
      watcher.on('error', () => { try { closeWatch(job) } catch { /* noop */ } })
      job.watch = watcher
    } catch (e) {
      // watch 不可用：靠 tick 兜底（绝不抛给调用方）。
    }
  }
  const closeWatch = (job) => {
    try {
      if (job.checkTimer) { clearTimeout(job.checkTimer); job.checkTimer = undefined }
    } finally {
      if (job.watch) {
        try { job.watch.close() } catch { /* 已关闭 */ }
        job.watch = undefined
      }
    }
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
      // 终态落盘 + 可选通知创建者（v0.1.31；v0.1.60 改为「投递成功才置 delivered」）：
      // 先写 done（不含 notifiedAt，尽早落盘防重启窗口）→ notify 命中则投递，成功才
      // markDelivered('notify') 二次落盘。送达失败（无 agents/会话已关）不重试、
      // 不置标记（该任务保持 pending，可由后续 wait 交付），client toast 兜底。
      const finalMeta = Object.assign({}, job.meta, { status: 'done', exitCode, finishedAt: job.finishedAt })
      try {
        await fsp.writeFile(job.meta.jsonPath, JSON.stringify(finalMeta), 'utf8')
      } catch (e) { /* 尽力而为 */ }
      if (shouldNotifyForExit(job.meta.notify, exitCode)) {
        try {
          if (deliverCompletionNotice(job)) await markDelivered(job, 'notify')
        } catch (e) { /* 通知尽力而为（toast 兜底） */ }
      }
      // 兜底删除任务计划：bat 正常跑完已自删，这里防 bat 中途退出残留。
      // 只读到 exitcode.txt（bat 最后写入物）才删，不会误删 running 任务。
      // 沙箱任务：runner 已退出并自删其私有 temp，这里清掉提交时创建的临时根。
      if (job.meta.sandboxTempPath) fsp.rm(job.meta.sandboxTempPath, { recursive: true, force: true }).catch(() => {})
      runSchtasks([SCHTASKS, '/Delete', '/TN', job.meta.taskName, '/F'], job.meta.workdir).catch(() => {})
    } catch (e) { /* 尚未结束 */ }
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
        }
      }
    } finally {
      ticking = false
    }
  }
  const disposeTick = ctx.interval(() => tick().catch(() => {}), 1000)

  // 启动恢复：中央索引优先（全局地图），工作区扫描兜底。任务 workdir 不必等于当前会话
  // 工作目录——跨工作区/跨会话都能恢复（running 继续跟踪；done 直接显示终态，不重复通知）。
  // recover 不依赖 workspaceRegistry 即可成功；冷启动每个 tick 重试直到成功。
  let recovered = false
  /** 把磁盘 meta 挂进注册表（done 显示终态；running 继续 startWatch）。返回 job，无效/重复返回 null。 */
  const rehangJob = (meta) => {
    if (!meta || !meta.id || !meta.logPath || registry.has(meta.id)) return null
    const job = {
      id: meta.id, meta,
      status: meta.status === 'done' ? 'done' : 'running',
      exitCode: meta.exitCode, pos: 0, tail: '',
      finishedAt: meta.finishedAt,
      logChecked: false, // done 空 tail 是否已从日志文件补读（tick 幂等标记）
      decoder: new TextDecoder(), watch: undefined, checkTimer: undefined, lastCompletionCheck: 0,
    }
    registry.set(meta.id, job)
    if (meta.status !== 'done') startWatch(job)
    return job
  }
  const recover = async () => {
    // ① 中央索引（全局）：所有 workdir 的任务都能恢复
    const index = await readBgjobsIndex()
    for (const entry of index.jobs) {
      if (!entry || !entry.id || !entry.jobDir) continue
      try {
        // done 任务在运行期不再有 tick 读日志，重挂时从磁盘一次性回填 tail，
        // 否则面板对已结束任务永远显示「等待输出」（内存 tail 只在 running 时增长）。
        const job = rehangJob(JSON.parse(await fsp.readFile(path.join(entry.jobDir, 'job.json'), 'utf8')))
        if (job && job.status === 'done') await readLog(job)
      } catch (e) { /* job.json 缺失/损坏：跳过 */ }
    }
    // ② 工作区扫描兜底：索引缺失/未收录的磁盘任务（老数据）补挂并入索引
    const wsReg = ctx.get('workspaceRegistry')
    if (wsReg !== undefined) {
      let workspaces = []
      try { workspaces = wsReg.list() } catch (e) { workspaces = [] }
      for (const ws of workspaces) {
        const root = ws && ws.path ? strip(String(ws.path)) : ''
        if (!root) continue
        const jobsDir = root + '\\.dsh\\bgjobs'
        let names = []
        try { names = await fsp.readdir(jobsDir) } catch (e) { continue }
        for (const n of names) {
          try {
            const meta = JSON.parse(await fsp.readFile(jobsDir + '\\' + n + '\\job.json', 'utf8'))
            if (!meta || !meta.id || registry.has(meta.id)) continue
            const job = rehangJob(meta)
            if (job) {
              if (job.status === 'done') {
                await readLog(job)
                job.logChecked = true // 已补读，tick 不再重复尝试
              }
              indexUpsert(job)
            }
          } catch (e) { /* 非任务目录 */ }
        }
      }
    }
    return true
  }

  return {
    api: { startWatch, closeWatch, checkCompletion, tick },
    dispose: [disposeTick],
  }
}
