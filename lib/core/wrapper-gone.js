// bgjobs core —— 「running 但没写成 exitcode.txt」的收尾判定**唯一所有者**（v0.2.3）。
//
// 症状（用户报「死任务显示运行中」）：`exitcode.txt` 是包装器收尾时写的最后一件东西，
// 只要它**没写成**（GUI 子系统程序静默退出 / 包装器被非正常终止 / **重启或注销——计划任务是
// "仅用户登录时运行"，一重启全军覆没且都不留退出口**），任务就永远停在 `running` —— 面板显示
// 「运行中」而实际**没有任何进程**。现场实测（2026-10-09）三条存量僵尸记录的形态一致：
// `run.pid` 里的 pid 已不存在 + `exitcode.txt` 不存在 + 日志停更 ⇒ 记录永久 running。
//
// 修前有**两个所有者**各自从 `exitcode.txt` 反推终态，且都不看进程是否还在：
//   - 磁盘路径 `lib/core/registry.js` 的 `statusFromDisk`（bgjob_status / bgjob_wait 的磁盘回退）
//   - 内存路径 `lib/core/watch.js` 的 `checkCompletion`（fs.watch + 5s 兜底 tick）
// ⇒ 本模块是**唯一**那条判定入口，两条路径都调它；绝不在两个文件里各打一个补丁
//   （否则又是一份"状态权威"的重复实现，下次只会再漂一次）。
// ⇒ 判定发生在**读取时**（不是只对"今后新死掉的"生效）⇒ **存量僵尸记录一查即被追认**，
//   不需要任何迁移脚本、也不需要人工 kill。
//
// 判定（先便宜后昂贵，fail-safe 优先：只认"**确证**包装器已消失"）：
//   ① 没有 pid 文件（run.pid / mcp-server.pid）⇒ **保持 running**（少一个确证就不改状态）；
//   ② 廉价存活预检（进程内 syscall，**零 spawn**）：
//        gone  ⇒ **终态**（reason `pid-gone`）：pid 都不存在了，包装器必然已消失；
//        unknown ⇒ 保持 running（说不清就不动状态）；
//        alive ⇒ 走 ③ 的归属复核；
//   ③ 归属复核（既有探针 `probeProcess`，**节流**到每个任务目录每 OWNERSHIP_PROBE_INTERVAL_MS 一次）：
//        对 `run.pid`（它一定是 run.ps1，命令行必然含 jobDir/taskName —— 与 kill 路径同口径）：
//          活着但**不属于本任务** ⇒ **终态**（reason `pid-reused`）：这个 pid 已被系统复用给无关
//          进程 ⇒ 本任务包装器确实不存在了（**防"pid 被复用导致误判存活"**）；
//          活着且属于本任务 ⇒ 保持 running（**真的还在跑，绝不误判为死**）；
//          说不清（unknown）⇒ 保持 running。
//        `mcp-server.pid` 不适用归属核验（其命令行天然不含 jobDir，同 kill-tree 的既有裁定）⇒ 保持 running。
//   ④ 没有退出码就如实保留这个事实：`exitCode: null` + `exitCodeSource:'wrapper-gone'`
//      + `wrapperGoneReason`（为何这样判），**绝不编一个码出来**。
//
// ★ 为什么先做廉价预检：tick **每 5s** 会对每个 running 任务调一次 checkCompletion，磁盘回退
//   路径还会被 `bgjob_wait` 的轮询反复调。进程内 syscall 让最常见的那条路径（pid 都没了，
//   == 现场实测的僵尸形态）**零 spawn 立即判终态**；只有"pid 上还真有进程"时才起探针，
//   而且探针本身也按任务目录节流 ⇒ 正常在跑的任务不会被反复探测。

import path from 'node:path'
import { readJobPid, probeProcess } from '../kill-tree.js'

/** 终态来源标记：包装器已消失、且**没有**退出码（与 'killed' 并列的第二种"非自身退出码"来源）。 */
export const WRAPPER_GONE_SOURCE = 'wrapper-gone'
/** 为何判定包装器已消失：pid 不存在 / pid 已被系统复用给无关进程。 */
export const WRAPPER_REASON_PID_GONE = 'pid-gone'
export const WRAPPER_REASON_PID_REUSED = 'pid-reused'
/**
 * 归属复核（昂贵：起一次 PowerShell + CIM 查询）的最小间隔，按任务目录计。
 * 只有"pid 上确实有进程"才会走到它 ⇒ 这个节流只限制"正常在跑的任务"被重复探测的频率，
 * 不影响"pid 已消失"的即时判死（那条走零 spawn 的廉价预检）。
 */
export const OWNERSHIP_PROBE_INTERVAL_MS = 5 * 60 * 1000
/** 节流表剪枝阈值（每个任务目录一条；超过就把过期的清掉，表不无界增长）。 */
const THROTTLE_PRUNE_AT = 512

/**
 * 廉价存活预检（进程内，**零 spawn**）：`'gone' | 'alive' | 'unknown'`。
 * 只判"这个 pid 上有没有进程"，不做归属核验（归属核验是复核那一步的事）。
 * 测试经 `setPidProbe` 替换（与 runners.js 的 setSchtasksRunner 同款注入缝）。
 */
export function setPidProbe(fn) { pidProbe = typeof fn === 'function' ? fn : pidExistsImpl }
let pidProbe = pidExistsImpl

function pidExistsImpl(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  try {
    // signal 0 = 只做存在性检查，不发送任何信号（Windows 上走 OpenProcess）。
    process.kill(pid, 0)
    return 'alive'
  } catch (e) {
    // ESRCH = 没有这个进程（**唯一**可判死的结论）；EPERM 等一律"说不清"（fail-safe）。
    if (e !== null && e !== undefined && e.code === 'ESRCH') return 'gone'
    return 'unknown'
  }
}

/** 走当前预检实现（导出仅为测试/自测可断言，生产用不到）。 */
export function probePid(pid) { return pidProbe(pid) }

/** 归属复核节流表：任务目录 → 上次复核时刻。 */
const ownershipProbedAt = new Map()

/** 本次是否允许起归属复核探针（并记账）。测试经 setOwnershipProbeClock 固定时钟。 */
function takeOwnershipProbeSlot(jobDir, now) {
  const at = ownershipProbedAt.get(jobDir)
  if (at !== undefined && now - at < OWNERSHIP_PROBE_INTERVAL_MS) return false
  ownershipProbedAt.set(jobDir, now)
  if (ownershipProbedAt.size > THROTTLE_PRUNE_AT) {
    for (const [key, value] of ownershipProbedAt) {
      if (now - value >= OWNERSHIP_PROBE_INTERVAL_MS) ownershipProbedAt.delete(key)
    }
  }
  return true
}

/** 测试注入缝：固定"现在"（缺省 Date.now），避免用例依赖真实墙钟推进。 */
export function setOwnershipProbeClock(fn) { clock = typeof fn === 'function' ? fn : Date.now }
let clock = Date.now

/** 清空节流表（测试隔离用；生产不需要）。 */
export function resetOwnershipProbeThrottle() { ownershipProbedAt.clear() }

/**
 * **唯一**收尾判定入口：running 且 `exitcode.txt` 缺失/不可解析时，判包装器是否已消失。
 * 调用方只在"退出码读不到"时调它（读得到时一律以退出码为准，**不经过这里**）。
 *
 * @param meta - job.json 内容（需 jobDir/或 jsonPath、workdir、taskName、id）。
 * @returns `null`（保持 running）或终态补丁
 *   `{ exitCode: null, exitCodeSource: 'wrapper-gone', wrapperGoneReason, wrapperGoneAt, wrapperGonePid, wrapperGoneFile }`。
 *   只读：绝不杀进程、绝不改状态（要不要落盘由调用方决定）。
 */
export async function resolveWrapperGone(meta) {
  if (!meta || typeof meta !== 'object') return null
  const jobDir = meta.jobDir !== undefined && meta.jobDir !== null && String(meta.jobDir).length > 0
    ? String(meta.jobDir)
    : (meta.jsonPath !== undefined && meta.jsonPath !== null && String(meta.jsonPath).length > 0 ? path.dirname(String(meta.jsonPath)) : '')
  if (jobDir.length === 0) return null
  // ① 没有 pid 文件（老任务 / 无 pid 的情形）⇒ 没有可用的确证，保持 running。
  const found = await readJobPid(jobDir).catch(() => null)
  if (found === null) return null
  const patch = (reason) => ({
    exitCode: null,
    exitCodeSource: WRAPPER_GONE_SOURCE,
    wrapperGoneReason: reason,
    wrapperGoneAt: Date.now(),
    wrapperGonePid: found.pid,
    wrapperGoneFile: found.file,
  })
  // ② 廉价预检（零 spawn）：pid 都不存在 ⇒ 立即终态（现场实测的僵尸就是这个形态）。
  const quick = pidProbe(found.pid)
  if (quick === 'gone') return patch(WRAPPER_REASON_PID_GONE)
  if (quick !== 'alive') return null
  // ③ pid 上确实有进程：起一次归属复核（节流），只认"确证不是本任务的包装器"这个结论。
  //    探针失败（unknown）或复核说还活着 ⇒ 保持 running（宁可漏判，绝不误判）。
  if (!takeOwnershipProbeSlot(jobDir, clock())) return null
  const needles = [jobDir, meta.taskName, meta.id].filter((needle) => typeof needle === 'string' && needle.length > 0)
  const probe = await probeProcess(found.pid, needles, meta.workdir).catch(() => ({ state: 'unknown' }))
  if (probe.state !== 'alive') return null
  // run.pid 记的一定是 run.ps1（命令行必然含 jobDir/taskName）；不含 ⇒ 该 pid 已被系统复用给
  // 无关进程 ⇒ 本任务包装器已消失（与 kill-tree 的归属硬门禁同口径）。mcp-server.pid 不适用。
  if (found.file === 'run.pid' && probe.owned !== true) return patch(WRAPPER_REASON_PID_REUSED)
  return null
}

/**
 * 终态来源的**呈现**投影：`view()` / `statusFromDisk` / `bgjob_status` 共用这一份，
 * 避免"同一状态在三处各写一遍字段名"。不是该来源时返回 `{}`（调用方 spread 即可）。
 */
export function wrapperGoneOf(meta) {
  const m = meta || {}
  if (m.exitCodeSource !== WRAPPER_GONE_SOURCE) return {}
  return {
    exitCodeSource: WRAPPER_GONE_SOURCE,
    wrapperGone: true,
    wrapperGoneReason: m.wrapperGoneReason === undefined || m.wrapperGoneReason === null ? null : String(m.wrapperGoneReason),
    wrapperGoneAt: m.wrapperGoneAt === undefined || m.wrapperGoneAt === null ? null : Number(m.wrapperGoneAt),
    wrapperGonePid: m.wrapperGonePid === undefined || m.wrapperGonePid === null ? null : Number(m.wrapperGonePid),
    wrapperGoneFile: m.wrapperGoneFile === undefined || m.wrapperGoneFile === null ? null : String(m.wrapperGoneFile),
  }
}
