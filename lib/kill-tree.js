// bgjobs —— 进程树终止（pid 文件 → 归属核验 → taskkill /PID /T /F → 轮询核验已消失）。
//
// 为什么需要它（B1）：`schtasks /End` 打印 SUCCESS 却**够不到任务根起的后代**。沙箱 pwsh 任务的
// 真实工作由三层组成——`pwsh.exe -File run.ps1`（schtasks 任务根）→ `node.exe sandbox-runner.js`
// → `pwsh.exe -File job.ps1`（用户命令）——`/End` 只结束注册的那个实例，三层全都照跑。
// 只有 **`taskkill /PID <run.ps1 的 pid> /T /F`** 能一次杀穿（与官方 @deepseek-ai/dsh-tool-jobs
// 的 `dsh-subprocess-local` 同口径：pid 级 taskkill + 轮询到整树退出）。
// 因此 run.ps1 启动第一件事就落盘自己的 `$PID`（lib/scripts.js 的 buildPwshRunner；
// 离线镜像见 tools/dsh-bgjobs-lib.ps1 的 New-BgjobsPwshRunner）⇒ `<jobDir>\run.pid`。
//
// 兼容与安全：
//   - 老任务没有 pid 文件 ⇒ **反查兜底**（见下）：按 jobDir/taskName 从 Win32_Process 里
//     反查出属于本任务的进程树再树杀（覆盖 bat 引擎与 0.1.94 之前的全部历史任务）；
//   - pid 复用防护：杀之前核验该 pid 的命令行**确实属于本任务**（含 jobDir/taskName），
//     不匹配就不杀并如实报错（run.pid 是硬门禁）；
//   - 探针不可用（拿不到 CIM 输出）⇒ 按"无法核验"处理：照杀（与既有 mcp 兜底同口径），
//     但返回值里 verified:false，绝不再谎报"已确认杀掉"。
//
// ★★ 语义边界（用户裁定，2026-10-07）——**kill 与 delete 彻底分开**：
//   - **kill**（本文件的 killJobProcessTree / detectJobProcesses 供 killJob 用）= **只终止进程**，
//     **不删任何记录**（job 目录 / 中央索引 / 注册表全部保留）；被终止的任务由 host 侧补写
//     `exitcode.txt = KILLED_EXIT_CODE(1：taskkill /F 在内核里记录的真值，见常量处注释)`
//     + job.json 的 `exitCodeSource:'killed'` ⇒ `bgjob_wait`/notify 都表现为**失败**，
//     绝不读成"成功完成"；
//   - **delete**（lib/core/web.js 的 removeJob）= **只删记录**，且**只在没有活进程时**允许
//     （delete 之前先用 detectJobProcesses 确认；有活进程 ⇒ 拒绝并提示先 kill）；
//   - **"未发现活进程"不是 delete**：无论 status 记的是 running 还是 done，只要反查/探针确认
//     没有本任务的活进程，就不是失败、也没什么可杀 ⇒ kill 如实回"未发现活进程"、**什么都不删**；
//     要清记录是**调用方**去调 delete（kill 内部不替它转 delete，两个动作各自纯粹）。
//
// 反查兜底（缺口 B）：
//   bat 引擎的任务根是 `wscript.exe launch.vbs`，**没有** run.pid；`schtasks /End` 只杀得掉
//   wscript，后代 cmd.exe / PING.EXE / conhost 照跑 ⇒ job 目录被占住 ⇒ EBUSY + 半删。
//   仅按"命令行含 jobDir/taskName"筛出任务根还不够：`PING.EXE -n 60 127.0.0.1` 这类孙进程的
//   命令行里**不含** jobDir。因此必须再按 ParentProcessId 递归展开后代，才等于原 pid 路径的
//   `/T` 语义（否则只杀 cmd、ping 变孤儿继续跑）。
//   ★ 实测澄清（2026-10-07，别再走弯路）：后代"命令行不含 jobDir"**不会**导致漏杀 ——
//   反查脚本按父链展开后它们以 matched=0 进击杀集，逐个 `taskkill /PID <pid> /T /F`，
//   外加对最外层根的 `/T`。当时现场像是"后代没被纳入"，**真因是回报口径**：killedPids
//   只回 matched 根（后代杀了不入账）。现口径：killedPids = 实际下过 taskkill 的每个 pid
//   （根 + 后代，按击杀顺序），matched = 只含命令行直接命中的根；整棵子树都核验。
//   ★★ 实机复验又抓到两个只有真跑才会现形的回归（2026-10-07，已修，勿改回）：
//     ① **查询进程自命中**：反查脚本正文里就含 needle（`$bgCmdline.Contains('<jobDir>')`），
//        于是"正在跑查询的 powershell"必然命中自己、连它的 conhost 也按后代被卷进击杀集
//        （实机 matched 里混进查询进程本身）。⇒ 脚本先算 `$bgSelfPids`（$PID + 其后代）整段跳过，
//        并再排除命令行带本插件 marker（BGJOBS-PROC / BGJOBS-PID）的巡检进程。
//     ② **"非零 ≠ 失败"**：最外层根的 `/T` 已经把 matched 子根一起带走后再对子根 taskkill，
//        返回 128（找不到进程）——那是"已经死了"。⇒ 判定一律以核验（survivors）为准，
//        非零输出只当 stderr 证据回传（原先按"根失败"判 ok:false，实测把成功的删除报成失败）。
//   安全约束（务必守住）：needle 只允许**本任务唯一且随机**的 jobDir / taskName / jobId；
//   绝不按通用模式（如"所有 pwsh.exe"）杀；筛不到就**不杀**并如实报 unknown。
//   杀之前把击杀集（pid + 命令行片段）打进 console.warn **与**返回值，供事后追溯。
//
// 测试注入缝：一切外部命令都走 runners.js 的 runSchtasks（测试用 setSchtasksRunner 替换），
// 所以单测不会真的杀进程。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { runSchtasks } from './runners.js'

/** 落盘 pid 文件名，按优先级：run.ps1 进程（= schtasks 任务根）→ mcp stdio server。 */
export const PID_FILE_NAMES = ['run.pid', 'mcp-server.pid']

/** 树杀后的核验预算：最多等这么久确认 pid 真的消失（官方参照用 15ms 轮询，同思路）。 */
export const KILL_VERIFY_TIMEOUT_MS = 2000

/**
 * 任务被终止（kill）后由 **host 侧**补写的退出码 = `1`。
 *
 * ★★ 为什么是 `1`：实测（2026-10-07，本机 Windows 各 3 次重复）——**退出码不是系统自动给的**，
 * 它**就是终止方传给 `TerminateProcess` 的那个参数**（同一进程换终止方值就变：`taskkill` ⇒ `1`、
 * `Stop-Process -Force` ⇒ `-1`/`0xFFFFFFFF`、node `child.kill` ⇒ 记 `signal`；
 * `TerminateProcess(h, 99/143/0/42)` 全部原样记录），而本机 **`taskkill /PID <pid> /T /F` 记录的值
 * 稳定 = `1`**（`/F` 不带 `/T` 也是 `1`）⇒ **1 就是"取任务进程真正的退出码"能取到的真值**。
 * 旧值 `143`（= 128 + 15）是 POSIX shell 的"被 SIGTERM 终止"约定，**Windows 根本不会产生**，已废弃。
 *
 * ★★ 两个边界（不要再按"退出码能自证来源"来推理）：
 *   ① **退出码由终止方传入** ⇒ 我们**读不到"任务自己"的退出码**：任务进程是 `schtasks` 起的，
 *      **不是我们 `spawn` 的、我们不持有它的句柄** ⇒ 手里只有 `taskkill` 写进内核的那个值
 *      （计划任务的 `Last Result` 就是这么来的）；
 *   ② `schtasks` 的 `Last Result` **不能当证据**：它分不清"runner 自己报了 1"与"runner 被杀成 1"。
 *   ⇒ 所以**来源**永远靠 `job.json` 的 `exitCodeSource:'killed'` + `killedAt`/`killedBy` 判定
 *     （`lib/core/registry.js` 的 `view` / `lib/core/tools.js` 的 `statusFromDisk` 都回传这三个字段），
 *     绝不靠退出码数值猜。
 *
 * 为什么必须由 host 补写：`exitcode.txt` 原本只由 runner 自己在收尾时写，而**进程被 taskkill /F
 * 杀掉时 runner 根本没有机会写**（实测：被杀时 runner 写不动 `exitcode.txt`）⇒ 不补写的话
 * `bgjob_wait` 会一直等到超时、面板永远显示 running。
 *
 * 若将来想让这个码成为"任务真值"：只有 **Job Object + `TerminateJobObject(hJob, code)`** 那条路
 * （**不做**：属另一条方案，会改 runner 的启动方式）。
 */
export const KILLED_EXIT_CODE = 1
/** 核验轮询间隔。 */
const KILL_VERIFY_POLL_MS = 100

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'
const TASKKILL = path.join(SYSTEM_ROOT, 'System32', 'taskkill.exe')
// 只读查询用 Windows PowerShell 5.1（Win10/11 恒在）；不要求 pwsh 7。
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** 探针输出标记：`BGJOBS-PID <存在 0|1> <归属 0|1>`（纯 ASCII，避开控制台代码页歧义）。 */
const PROBE_MARK = 'BGJOBS-PID'

/** PowerShell 单引号字符串字面量（内部 ' 翻倍转义）。 */
const psQuote = (value) => "'" + String(value).split("'").join("''") + "'"

/** 反查输出标记：`BGJOBS-PROC <pid> <ppid> <base64(CommandLine)>`（命令行 base64 避免解析歧义）。 */
const PROC_MARK = 'BGJOBS-PROC'

/**
 * 反查脚本：按 jobDir/taskName 从 Win32_Process 里找出**本任务**的进程，再按 ParentProcessId
 * 递归展开全部后代，输出 `BGJOBS-PROC <pid> <ppid> <b64(cmdline)>`（matched 为 1）。
 *
 * - 匹配只用 `.Contains()` 对**小写命令行**做子串判定（绝不做正则/通配），needle 由调用方
 *   限定为本任务的 jobDir/taskName/jobId —— 唯一且随机，这是"不误杀"的唯一依据；
 * - `matched` 与 `descendant` 分开：matched=命令行直接命中（可追溯的现场证据）；
 *   descendant=按父链展开出来的孙进程（命令行不含 jobDir，如 `PING.EXE -n 60 127.0.0.1`）。
 *   返回顺序保证 matched 在前（先杀根，再补刀残余后代）。
 * - 只读查询：不修改任何东西；探针/筛选失败一律返回空（调用方据此"不杀 + 如实报"）。
 */
export function buildProcessQueryScript(needles) {
  const lowered = (Array.isArray(needles) ? needles : [])
    .filter((needle) => typeof needle === 'string' && needle.length > 0)
    .map((needle) => needle.toLowerCase())
  const matchExpr = lowered.length > 0
    ? lowered.map((needle) => '$bgCmdline.Contains(' + psQuote(needle) + ')').join(' -or ')
    : '$false'
  const head = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$bgAll = @(Get-CimInstance Win32_Process)',
    'if ($bgAll.Count -eq 0) { exit 0 }',
    // ★ 自排除（实机踩到的真回归，2026-10-07）：本脚本的**正文里就含 needle 字符串**
    // （`$bgCmdline.Contains('...jobDir...')`）⇒ 运行本查询的 powershell 进程**必然自命中**，
    // 连它的 conhost 子进程也一起被当成"任务根"进击杀集（实机：matched 里混进查询进程本身，
    // 还把它自己的 conhost 当后代）。因此先算出"自己 + 自己的后代"这个集合，整段跳过。
    '$bgSelfPids = @{ [int]$PID = $true }',
    '$bgSelfQueue = @([int]$PID)',
    'while ($bgSelfQueue.Count -gt 0) {',
    '  $bgSelfNext = @()',
    '  foreach ($bgSelfParent in $bgSelfQueue) {',
    '    foreach ($bgSelfChild in @($bgAll | Where-Object { $_.ParentProcessId -eq $bgSelfParent })) {',
    '      if ($bgSelfPids.ContainsKey([int]$bgSelfChild.ProcessId)) { continue }',
    '      $bgSelfPids[[int]$bgSelfChild.ProcessId] = $true',
    '      $bgSelfNext += [int]$bgSelfChild.ProcessId',
    '    }',
    '  }',
    '  $bgSelfQueue = @($bgSelfNext)',
    '}',
    '$bgEntries = @()',
    'foreach ($bgProcess in $bgAll) {',
    // 本插件自己的查询/探针进程（命令行 = 脚本正文，含 marker 与 needle）一并排除；
    // 排除项永远只会是"为了巡检而起的进程"，不可能是任务自己的进程树。
    '  if ($bgSelfPids.ContainsKey([int]$bgProcess.ProcessId)) { continue }',
    '  $bgCmdline = ([string]$bgProcess.CommandLine).ToLowerInvariant()',
    '  if ($bgCmdline.Contains(' + psQuote(PROC_MARK.toLowerCase()) + ') -or $bgCmdline.Contains(' + psQuote(PROBE_MARK.toLowerCase()) + ')) { continue }',
    '  $bgEntries += [pscustomobject]@{ pid = [int]$bgProcess.ProcessId; ppid = [int]$bgProcess.ParentProcessId; cmd = [string]$bgProcess.CommandLine; matched = if (' + matchExpr + ') { 1 } else { 0 } }',
    '}',
    '$bgSeen = @{}',
    '$bgOut = @()',
    'foreach ($bgEntry in @($bgEntries | Where-Object { $_.matched -eq 1 })) {',
    '  if ($bgSeen.ContainsKey($bgEntry.pid)) { continue }',
    '  $bgSeen[$bgEntry.pid] = $true',
    '  $bgOut += [pscustomobject]@{ pid = $bgEntry.pid; ppid = $bgEntry.ppid; cmd = $bgEntry.cmd; matched = 1 }',
    '}',
    '$bgQueue = @($bgOut)',
    'while ($bgQueue.Count -gt 0) {',
    '  $bgNext = @()',
    '  foreach ($bgParent in $bgQueue) {',
    '    foreach ($bgChild in @($bgEntries | Where-Object { $_.ppid -eq $bgParent.pid })) {',
    '      if ($bgSeen.ContainsKey($bgChild.pid)) { continue }',
    '      $bgSeen[$bgChild.pid] = $true',
    '      $bgOut += [pscustomobject]@{ pid = $bgChild.pid; ppid = $bgChild.ppid; cmd = $bgChild.cmd; matched = 0 }',
    '      $bgNext += $bgChild',
    '    }',
    '  }',
    '  $bgQueue = @($bgNext)',
    '}',
  ].join('; ')
  const tail = [
    'foreach ($bgItem in $bgOut) {',
    '  $bgBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$bgItem.cmd)',
    '  $bgB64 = [System.Convert]::ToBase64String($bgBytes)',
    '  Write-Output (' + psQuote(PROC_MARK) + ' + \' \' + [string]$bgItem.pid + \' \' + [string]$bgItem.ppid + \' \' + [string]$bgItem.matched + \' \' + $bgB64)',
    '}',
  ].join('; ')
  return head + '; ' + tail
}

/**
 * 读任务目录里落盘的 pid 文件。返回 `{ pid, file, pidPath }` 或 `null`
 * （无 pid 文件 = 老任务，调用方走既有 /End + /Delete 路径）。
 */
export async function readJobPid(jobDir) {
  for (const name of PID_FILE_NAMES) {
    const pidPath = path.join(jobDir, name)
    let text
    try { text = await fsp.readFile(pidPath, 'utf8') } catch { continue }
    const pid = Number.parseInt(String(text).trim(), 10)
    if (Number.isInteger(pid) && pid > 0) return { pid, file: name, pidPath }
  }
  return null
}

/**
 * 拼出探针脚本（纯文本；导出以便测试直接断言形状，不必每次真起 PowerShell）。
 * 输出一行 `BGJOBS-PID <存在 0|1> <归属 0|1>`，其余一律不写。
 */
export function buildProbeScript(pid, needles) {
  const lowered = (Array.isArray(needles) ? needles : [])
    .filter((needle) => typeof needle === 'string' && needle.length > 0)
    .map((needle) => needle.toLowerCase())
  const ownerExpr = lowered.length > 0
    ? lowered.map((needle) => '$bgCmdline.Contains(' + psQuote(needle) + ')').join(' -or ')
    : '$false'
  // ★ 拼装陷阱（实机验收抓到过一次，勿改回 join('; ') 一把梭）：整段是**一条** if/else 语句，
  // `}` 与 `else` 之间**绝不能有分号**——`}; else {` 会让 PowerShell 把 `else` 当命令执行，
  // 脚本 exit 1、一个字符都不输出 ⇒ 探针永远 `unknown`、pid 复用防护静默失效（进程存在时必现）。
  const head = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$bgProcess = Get-CimInstance Win32_Process -Filter ' + psQuote('ProcessId=' + pid),
    'if ($null -eq $bgProcess) { Write-Output ' + psQuote(PROBE_MARK + ' 0 0') + ' }',
  ].join('; ')
  const tail = [
    '$bgCmdline = ([string]$bgProcess.CommandLine).ToLowerInvariant()',
    '$bgOwned = if (' + ownerExpr + ') { 1 } else { 0 }',
    'Write-Output (' + psQuote(PROBE_MARK + ' 1 ') + ' + $bgOwned)',
  ].join('; ')
  return head + ' else { ' + tail + ' }'
}

/**
 * 查询 pid 是否存在、以及是否**属于本任务**（命令行含任一 needle，如 jobDir / taskName）。
 * 返回 `{ state: 'gone' | 'alive' | 'unknown', owned: boolean }`：
 *   - `gone`    = 该 pid 不存在（已退出 / 从未存在）；
 *   - `alive`   = 存在；`owned` 表示命令行命中了 needle；
 *   - `unknown` = 探针不可用或输出无法解析（**无法核验**，不是"没杀成"）。
 * 只读查询：Get-CimInstance Win32_Process，不修改任何东西。
 */
export async function probeProcess(pid, needles, workdir) {
  const script = buildProbeScript(pid, needles)
  let result
  try {
    result = await runSchtasks([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', script], workdir)
  } catch {
    return { state: 'unknown', owned: false }
  }
  const line = String((result && result.stdout) || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(PROBE_MARK))
  if (line === undefined) return { state: 'unknown', owned: false }
  const parts = line.split(/\s+/)
  if (parts[1] !== '1') return { state: 'gone', owned: false }
  return { state: 'alive', owned: parts[2] === '1' }
}

/**
 * 解析反查输出。每行 `BGJOBS-PROC <pid> <ppid> <matched 0|1> <b64(cmdline)>`；
 * 解析不了的行一律忽略（缺字段/pid 非正整数/base64 解不开）——绝不因为一行脏数据乱杀。
 */
export function parseProcessQueryOutput(stdout) {
  const entries = []
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith(PROC_MARK)) continue
    const parts = line.split(/\s+/)
    const pid = Number.parseInt(parts[1], 10)
    const ppid = Number.parseInt(parts[2], 10)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const matched = parts[3] === '1'
    let cmdline = ''
    if (parts[4] !== undefined) {
      try { cmdline = Buffer.from(parts[4], 'base64').toString('utf8') } catch { cmdline = '' }
    }
    entries.push({ pid, ppid: Number.isInteger(ppid) ? ppid : 0, matched, cmdline })
  }
  return entries
}

/**
 * 按 jobDir / taskName 反查"属于本任务"的进程（含后代），返回
 *   `{ entries: [{ pid, ppid, matched, cmdline }], matchedCount, error? }`。
 * 只读：Get-CimInstance Win32_Process 一次全量 + 内存里做子串匹配与父链展开。
 * **任何失败都返回空集**（含 error），调用方据此"不杀 + 如实报"。
 */
export async function listJobProcesses(needles, workdir) {
  const script = buildProcessQueryScript(needles)
  let result
  try {
    result = await runSchtasks([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', script], workdir)
  } catch (e) {
    return { entries: [], matchedCount: 0, error: 'process query spawn failed: ' + (e && e.message ? e.message : String(e)) }
  }
  if (!result || result.exitCode !== 0) {
    const detail = String((result && (result.stderr || result.stdout)) || '').trim()
    return {
      entries: [], matchedCount: 0,
      error: 'process query exit ' + String(result && result.exitCode) + (detail ? ': ' + detail : ''),
    }
  }
  const entries = parseProcessQueryOutput(result.stdout)
  return { entries, matchedCount: entries.filter((entry) => entry.matched).length }
}

/** 单次 `taskkill /PID <pid> /T /F`；非零退出码**不吞**，原样带回来。 */export async function killProcessTree(pid, workdir) {
  let result
  try {
    result = await runSchtasks([TASKKILL, '/PID', String(pid), '/T', '/F'], workdir)
  } catch (e) {
    return { ok: false, error: 'taskkill spawn failed: ' + (e && e.message ? e.message : String(e)) }
  }
  if (result.exitCode !== 0) {
    const detail = String((result.stderr || '') + (result.stdout || '')).trim()
    return { ok: false, error: 'taskkill /PID ' + pid + ' /T /F exit ' + result.exitCode + (detail ? ': ' + detail : '') }
  }
  return { ok: true }
}

/**
 * 轮询到 pid 消失（≤ timeoutMs）。返回 `'gone' | 'alive' | 'unknown'`。
 * `unknown`（探针不可用）不能当作"仍活"，否则会把删得掉的任务判成失败。
 */
export async function waitPidGone(pid, needles, workdir, timeoutMs = KILL_VERIFY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const probe = await probeProcess(pid, needles, workdir)
    if (probe.state !== 'alive') return probe.state
    if (Date.now() >= deadline) return 'alive'
    await new Promise((resolve) => setTimeout(resolve, KILL_VERIFY_POLL_MS))
  }
}

/** 回传/落日志的命令行片段上限（证据够用即可，不把整条命令行无界带回）。 */
const CMDLINE_SNIPPET_CHARS = 200

/** 命令行片段：压成单行 + 截断（回传证据用）。 */
function cmdlineSnippet(value) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > CMDLINE_SNIPPET_CHARS ? text.slice(0, CMDLINE_SNIPPET_CHARS) + '…' : text
}

/**
 * 击杀集排序（导出以便测试直接断言顺序）：matched（命令行直接命中 = 任务根）排在前，
 * 两者各自按"最外层根 → 最内层后代"排列。
 *
 * 为什么必须先杀最外层：`taskkill /PID <pid> /T` 的语义是"该 pid + **它当前的**子树"，
 * 先杀最外层根一次就带走整棵子树；反过来先杀内层后代，则外层的 /T 还会去摸已经不存在的
 * pid（噪音），且中途新起的后代可能漏掉。父链断掉（父进程早退）时认不到祖先 ⇒ 退回 pid
 * 排序兜底，**绝不因为排序失败丢掉任何进程**。
 */
export function orderKillSet(entries) {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]))
  const depthOf = (entry) => {
    let depth = 0
    let cursor = entry
    const seen = new Set([entry.pid])
    while (depth < 64) {
      const parent = byPid.get(cursor.ppid)
      if (parent === undefined || seen.has(parent.pid)) break
      seen.add(parent.pid)
      cursor = parent
      depth += 1
    }
    return depth
  }
  const ranked = entries.map((entry) => ({ entry, depth: depthOf(entry) }))
  ranked.sort((left, right) => (
    (left.entry.matched === right.entry.matched ? 0 : (left.entry.matched ? -1 : 1))
    || (left.depth - right.depth)
    || (left.entry.pid - right.entry.pid)
  ))
  const ordered = []
  const seenPids = new Set()
  for (const item of ranked) {
    if (seenPids.has(item.entry.pid)) continue
    seenPids.add(item.entry.pid)
    ordered.push(item.entry)
  }
  return ordered
}

/**
 * 反查兜底（缺口 B）：没有 pid 文件可用时，按 jobDir/taskName/jobId 反查本任务进程树再树杀。
 *
 * 覆盖口径（★ 实测澄清，勿再走弯路）：反查脚本**先按命令行筛出任务根**，再按 ParentProcessId
 * **递归展开全部后代**——所以"后代的命令行里不含 jobDir"（`PING.EXE -n 60 127.0.0.1`、
 * `conhost.exe 0x4` 都是这样）**不会**导致漏杀：它们以 matched=0 进击杀集，逐个
 * `taskkill /PID <pid> /T /F`；同时对最外层根用 `/T`，等于原 pid 路径的树杀语义。
 * 击杀集 = matched（根）+ 后代，**去重**、最外层优先（见 orderKillSet）。
 *
 * 返回 `{ ok, skipped, matched, killedPids, killed, stderr, survivors?, error?, processFound, note? }`：
 *   - `matched`     = 命令行直接命中的根 pid（现场证据）；
 *   - `killedPids`  = **实际下过 taskkill 的** pid（根 + 后代，按击杀顺序）；
 *   - `killed`      = 上述每个 pid 的证据 `{ pid, ppid, matched, cmdline }`（命令行片段）；
 *   - `survivors`   = 核验后仍存活的 pid（整棵子树都核验，不只根）；
 *   - `stderr`      = 后代 taskkill 的非零输出（多半是"已随根的 /T 消失"，不算失败）；
 *   - `processFound`= **有没有本任务的活进程**：true（杀了/有活进程）/ false（进程不存在）/
 *                     null（反查本身跑不起来 ⇒ 无法判定）。
 * `skipped` ∈ 'no-match'。安全：筛不到任何匹配进程 ⇒ **绝不杀**。
 *
 * ★ 语义（用户裁定；边界 2026-10-08 更正）：筛不到任何匹配进程 = **本任务进程不存在**，
 * 无论 `status` 记的是 running 还是 done —— 都不是失败，而是"没有进程可杀"（ok:true +
 * skipped:'no-match' + processFound:false）。running 时附一条 `note` 说明"**未发现活进程**、kill
 * 什么都没做也没删任何记录，要清记录请调用方去调 delete"，由调用方如实回传（旧实现在这里回
 * ok:false「无法证实已退出」，已按裁定作废；kill **不转 delete**，两个动作各自纯粹）。
 */
async function killByReverseLookup(needles, workdir, timeoutMs, status) {
  const found = await listJobProcesses(needles, workdir)
  if (found.error !== undefined) return { ok: false, error: found.error, processFound: null }
  const matched = found.entries.filter((entry) => entry.matched)
  if (matched.length === 0) {
    return {
      ok: true, skipped: 'no-match', processFound: false,
      ...(status === 'running'
        ? { note: 'no pid file and no process matched jobDir/taskName —— 未发现该任务的活进程 ⇒ 无可终止（kill 只终止进程，本次未删除任何记录）；要清记录请调用 delete' }
        : {}),
    }
  }
  // ★ 动手前先把"要杀谁"（pid + 命令行片段）打进日志**和**返回值 —— 事后可追溯、可复核。
  const killSet = orderKillSet(found.entries).map((entry) => ({
    pid: entry.pid, ppid: entry.ppid, matched: entry.matched, cmdline: cmdlineSnippet(entry.cmdline),
  }))
  console.warn('[bgjobs] reverse lookup kill set: ' + matched.length + ' matched + '
    + (killSet.length - matched.length) + ' descendant(s) —— '
    + killSet.map((spec) => (spec.matched ? 'root ' : 'desc ') + spec.pid + ' «' + spec.cmdline + '»').join(' | '))
  const rootNotes = []
  const descendantNotes = []
  const killedPids = []
  for (const spec of killSet) {
    const killed = await killProcessTree(spec.pid, workdir)
    killedPids.push(spec.pid)
    if (!killed.ok) {
      // ★ 非零 ≠ 失败（实机踩到的真回归，2026-10-07）：最外层根的 `/T` 已经把 matched 子根
      // 一起带走时，再对子根 taskkill 会返回 128（找不到进程）——那是"已经死了"，不是失败。
      // 因此这里只把非零输出当**证据**（stderr）；成败一律以核验（survivors）为准。
      if (spec.matched) rootNotes.push(killed.error)
      else descendantNotes.push(killed.error)
    }
  }
  // ★ 核验整棵子树（不只根）：共用一份 timeoutMs 预算逐个轮询到消失；还在的如实列出。
  const deadline = Date.now() + timeoutMs
  const survivors = []
  for (const spec of killSet) {
    const observed = await waitPidGone(spec.pid, needles, workdir, Math.max(0, deadline - Date.now()))
    if (observed === 'alive') survivors.push(spec.pid)
  }
  const matchedPids = matched.map((entry) => entry.pid)
  const stderr = rootNotes.concat(descendantNotes).join(' | ')
  if (survivors.length > 0) {
    return {
      ok: false,
      error: 'reverse lookup: ' + survivors.length + '/' + killedPids.length
        + ' 个进程在 taskkill 后仍存活（' + survivors.join(', ') + '）'
        + (stderr ? '（taskkill stderr: ' + stderr + '）' : ''),
      matched: matchedPids, killedPids, killed: killSet, survivors, stderr, processFound: true,
    }
  }
  return { ok: true, matched: matchedPids, killedPids, killed: killSet, stderr, processFound: true }
}

/**
 * 结束一个任务的进程树（killJob / Stop-BgjobsJobProcesses 的公共语义）。★ 只终止进程，
 * **不删任何记录**（job 目录 / 中央索引 / 注册表由 delete 路径负责）。返回：
 *   `{ ok: true, skipped: 'already-gone' | 'not-owned', pid, processFound: false }`  无需杀；
 *   `{ ok: true, pid, file, verified, processFound: true }`                      pid 路径杀过；
 *   `{ ok: true, killedPids, matched, killed, note, processFound: true }`        pid 路径失败后反查兜底杀成；
 *   `{ ok: true, skipped: 'no-match', processFound: false, note? }`              **未发现活进程**（无 pid
 *                                                                               文件且反查不到；running 时附 note）
 *                                                                               ⇒ kill 什么都不做、什么都不删，
 *                                                                               要清记录由调用方去调 delete；
 *   `{ ok: false, error, processFound: null }`                                   无法判定（反查/探针跑不起来）；
 *   `{ ok: false, error, processFound: true }`                                   有活进程但杀不掉（归属核验失败 /
 *                                                                               taskkill 非零且核验仍活 / 杀后仍活）。
 *
 * `processFound` = 本次到底有没有"本任务的活进程"在场：true（有，走了 kill 语义）/ false（**未发现
 * 活进程** ⇒ kill 无可终止，记录一律保留，要清记录是调用方调 delete 的事）/ null（无法判定）。调用方
 * 据此决定 mode（见 lib/core/web.js 的 killJob 与 detectJobProcesses），**不要靠 error 文案猜**。
 *
 * 归属硬门禁只对 `run.pid` 生效：它一定是 run.ps1 进程，命令行必然含 jobDir/taskName，
 * 命令行不含 ⇒ 这个 pid 已被系统复用给无关进程，绝不误杀。`mcp-server.pid` 记的是用户
 * 配置的 stdio server 子进程，其命令行**天然不含** jobDir（如 `node <DRIVE>:\srv\x.mjs`），
 * 对它做同一门禁会把正常的孤儿回收全部误判 ⇒ 沿用既有"尽力而为"语义，但失败不再被吞。
 *
 * ★ 取哪个口径（缺口 B 要求明确声明）：**有 pid 文件 → 只走原路径**（pid 级 taskkill /T /F，
 * 与既有行为一致，不叠加反查）；**无 pid 文件 → 只走反查**；原路径**跑完但核验没过**
 * （taskkill 非零 / 杀后仍活）→ **再试一次反查**（清掉 /End 够不到的后代）。
 * 唯独"归属核验失败"（pid 已被系统复用给无关进程）**不触发反查**：该 pid 与本任务无关，
 * 顺藤摸瓜只会把无关进程的后代卷进来——那是误导伤，直接如实报错。
 */
export async function killJobProcessTree(job, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : KILL_VERIFY_TIMEOUT_MS
  const jobDir = job.meta.jobDir || path.dirname(job.meta.jsonPath)
  const needles = [jobDir, job.meta.taskName, job.id].filter((needle) => typeof needle === 'string' && needle.length > 0)
  const found = await readJobPid(jobDir)
  if (found === null) return killByReverseLookup(needles, job.meta.workdir, timeoutMs, job.status)
  const before = await probeProcess(found.pid, needles, job.meta.workdir)
  if (before.state === 'gone') {
    return { ok: true, skipped: 'already-gone', pid: found.pid, file: found.file, processFound: false }
  }
  if (found.file === 'run.pid' && before.state === 'alive' && !before.owned) {
    const reason = 'pid reuse guard: PID ' + found.pid + ' (' + found.file
      + ") 的命令行不含本任务 jobDir/taskName —— 拒绝 kill（不误杀无关进程）"
    // done 任务：pid 早被系统复用，属陈旧 pid 文件，跳过 kill 即可（不阻断删除）。
    if (job.status !== 'running') {
      return { ok: true, skipped: 'not-owned', pid: found.pid, file: found.file, note: reason, processFound: false }
    }
    // running + 该 pid 上的活进程不是本任务的：本任务的进程**无法证实**在跑（pid 复用），
    // 但也无法证实它没在跑 ⇒ 保守保留 ok:false（kill 失败），绝不因此误杀无关进程。
    return { ok: false, error: reason, pid: found.pid, file: found.file, processFound: true }
  }
  const failure = async (primaryError) => {
    // 原路径失败 ⇒ 再试反查兜底（反查自身"筛不到"不算错误，保留原错误）
    const fallback = await killByReverseLookup(needles, job.meta.workdir, timeoutMs, job.status)
    if (fallback.ok && fallback.skipped !== 'no-match') {
      return {
        ok: true, pid: found.pid, file: found.file, verified: true,
        killedPids: fallback.killedPids, matched: fallback.matched, killed: fallback.killed,
        note: primaryError + ' ⇒ 已按 jobDir/taskName 反查进程树兜底并击杀成功',
        processFound: true,
      }
    }
    const extra = fallback.ok && fallback.skipped === 'no-match'
      ? '；按 jobDir/taskName 反查亦未匹配到任何进程'
      : '；反查兜底亦失败: ' + String(fallback.error)
    return {
      ok: false, error: primaryError + extra, pid: found.pid, file: found.file,
      // 主路径杀之前已探到该 pid 存活且属于本任务 ⇒ "有活进程"是既成事实（即便反查这次筛不到）。
      processFound: true,
      ...(Array.isArray(fallback.killedPids) ? { killedPids: fallback.killedPids } : {}),
      ...(Array.isArray(fallback.killed) ? { killed: fallback.killed } : {}),
      ...(Array.isArray(fallback.survivors) ? { survivors: fallback.survivors } : {}),
    }
  }
  const killed = await killProcessTree(found.pid, job.meta.workdir)
  if (!killed.ok) return failure(killed.error)
  const after = await waitPidGone(found.pid, needles, job.meta.workdir, timeoutMs)
  if (after === 'alive') {
    return failure('PID ' + found.pid + ' (' + found.file + ') 在 taskkill 后 ' + timeoutMs + 'ms 内仍存活')
  }
  return {
    ok: true, pid: found.pid, file: found.file, verified: after === 'gone', processFound: true,
    ...(after === 'unknown' ? { note: 'pid 存活核验不可用（探针无输出）：taskkill 已执行但未证实整树退出' } : {}),
  }
}

/**
 * 只读判定："本任务到底有没有活进程"（**delete 路径的前置条件**，绝不杀任何东西、绝不改状态）。
 * delete 只删记录，所以动手前必须先确认没有活进程——有活进程是 kill 的事（两者彻底分开）。
 * 复用与 killJobProcessTree 同一套手段（pid 文件 + 归属核验 / jobDir+taskName 反查），返回：
 *   `{ state: 'live', pid, file }`     pid 文件指向的进程存活且属于本任务（`mcp-server.pid` 天然不含
 *                                      jobDir ⇒ 只看存活，与 kill 路径同口径）；
 *   `{ state: 'live', matched: [pid] }` 无 pid 文件 ⇒ 反查到活进程（matched = 命令行直接命中的根）；
 *   `{ state: 'absent', reason }`      确认**没有**本任务的活进程。reason ∈ 'pid-gone'（pid 已退出）/
 *                                      `'pid-reused'`（pid 被系统复用给无关进程 ⇒ 本任务进程已不在）/
 *                                      `'no-match'`（无 pid 文件且反查不到）；
 *   `{ state: 'unknown', error }`      **无法判定**（探针或反查本身跑不起来）——调用方必须保守处理，
 *                                      绝不可当成 'absent' 去删记录。
 */
export async function detectJobProcesses(job) {
  const jobDir = job.meta.jobDir || path.dirname(job.meta.jsonPath)
  const needles = [jobDir, job.meta.taskName, job.id].filter((needle) => typeof needle === 'string' && needle.length > 0)
  const found = await readJobPid(jobDir)
  if (found !== null) {
    const probe = await probeProcess(found.pid, needles, job.meta.workdir)
    if (probe.state === 'gone') return { state: 'absent', reason: 'pid-gone', pid: found.pid, file: found.file }
    if (probe.state === 'unknown') {
      return {
        state: 'unknown', pid: found.pid, file: found.file,
        error: '进程存活核验不可用（探针无输出）：无法判定 PID ' + found.pid + ' (' + found.file + ') 是否仍在运行',
      }
    }
    // pid 复用防护：run.pid 记的一定是 run.ps1（命令行必然含 jobDir/taskName）；不含 ⇒ 该 pid
    // 已被系统复用给无关进程 ⇒ **本任务的进程不存在**（不是"有活进程"）。绝不误杀，也不据此拒绝删除。
    if (found.file === 'run.pid' && !probe.owned) {
      return { state: 'absent', reason: 'pid-reused', pid: found.pid, file: found.file }
    }
    return { state: 'live', pid: found.pid, file: found.file }
  }
  const listed = await listJobProcesses(needles, job.meta.workdir)
  if (listed.error !== undefined) return { state: 'unknown', error: listed.error }
  const matched = listed.entries.filter((entry) => entry.matched)
  if (matched.length === 0) return { state: 'absent', reason: 'no-match' }
  return { state: 'live', matched: matched.map((entry) => entry.pid) }
}
