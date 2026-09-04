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
//     实测 17:54:30 与 17:55:00 两次日志），故 /Run 成功后立即 /Change /DISABLE 任务计划
//     （不能用 /Delete：/Run 实例异步排队启动，紧随的 /Delete 会把排队运行连同注册一起
//     丢弃→进程从未启动→永远 running 且无日志）；bat 末尾与 done 兜底的 /Delete 变成无害
//     no-op；
//   - 日志尾部：每秒按字节位置增量读（TextDecoder 流式解码，避免截断多字节
//     UTF-8）；任务完成检测事件驱动：fs.watch 监视任务目录，exitcode.txt
//     出现即触发 → 状态迁移 done → agents.followup 通知创建任务的 agent 会话，
//     tick 每 5s 兜底补查防 watch 丢事件；done 后 DSH 侧再 fire-and-forget
//     一次 schtasks /Delete 兜底（bat 正常已自删，防中途退出残留任务计划）；
//   - webServer 前缀路由 /bgjobs/* 供客户端面板轮询；
//   - done 任务在内存注册表持续保留（不按时间剪枝），面板与中央索引一致保留，
//     直到用户手动删除或“一键清理”；job.json 已落盘终态，清理不丢历史。
//
// cmd 陷阱备忘：`echo %var%>file` 当 var 为数字时被解析成句柄重定向
// （0 字节文件、输出丢失），必须写成 `> file echo %var%`。

import { promises as fsp, watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

export const name = 'bgjobs'
export const inject = ['tools', 'timer', 'systemPrompt']

const TAIL_CAP = 100 * 1024
const SPAWN_TIMEOUT_MS = 30000
const SCHTASKS = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\schtasks.exe'
const ICACLS = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\icacls.exe'

// ── bgjob_wait 轮询（v0.1.51）─────────────────────────────────────────
// 轮询间隔与「任务自身已运行时长」成正比（而非本工具等待时长）：短任务毫秒级响应，
// 任务越久间隔越大；下限 250ms、上限 1s——间隔永远封顶 1s，不会超过任务完成窗口。
// interval = clamp(250ms, taskAge * WAIT_POLL_RATIO, 1000ms)。
const WAIT_POLL_MS = 250
const WAIT_POLL_MAX_MS = 1000
const WAIT_POLL_RATIO = 0.1   // 任务已运行时长的 10%；约 age=10s 时达 1s 上限

// ── 沙箱（复用 dsh sandbox-windows-acl 的独立 runner）────────────────────
// bgjob sandbox 词表：read-only < workspace-write < off(全权限)。任务权限不得高于
// 会话访问模式（会话受限时）；更宽的请求经 ctx.approval 弹窗审批或 full access 开关预批准。
// 会话三态：none = 未挂载 sandboxPolicy 服务（无法确认会话模式 → full access 关则拒绝）；
// full = 服务在但会话全权限（danger-full-access）；read-only/workspace-write = 会话受限。
const BGJOB_SANDBOX_MODES = ['read-only', 'workspace-write', 'off']
const BGJOB_SESSION_STATES = ['none', 'full', 'read-only', 'workspace-write']
const SANDBOX_PERM = { 'read-only': 0, 'workspace-write': 1, off: 2 }

// ── 完成通知创建者（可选 notify 参数，v0.1.31）─────────────────────
// notify 触发条件：off 不通知；on-completion 仅 exit 0；on-fail 仅非零退出；on-exit 任何退出。
// notify_mode 交付方式：wakeup（空闲唤醒+预算）/quiet（仅入收件箱）/always（空闲恒唤醒）。
const BGJOB_NOTIFY_MODES = ['off', 'on-completion', 'on-fail', 'on-exit']
const BGJOB_NOTIFY_DELIVERIES = ['wakeup', 'quiet', 'always']

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
 * 计算任务最终 sandbox 模式 + 是否需升权审批（纯函数；apply 里做 ctx 胶水）。
 * @param state - 会话态：'none' = 未挂载 sandboxPolicy 服务；'full' = 服务在但会话
 *   全权限（danger-full-access）；'read-only'/'workspace-write' = 会话受限。
 * @param requested - 显式请求模式（read-only|workspace-write|off）或 undefined（缺省）。
 * @param engine - 'pwsh' 支持受限与 off；'bat' 不支持沙箱（恒全权限）→ 受限会话仅
 *   full access 模式支持（开关关直接拒绝，不走逐次审批）。
 * @param fullAccess - full access 开关（用户预批准全权限后台任务，宽请求不弹窗）。
 * @returns { mode, escalate }：mode = 最终落盘模式；escalate = true 时须先经 ctx.approval
 *   审批，拒绝/取消则不提交。
 * @throws state='none' 且 full access 关（无法确认会话访问模式，fail closed）；
 *   bat 引擎 + 受限会话 + full access 关（恒全权限无法满足"不高于会话模式"）；参数非法。
 */
export function jobSandboxDecision(state, requested, engine, fullAccess) {
  if (!BGJOB_SESSION_STATES.includes(state)) {
    throw new Error('unexpected session state: ' + state)
  }
  if (engine !== 'pwsh' && engine !== 'bat') {
    throw new Error('unexpected engine: ' + engine)
  }
  let mode
  if (engine === 'pwsh') {
    if (requested !== undefined && !BGJOB_SANDBOX_MODES.includes(requested)) {
      throw new Error('invalid sandbox "' + requested + '" (expected read-only | workspace-write | off)')
    }
    if (requested !== undefined) mode = requested
    else mode = state === 'read-only' || state === 'workspace-write' ? state : 'off'
  } else {
    if (requested !== undefined) throw new Error('sandbox is only supported on bgjob_submit_pwsh; use it for sandboxed jobs')
    mode = 'off'
  }
  if (state === 'none') {
    if (!fullAccess) {
      throw new Error(
        'bgjob submit refused: no dsh sandbox policy service is composed, so the session access mode cannot be verified; '
        + 'turn on the "full access" switch in the bgjobs panel to run unrestricted background jobs, '
        + 'or compose the dsh sandbox services (sandbox-policy + a local executor) for restricted jobs',
      )
    }
    return { mode, escalate: false }
  }
  if (state === 'full') return { mode, escalate: false }
  if (engine === 'bat') {
    // bat 引擎任务无法沙箱化、恒为全权限：受限会话里"逐次审批"没有意义（每次都会超限），
    // 唯一出口是 full access 开关（用户全局预批准全权限 = 原模式）。
    if (!fullAccess) {
      throw new Error(
        'bgjob_submit (bat engine) cannot be sandboxed and always runs with full permissions; '
        + 'in a restricted session it is only supported when the "full access" switch in the bgjobs panel is on, '
        + 'or use bgjob_submit_pwsh with an explicit sandbox mode',
      )
    }
    return { mode, escalate: false }
  }
  const escalate = SANDBOX_PERM[mode] > SANDBOX_PERM[state] && !fullAccess
  return { mode, escalate }
}

/**
 * 任务结束后是否通知创建者（纯函数）。只在状态迁移 done、exitCode 已知后调用。
 * @param notify - notify 配置（off/on-completion/on-fail/on-exit）；undefined 视为 off。
 * @param exitCode - 任务退出码（done 后必为 number；null/undefined 视为尚未结束）。
 * @returns true = 需要通知创建者会话。
 */
export function shouldNotifyForExit(notify, exitCode) {
  if (notify === 'on-completion') return exitCode === 0
  if (notify === 'on-fail') return exitCode !== 0
  if (notify === 'on-exit') return exitCode !== undefined && exitCode !== null
  return false
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
 * 生成 pwsh 引擎的任务包装脚本（run.ps1）：schtasks /TR 直接调用 PowerShell 执行
 * 本脚本（不再经过 cmd 的 run.bat），由它完成输出重定向（& job.ps1 *> stdout.log）、
 * 写 exitcode.txt、自删任务计划。退出码取 $LASTEXITCODE（exit N 或原生命令退出码），
 * try/catch 兜底保证 exitcode.txt 一定写入（任务不会卡 running）；5.1 的 *> 输出
 * UTF-16LE（BOM FF FE），检测到即转 UTF-8（pwsh 7 已是 UTF-8，跳过）。
 * 沙箱任务（job.meta.sandbox 非 off）：外层（完整 token）保持重定向/exitcode/自删，
 * 仅"用户命令"经 sandbox-windows-acl 独立 runner 包装（--workspace=workdir、
 * --temp=sandbox 私有根、--mode 受限模式，子命令=解释器 -File job.ps1）；受限子进程
 * 经外层已打开句柄输出，退出码经 runner 镜像 → $LASTEXITCODE 语义不变。
 */
export function buildPwshRunner(job) {
  const scriptPath = job.meta.scriptPath || path.join(path.dirname(job.meta.jsonPath), 'job.ps1')
  const sandbox = job.meta.sandbox && job.meta.sandbox !== 'off' ? job.meta.sandbox : undefined
  const runLine = sandbox
    ? "& '" + job.meta.nodeExe + "' '" + job.meta.sandboxRunnerPath + "' --workspace '" + job.meta.workdir
      + "' --temp '" + job.meta.sandboxTempPath + "' --mode " + sandbox + " '--' '" + job.meta.interpreter
      + "' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '" + scriptPath + "' *> $logPath"
    : "    & '" + scriptPath + "' *> $logPath"
  const lines = [
    '# bgjobs pwsh runner: 重定向 + exitcode + 自删任务计划',
    'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    "Set-Location -LiteralPath '" + job.meta.workdir + "'",
    "$logPath = '" + job.meta.logPath + "'",
    '$code = 0',
    'try {',
    runLine,
    '    if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }',
    '} catch {',
    '    $code = 1',
    "    [System.IO.File]::AppendAllText($logPath, '[BGJOB] error: ' + $_.Exception.Message + [Environment]::NewLine, $utf8)",
    '}',
    'if (Test-Path -LiteralPath $logPath) {',
    '    $logBytes = [System.IO.File]::ReadAllBytes($logPath)',
    '    if ($logBytes.Length -ge 2 -and $logBytes[0] -eq 0xFF -and $logBytes[1] -eq 0xFE) {',
    '        [System.IO.File]::WriteAllText($logPath, [System.IO.File]::ReadAllText($logPath, [System.Text.Encoding]::Unicode), $utf8)',
    '    }',
    '}',
    "[System.IO.File]::AppendAllText($logPath, '[BGJOB] exit code: ' + $code + [Environment]::NewLine, $utf8)",
    "[System.IO.File]::WriteAllText('" + job.meta.exitcodePath + "', [string]$code, $utf8)",
    "& schtasks /Delete /TN '" + job.meta.taskName + "' /F *> $null",
  ]
  return lines.join('\r\n') + '\r\n'
}

/**
 * 生成 bat 引擎的隐藏启动器（launch.vbs）：/TR 改为 wscript.exe 执行本脚本，以隐藏窗口
 * （SW_HIDE=0）启动同目录的 run.bat 并等待（True）。wscript 是 GUI 子系统（无控制台窗口），
 * Windows 全系自带——bat 引擎保持零 PowerShell 依赖。模板纯 ASCII：路径运行时由 FSO 从
 * 自身目录（jobDir）推导，不内嵌任何路径/中文（.vbs 无 BOM 按 ANSI 读，内嵌中文路径会乱码）。
 */
export function buildLaunchVbs() {
  return [
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'sh.Run """" & dir & "\\run.bat""", 0, True',
  ].join('\r\n') + '\r\n'
}

/**
 * 生成 pwsh 用户命令脚本（job.ps1）：编码 preamble + 用户命令原样（CRLF 归一）。
 * [Console]::OutputEncoding 决定进程 stdout 重定向到文件时的字节编码：
 * Windows PowerShell 5.1 重定向默认 UTF-16LE，设为 UTF-8 后日志与插件读取一致；
 * pwsh 7 默认已是 UTF-8，设置无副作用。$OutputEncoding 保证用户命令管道传给
 * 原生工具的字符串按 UTF-8 编码。不设置 $ErrorActionPreference，保持默认语义。
 */
export function buildPs1(job) {
  const preamble = [
    '# bgjobs: 强制 UTF-8 输出（Windows PowerShell 5.1 重定向默认 UTF-16 会乱码）',
    'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  ].join('\r\n')
  return preamble + '\r\n' + String(job.meta.command).split(/\r?\n/).join('\r\n') + '\r\n'
}

/**
 * 模型可见的后台任务使用指引（system prompt guidance）。
 * 镜像 dsh-ai4scholar 的 buildGuidance：纯文本构建，注明工具族、何时用、注意事项。
 */
export function buildBgjobsGuidance() {
  return [
    '可用的后台任务工具：',
    '- bgjob_submit: 把命令提交为独立于 DSH 进程的后台任务（Windows 任务计划程序托管，关 DSH/关终端不影响）。适用于长任务：下载/同步/编译/仿真/批量脚本等。command 为 bat 语法（多行逐行执行；for 循环变量写 %%i）；命令含 exit/goto 会提前终止 bat 导致 exitcode 不写入；workdir 必须是工作区内绝对路径。',
    '- bgjob_submit_pwsh: 与 bgjob_submit 同机制（schtasks 托管、面板/Toast），但 command 为 PowerShell 语法（PowerShell 执行，pwsh 7 优先），输出日志 UTF-8（无 cmd GBK/UTF-8 乱码问题）；exit <code> 语义安全。中文输出/管道/需安全退出码的命令优先用此工具。',
    '- 沙箱：bgjob_submit_pwsh 支持可选 sandbox 参数（read-only/workspace-write/off；缺省继承当前受限会话模式，会话全权限则为 off=全权限）。后台任务权限不会高于会话访问模式：受限会话里请求全权限（off）或更宽模式时，若 bgjobs 面板的 full access 开关关闭，会弹窗请用户批准（请附 justification 说明理由）；开关打开则视为用户预批准。沙箱复用 dsh 沙箱、只约束文件效果（写工作目录/临时区外会被拒绝），网络不受限。bat 引擎（bgjob_submit）任务恒为全权限、无法沙箱化：受限会话下仅当 full access 开关开启才可用，否则提交被拒——受限任务请用 bgjob_submit_pwsh。未挂载 dsh 沙箱服务（sandbox-policy）的部署无法确认会话模式：bgjob 默认被拒，需在面板打开 full access 开关（或部署沙箱服务）才能提交。',
    '- bgjob_status: 查询后台任务状态（running/done）、退出码、日志尾部。',
    '- bgjob_wait: 等待后台任务结束（默认最多 120 秒，可传 timeoutSeconds，范围 1–600），结束后立即返回退出码与日志尾部；需要等结果继续时用它，避免用前台 sleep 反复轮询。长任务仍推荐 bgjob_submit 的 notify。',
    '- 完成通知：任务结束默认只弹网页 Toast，不打扰会话。需要会话内通知时传 notify（on-completion=仅成功 / on-fail=仅异常退出 / on-exit=任何退出）——结束后会向创建它的 agent 会话发一条「后台任务「name」已完成/已结束」消息；notify_mode 控制送达：wakeup（缺省，会话空闲会唤醒一轮，忙碌排入下一步收件箱）／quiet（仅排入收件箱，等用户下一条消息才被模型看到）／always（空闲恒唤醒）。通知不含日志全文，详情用 bgjob_status 查。',
    '长任务交给 bgjob_submit / bgjob_submit_pwsh 而不是前台执行；任务完成时网页顶部弹出 Toast 提示（不注入会话消息）。',
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

// ── PowerShell 解释器解析（bgjob_submit_pwsh 用；测试通过 setShellResolver 替换）──
export function setShellResolver(fn) { shellResolver = fn }
let shellResolver = resolveShellImpl

/** `where.exe <name>` 取第一个命中路径；未命中返回 null。 */
async function whereFirst(name) {
  const r = await spawnRun(['where.exe', name], process.cwd())
  if (r.exitCode !== 0 || !r.stdout) return null
  const line = String(r.stdout).split(/\r?\n/)[0].trim()
  return line || null
}

/**
 * 默认解析顺序：pwsh 7 常见安装路径 → PATH 里的 pwsh → Windows PowerShell 5.1
 * 默认安装路径（Win10/11 恒在）→ PATH 里的 powershell。返回 { exe, engine } 或 null。
 * exe 为绝对路径，提交时烘焙进 run.bat，避免 schtasks 运行上下文 PATH 不一致。
 */
async function resolveShellImpl() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  for (const p of [path.join(pf, 'PowerShell', '7', 'pwsh.exe'), path.join(pf86, 'PowerShell', '7', 'pwsh.exe')]) {
    try { await fsp.access(p); return { exe: p, engine: 'pwsh' } } catch { /* 不存在 */ }
  }
  const pwshPath = await whereFirst('pwsh')
  if (pwshPath) return { exe: pwshPath, engine: 'pwsh' }
  const ps51 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try { await fsp.access(ps51); return { exe: ps51, engine: 'powershell' } } catch { /* 不存在 */ }
  const psPath = await whereFirst('powershell')
  if (psPath) return { exe: psPath, engine: 'powershell' }
  return null
}

/** 解析 PowerShell 解释器；返回 { exe, engine } 或 null（未安装）。 */
export async function resolveShell() {
  return shellResolver()
}

// ── 沙箱 runner 路径解析（bgjob_submit_pwsh 沙箱任务用；测试经 setSandboxRunnerResolver 替换）──
export function setSandboxRunnerResolver(fn) { sandboxRunnerResolver = fn }
let sandboxRunnerResolver = resolveSandboxRunnerImpl
const requireInPlugin = createRequire(import.meta.url)

/**
 * 定位 sandbox-windows-acl 的独立 runner（lib/runner.js）绝对路径：
 *   a. 插件声明的依赖（public npm 0.1.2-alpha.4；koffi 预编译绑定，需插件目录 pnpm install）；
 *   b. 环境变量 BGJOBS_SANDBOX_RUNNER 显式路径（部署/开发机，不写死探测路径）。
 * 都失败返回 null（提交沙箱任务时报错 fail loud）。
 */
async function resolveSandboxRunnerImpl() {
  try {
    return requireInPlugin.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
  } catch (e) { /* 插件未声明依赖，走显式路径 */ }
  const fromEnv = process.env.BGJOBS_SANDBOX_RUNNER
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim())
  return null
}

/** 解析沙箱 runner 路径；null = 不可用。 */
export async function resolveSandboxRunner() {
  return sandboxRunnerResolver()
}

export function apply(ctx) {
  const registry = new Map()

  // ── full access 开关（web 面板 toggle；默认关）。ON = 用户预批准"全权限后台任务"，
  //    受限会话里宽请求（含 bat 引擎默认的全权限）不再逐次弹审批。持久化
  //    $DSH_HOME/bgjobs/fullaccess.json；仅 sandboxPolicy 挂载（会话受限）时才有意义。
  const fullAccessPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'fullaccess.json')
  let fullAccessCache = null
  const readFullAccess = async () => {
    if (fullAccessCache !== null) return fullAccessCache
    try {
      fullAccessCache = JSON.parse(await fsp.readFile(fullAccessPath(), 'utf8')).enabled === true
    } catch (e) { fullAccessCache = false }
    return fullAccessCache
  }
  const setFullAccess = async (enabled) => {
    fullAccessCache = !!enabled
    try {
      const p = fullAccessPath()
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify({ enabled: fullAccessCache }, null, 2), 'utf8')
    } catch (e) { /* 尽力而为 */ }
    return { ok: true, enabled: fullAccessCache }
  }
  /**
   * 会话态：'none'（未挂载 sandboxPolicy 服务）/ 'full'（服务在但 resolve 得
   * danger-full-access，会话全权限）/ 受限模式（read-only/workspace-write）。
   * resolve 失败或返回意外 mode 时 fail-closed 抛错——绝不把受限会话静默当全权限。
   */
  const sessionModeOf = (exec) => {
    const policySvc = ctx.get('sandboxPolicy')
    if (!policySvc) return 'none'
    const session = exec && exec.agent && exec.agent.session
    let pol
    try { pol = policySvc.resolve(session ? { session } : {}) } catch (e) {
      throw new Error('bgjob: sandbox policy resolve failed: ' + errorMsg(e))
    }
    const mode = pol && pol.mode
    if (mode === 'danger-full-access') return 'full'
    if (mode === 'read-only' || mode === 'workspace-write') return mode
    throw new Error('bgjob: unexpected sandbox policy mode: ' + String(mode))
  }
  /**
   * bgjob_submit/bgjob_submit_pwsh 公共判定：默认继承会话模式（pwsh）/恒 off（bat）。
   * 未挂载沙箱服务（state='none'）且 full access 关 → 拒绝（jobSandboxDecision 抛错）；
   * bat 引擎恒全权限、无法沙箱化 → 受限会话仅 full access 模式支持（关则拒绝，不走逐次审批）；
   * pwsh 受限会话更宽请求在 full access 开关关时经 ctx.approval 弹窗审批（镜像 dsh 升权流程）。
   * 返回最终 sandboxMode（'off'|'read-only'|'workspace-write'）——resolved 值，落盘 job.json。
   */
  const decideJobSandbox = async (args, exec, toolName, engine) => {
    const fullAccess = await readFullAccess()
    const state = sessionModeOf(exec)
    const { mode, escalate } = jobSandboxDecision(
      state,
      engine === 'pwsh' ? args.sandbox : undefined,
      engine,
      fullAccess,
    )
    if (escalate) {
      if (!exec || !exec.agent) throw new Error('bgjob sandbox escalation requires an agent session')
      const approval = ctx.get('approval')
      if (!approval) throw new Error('bgjob sandbox escalation requires the approval service, but none is composed')
      const label = mode === 'off' ? 'full access' : mode
      const reason = 'escalate bgjob sandbox to ' + label + ': '
        + (typeof args.justification === 'string' && args.justification.trim().length > 0 ? args.justification : 'background task needs wider filesystem access')
      const outcome = await approval.request({
        agent: exec.agent,
        toolName,
        callId: exec.callId,
        reason,
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      })
      if (outcome !== 'allowed-once') {
        if (outcome === 'rejected') throw new Error('the user rejected escalating this bgjob to "' + label + '"')
        if (outcome === 'cancelled') throw new Error('approval for escalating this bgjob to "' + label + '" was cancelled')
        throw new Error('bgjob sandbox escalation requires approval, but no approval channel is available')
      }
    }
    return mode
  }

  // ── 可选：任务结束后通知创建者（v0.1.31，opt-in notify 参数）────────────
  // v0.1.8 因污染会话流把 host 完成通知整体移除（改 client 半 toast）；本块按任务
  // 显式 notify 配置恢复「会话内通知」：只对创建者会话当前仍 live 的 agent 送达，
  // 拿不到（无 agents 服务/会话已关/跨作用域）静默跳过，client toast 仍兜底。
  const BGJOB_WAKE_BUDGET = 2 // 同 agent 连续被 bgjob 完成通知唤醒的上限（防自激链）
  const wakeSpent = new Map() // sessionId → 连续唤醒次数；用户领走消息后重置
  // 用户主动领走收件箱消息（source.kind === 'user'）→ 模型回到跟用户交互，重置唤醒预算。
  const disposeWokeReset = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    try {
      if (agent && agent.id !== undefined && message && message.source && message.source.kind === 'user') {
        wakeSpent.delete(String(agent.id))
      }
    } catch (e) { /* 事件形状异常不影响主流程 */ }
  })
  /** 通知文案（一行，不含日志全文——详情引导 bgjob_status）。 */
  const noticeText = (job, exitCode) => {
    const label = exitCode === 0 ? '已完成' : '已结束（exit code ' + exitCode + '）'
    return '后台任务「' + job.meta.name + '」' + label
  }
  /** 构造发给创建者 agent 的消息（对齐 UserMessage：id/role/content/source）。 */
  const buildNoticeMessage = (job, exitCode) => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: noticeText(job, exitCode) }],
    source: { kind: 'plugin', plugin: 'bgjobs' },
  })
  /** 按 notify_mode 把完成通知送达创建者会话；尽力而为，绝不抛错破坏任务主流程。 */
  const deliverCompletionNotice = (job) => {
    const sessionId = String(job.meta.createdBySession || '')
    if (!sessionId) return
    const agents = ctx.get('agents')
    if (!agents) return
    let agent
    try { agent = agents.get(sessionId) } catch (e) { return }
    if (!agent) return
    const message = buildNoticeMessage(job, job.exitCode)
    const mode = BGJOB_NOTIFY_DELIVERIES.includes(job.meta.notifyMode) ? job.meta.notifyMode : 'wakeup'
    if (mode === 'quiet') { agent.inject(message); return }
    let idle = false
    try { idle = agent.status === 'idle' } catch (e) { idle = false }
    if (!idle) { agent.inject(message); return }
    // 空闲：wakeup（预算内）与 always 都 followup 唤醒一轮；超预算/quiet 走 inject。
    if (mode === 'wakeup' && (wakeSpent.get(sessionId) || 0) >= BGJOB_WAKE_BUDGET) { agent.inject(message); return }
    if (mode === 'wakeup') wakeSpent.set(sessionId, (wakeSpent.get(sessionId) || 0) + 1)
    agent.followup(message)
  }
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
      // 终态落盘 + 可选通知创建者（v0.1.31）：先落盘 notifiedAt 再送达——
      // 防「done 已写盘但通知未发 → 重启重挂 running → 完成时重复通知」；
      // 送达失败（无 agents/会话已关）不重试，client toast 兜底，与既有尽力而为一致。
      const finalMeta = Object.assign({}, job.meta, { status: 'done', exitCode, finishedAt: job.finishedAt })
      if (shouldNotifyForExit(job.meta.notify, exitCode)) {
        finalMeta.notifiedAt = Date.now()
        job.meta.notifiedAt = finalMeta.notifiedAt
      }
      try {
        await fsp.writeFile(job.meta.jsonPath, JSON.stringify(finalMeta), 'utf8')
      } catch (e) { /* 尽力而为 */ }
      if (finalMeta.notifiedAt !== undefined) {
        try { deliverCompletionNotice(job) } catch (e) { /* 通知尽力而为（toast 兜底） */ }
      }
      // 兜底删除任务计划：bat 正常跑完已自删，这里防 bat 中途退出残留。
      // 只读到 exitcode.txt（bat 最后写入物）才删，不会误删 running 任务。
      // 沙箱任务：runner 已退出并自删其私有 temp，这里清掉提交时创建的临时根。
      if (job.meta.sandboxTempPath) fsp.rm(job.meta.sandboxTempPath, { recursive: true, force: true }).catch(() => {})
      runner([SCHTASKS, '/Delete', '/TN', job.meta.taskName, '/F'], job.meta.workdir).catch(() => {})
    } catch (e) { /* 尚未结束 */ }
  }

  const submitJob = async (jobName, command, workdirRaw, createdBySession, engine = 'bat', sandboxMode = 'off', notify = 'off', notifyMode = 'wakeup') => {
    // notify/notifyMode 防御性归一（schema enum 已挡非法值；程序直调也 fail-soft 到缺省）。
    const notifyOn = BGJOB_NOTIFY_MODES.includes(notify) ? notify : 'off'
    const notifyDelivery = BGJOB_NOTIFY_DELIVERIES.includes(notifyMode) ? notifyMode : 'wakeup'
    const workdir = strip(String(workdirRaw))
    const jobId = 'bg-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36)
    const taskName = 'dsh-bgj-' + jobId
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    const logPath = jobDir + '\\stdout.log'
    const exitcodePath = jobDir + '\\exitcode.txt'
    const jsonPath = jobDir + '\\job.json'
    const batPath = jobDir + '\\run.bat'
    const launchVbsPath = jobDir + '\\launch.vbs'
    const runnerPath = jobDir + '\\run.ps1'
    const cmdPath = jobDir + '\\cmd.bat'
    const wscriptExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\wscript.exe'
    const isPwsh = engine === 'pwsh'
    const sandboxed = sandboxMode !== 'off'
    // 沙箱任务只支持 pwsh 引擎（runner 包装 `解释器 -File job.ps1`；bat 语法经 cmd /c 引号
    // 陷阱多，v1 不接）。此分支对 bgjob_submit(bat) 不可达（决策函数恒给 off）。
    if (sandboxed && !isPwsh) return { ok: false, error: 'sandbox is only supported on the PowerShell engine; submit via bgjob_submit_pwsh' }
    // sandboxTemp：runner 私有临时根（须在 workspace 之外——assertTempRootOutsideWorkspace）。
    let sandboxTemp = ''
    const cleanupDir = () => Promise.all(
      [jobDir, sandboxTemp].filter(Boolean).map((p) => fsp.rm(p, { recursive: true, force: true }).catch(() => {})),
    )
    const deleteTask = () => runner([SCHTASKS, '/Delete', '/TN', taskName, '/F'], workdir)
    try {
      await fsp.mkdir(jobDir, { recursive: true })
    } catch (e) {
      return { ok: false, error: 'create job dir failed: ' + errorMsg(e) }
    }
    // pwsh 引擎：先解析 PowerShell 解释器（提交时烘焙绝对路径进 /TR 与 meta.interpreter）。
    let shell = null
    if (isPwsh) {
      shell = await resolveShell()
      if (shell === null) {
        await cleanupDir()
        return { ok: false, error: 'PowerShell not found: install pwsh (7+) or Windows PowerShell' }
      }
    }
    const meta = {
      id: jobId, name: String(jobName), workdir, taskName, jobDir,
      logPath, exitcodePath, jsonPath, command: String(command),
      createdBySession: String(createdBySession || ''), createdAt: Date.now(), status: 'running',
      sandbox: sandboxMode, // resolved 模式（含 off）落盘：审计 + recover/离线展示无需再推导
      // 完成通知创建者（v0.1.31）：off 省略；on 时落盘触发条件 + 交付方式供 recover/离线只读
      ...(notifyOn !== 'off' ? { notify: notifyOn, notifyMode: notifyDelivery } : {}),
    }
    if (isPwsh) {
      meta.engine = 'pwsh'
      meta.scriptPath = jobDir + '\\job.ps1'
      meta.interpreter = shell.exe
    } else {
      meta.cmdPath = cmdPath
    }
    // 沙箱任务 wiring：解析 runner 绝对路径 + 私有临时根（$DSH_HOME/bgjobs/sandbox/<id>，
    // 位于 workspace 之外）；node 用 DSH 进程同款（koffi 原生绑定 ABI 匹配）。
    if (sandboxed) {
      const sbRunner = await resolveSandboxRunner()
      if (!sbRunner) {
        await cleanupDir()
        return { ok: false, error: 'sandbox requested but runner not found: install @deepseek-ai/dsh-sandbox-windows-acl in the plugin (pnpm install) or set BGJOBS_SANDBOX_RUNNER' }
      }
      sandboxTemp = path.join(resolveBgjobsHome(), 'bgjobs', 'sandbox', jobId)
      try { await fsp.mkdir(sandboxTemp, { recursive: true }) } catch (e) {
        await cleanupDir()
        return { ok: false, error: 'create sandbox temp failed: ' + errorMsg(e) }
      }
      meta.sandboxRunnerPath = sbRunner
      meta.sandboxTempPath = sandboxTemp
      meta.nodeExe = process.execPath
    }
    const job = { id: jobId, meta, status: 'running', exitCode: undefined, pos: 0, tail: '', decoder: new TextDecoder(), watch: undefined, checkTimer: undefined, lastCompletionCheck: 0 }
    try {
      if (isPwsh) {
        // job.ps1 / run.ps1 必须以 UTF-8 with BOM 写入：PowerShell 5.1 解析无 BOM 文件按 ANSI/GBK 读，中文会乱。
        const bom = Buffer.from([0xef, 0xbb, 0xbf])
        await fsp.writeFile(meta.scriptPath, Buffer.concat([bom, Buffer.from(buildPs1(job), 'utf8')]))
        await fsp.writeFile(runnerPath, Buffer.concat([bom, Buffer.from(buildPwshRunner(job), 'utf8')]))
      } else {
        await fsp.writeFile(cmdPath, buildCmdBat(job), 'utf8')
        await fsp.writeFile(batPath, buildBat(job), 'utf8')
        // 隐藏窗口启动器：wscript 以 SW_HIDE 运行 run.bat（bat 引擎零 PowerShell 依赖）
        await fsp.writeFile(launchVbsPath, buildLaunchVbs(), 'utf8')
      }
      await fsp.writeFile(jsonPath, JSON.stringify(meta), 'utf8')
    } catch (e) {
      await cleanupDir()
      return { ok: false, error: 'write job files failed: ' + errorMsg(e) }
    }
    // 沙箱任务：jobDir 授 Everyone 只读——受限子进程（去 Authenticated Users/INTERACTIVE）要读
    // job.ps1/解释器，jobDir 位于用户目录（默认无 Everyone 读）会直接读不到而失败。副作用：
    // job.ps1（用户命令文本）对本地用户可读，README 已注明。
    if (sandboxed) {
      const grant = await runner([ICACLS, jobDir, '/grant', 'Everyone:(OI)(CI)RX', '/T', '/C'], workdir)
      if (grant.exitCode !== 0) {
        await cleanupDir()
        return { ok: false, error: 'icacls grant failed for sandboxed job: ' + grant.stderr + grant.stdout }
      }
    }
    const d = new Date(Date.now() + 60000)
    const st = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
    // /TR 目标：pwsh 引擎直接调解释器执行 run.ps1（-WindowStyle Hidden 隐藏控制台窗口）；
    // bat 引擎经 wscript.exe 执行 launch.vbs（SW_HIDE 隐藏启动 run.bat，零 PowerShell 依赖）。
    // Node spawn 传 argv 数组：/TR 值用普通引号形式（"prog" -args "path"），Node 自会做命令行
    // 转义；PS 侧（Invoke-BgjobsSchtasks 用 Arguments 字符串）需整体引号+内部转义，见
    // dsh-bgjobs-lib.ps1 的 Submit-BgjobsJob（双端此处写法不同，勿强求镜像）。
    const trValue = isPwsh
      ? '"' + shell.exe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + runnerPath + '"'
      : '"' + wscriptExe + '" "' + launchVbsPath + '"'
    const create = await runner([SCHTASKS, '/Create', '/TN', taskName, '/TR', trValue, '/SC', 'ONCE', '/ST', st, '/F'], workdir)
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
    // /Run 已触发执行：立即禁用任务计划，防 /ST（now+60s）整分再触发导致任务双跑。
    // 用 /Change /DISABLE 而非 /Delete：/Run 的实例是异步排队启动的，若紧接着 /Delete，
    // Task Scheduler 会连同注册一起丢弃排队中的运行实例→进程从未启动→永远 running 且无日志。
    // 禁用保留注册（运行实例照常跑完），bat 末尾自删与 done 兜底 /Delete 变无害 no-op。
    await runner([SCHTASKS, '/Change', '/TN', taskName, '/DISABLE'], workdir).catch(() => {})
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
  /** 把磁盘 meta 挂进注册表（done 显示终态；running 继续 startWatch）。 */
  const rehangJob = (meta) => {
    if (!meta || !meta.id || !meta.logPath || registry.has(meta.id)) return
    registry.set(meta.id, {
      id: meta.id, meta,
      status: meta.status === 'done' ? 'done' : 'running',
      exitCode: meta.exitCode, pos: 0, tail: '',
      finishedAt: meta.finishedAt,
      decoder: new TextDecoder(), watch: undefined, checkTimer: undefined, lastCompletionCheck: 0,
    })
    if (meta.status !== 'done') startWatch(registry.get(meta.id))
  }
  const recover = async () => {
    // ① 中央索引（全局）：所有 workdir 的任务都能恢复
    const index = await readBgjobsIndex()
    for (const entry of index.jobs) {
      if (!entry || !entry.id || !entry.jobDir) continue
      try {
        rehangJob(JSON.parse(await fsp.readFile(path.join(entry.jobDir, 'job.json'), 'utf8')))
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
            rehangJob(meta)
            if (registry.has(meta.id)) indexUpsert(registry.get(meta.id))
          } catch (e) { /* 非任务目录 */ }
        }
      }
    }
    return true
  }

  const view = (job) => ({
    id: job.id, name: job.meta.name, status: job.status,
    exitCode: job.exitCode === undefined ? null : job.exitCode,
    logPath: job.meta.logPath, tail: job.tail, workdir: job.meta.workdir,
    sandbox: job.meta.sandbox || 'off',
    // 面板按 finishedAt 判断「清理 24h 前」：done 任务必有；running 为 null。
    finishedAt: job.finishedAt === undefined || job.finishedAt === null ? null : job.finishedAt,
  })

  // bgjob_status 的磁盘回退：内存注册表未命中（典型：DSH 会话重启后旧 id 不再被
  // 追踪，但 schtasks 托管的任务仍在运行）时，从中央索引或工作区扫描定位 jobDir，
  // 实时读 job.json / exitcode.txt / 日志尾部，返回与内存路径同构的结果。
  // 只读查询：绝不调用 schtasks /End//Delete 或 removeJob 等终止逻辑。
  const statusFromDisk = async (jobId) => {
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
        try { workspaces = wsReg.list() } catch (e) { return null }
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
    }
  }

  // bgjob_wait 用快照：注册表命中 → running 时顺手走一次既有 checkCompletion
  //（幂等，负责置 done/写 job.json/通知）；未命中 → statusFromDisk；两者皆无 → null。
  const waitSnapshot = async (jobId) => {
    const job = registry.get(String(jobId))
    if (job) {
      if (job.status === 'running') { try { await checkCompletion(job) } catch { /* 尚未结束 */ } }
      return {
        found: true, done: job.status !== 'running',
        id: job.id, name: String(job.meta.name || job.id),
        status: job.status, exitCode: job.exitCode === undefined || job.exitCode === null ? null : job.exitCode,
        logPath: job.meta.logPath, tail: job.tail.slice(-4000),
        startedAt: Number(job.meta.createdAt) || null,
      }
    }
    const disk = await statusFromDisk(jobId)
    if (disk) return { found: true, done: disk.status === 'done', id: disk.id, name: disk.name, status: disk.status, exitCode: disk.exitCode, logPath: disk.logPath, tail: disk.tail, startedAt: disk.createdAt }
    return null
  }

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
    if (job.meta.sandboxTempPath) await fsp.rm(job.meta.sandboxTempPath, { recursive: true, force: true }).catch(() => {})
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
        writeJson(200, { ok: true, fullAccess: await readFullAccess(), jobs: Array.from(registry.values()).map(view) })
        return
      }
      if (pathname === '/bgjobs/fullaccess') {
        // GET → 当前开关；POST ?enabled=1|0 → 切换（用户预批准全权限后台任务）。
        if (req.method === 'POST') {
          const enabled = url.searchParams.get('enabled')
          if (enabled === null) { writeJson(400, { ok: false, error: 'missing enabled' }); return }
          writeJson(200, await setFullAccess(enabled === '1' || enabled === 'true'))
        } else {
          writeJson(200, { ok: true, enabled: await readFullAccess() })
        }
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
    description: '把命令提交为独立于 DSH 进程的后台任务（schtasks 托管，关 DSH/终端不影响；面板实时输出、退出弹 Toast、可选 notify 通知创建会话）。command 用 bat 语法，多行逐行执行，for 循环变量写 %%i；workdir 须为 DSH 工作区内绝对路径，任务文件在 <workdir>/.dsh/bgjobs/<id>/。bat 引擎任务恒全权限、不可沙箱化：受限会话仅当面板「全权限」开启才可提交；受限后台任务请用 bgjob_submit_pwsh 的 sandbox 参数。',
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
        notify: { type: 'string', enum: BGJOB_NOTIFY_MODES, default: 'off', description: '可选：任务结束后是否通知创建它的 agent 会话。off=不通知（缺省，仅网页 Toast）；on-completion=仅成功（exit 0）时通知；on-fail=仅异常退出（exit≠0）时通知；on-exit=任何退出都通知。' },
        notify_mode: { type: 'string', enum: BGJOB_NOTIFY_DELIVERIES, default: 'wakeup', description: '可选：通知送达方式（仅 notify≠off 时有意义）。wakeup=缺省，会话空闲则唤醒一轮（忙碌时排入下一步收件箱，连续唤醒有预算防自激链）；quiet=仅排入收件箱不唤醒（等用户下一条消息才被模型看到）；always=空闲恒唤醒（无预算）。' },
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
      // bat 引擎不支持沙箱：受限会话里默认请求全权限（off），需用户批准或 full access 开关。
      const mode = await decideJobSandbox(args, exec, 'bgjob_submit', 'bat')
      return submitJob(args.name, args.command, args.workdir, createdBySession, 'bat', mode, args.notify, args.notify_mode)
    },
  })

  const disposeStatus = ctx.tools.register({
    name: 'bgjob_status',
    description: '查询后台任务状态：running/done、exitCode、日志尾部与路径。DSH 重启后旧 id 仍可查（磁盘恢复，任务不丢）。',
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
      const jobId = String(args.jobId)
      const job = registry.get(jobId)
      if (job) {
        return {
          id: job.id, name: job.meta.name, status: job.status,
          exitCode: job.exitCode === undefined ? null : job.exitCode,
          logPath: job.meta.logPath, tail: job.tail.slice(-4000),
        }
      }
      // 内存注册表未命中（典型：DSH 会话重启后旧 id 不再被追踪）：回退磁盘查询。
      // 任务由 schtasks 托管，与 DSH 进程无关，可能仍在运行——绝不终止，只读。
      const fromDisk = await statusFromDisk(jobId)
      if (fromDisk) return fromDisk
      return { error: 'job not found: ' + args.jobId }
    },
  })

  const disposeWait = ctx.tools.register({
    name: 'bgjob_wait',
    description: '等待后台任务结束并立即返回结果（轮询，默认最多 120 秒，可传 timeoutSeconds 覆盖，范围 1–600）。done 后立刻返回退出码与日志尾部，不必用前台 sleep 反复轮询；超时返回 timedOut:true 的当前快照，可再次调用。',
    presentCall: (args) => ({
      card: 'generic',
      title: '等待后台任务',
      kind: 'execute',
      rawInput: args && typeof args.jobId === 'string' ? args.jobId : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string', description: '任务 id（bgjob_submit 返回的 jobId）' },
        timeoutSeconds: { type: 'number', default: 120, description: '最多等待秒数（默认 120，范围 1–600）' },
      },
      required: ['jobId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          exitCode: {},
          logPath: { type: 'string' },
          tail: { type: 'string' },
          timedOut: { type: 'boolean' },
          waitedMs: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const jobId = String(args.jobId)
      const timeoutMs = Math.min(Math.max(Number(args.timeoutSeconds) || 120, 1), 600) * 1000
      const started = Date.now()
      const first = await waitSnapshot(jobId)
      if (!first) return { ok: false, error: 'job not found: ' + jobId }
      if (first.done) {
        return { ok: true, jobId, status: first.status, exitCode: first.exitCode, name: first.name, logPath: first.logPath, tail: first.tail, timedOut: false, waitedMs: 0 }
      }
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      // startedAt 未知（老任务无 createdAt）→ 回退用本次等待起点，退化为下限 250ms 轮询。
      const startedAt = first.startedAt || started
      while (Date.now() - started < timeoutMs) {
        // 间隔与「任务已运行时长」成正比：taskAge * 10%，下限 250ms、上限 1s。
        // 间隔恒 ≤1s，不会超过任务完成窗口；任务越久查询越稀，检测延迟仍 ≤~1s。
        const taskAge = Math.max(0, Date.now() - startedAt)
        await sleep(Math.min(WAIT_POLL_MAX_MS, Math.max(WAIT_POLL_MS, taskAge * WAIT_POLL_RATIO)))
        const s = await waitSnapshot(jobId)
        if (!s) return { ok: true, jobId, status: 'removed', timedOut: false, waitedMs: Date.now() - started }
        if (s.done) {
          return { ok: true, jobId, status: s.status, exitCode: s.exitCode, name: s.name, logPath: s.logPath, tail: s.tail, timedOut: false, waitedMs: Date.now() - started }
        }
      }
      const cur = await waitSnapshot(jobId)
      return { ok: true, jobId, status: cur ? cur.status : 'removed', exitCode: cur ? cur.exitCode : null, tail: cur ? cur.tail : '', timedOut: true, waitedMs: timeoutMs }
    },
  })

  const disposePwshSubmit = ctx.tools.register({
    name: 'bgjob_submit_pwsh',
    description: '把 PowerShell 命令提交为独立后台任务（与 bgjob_submit 同机制，但 command 为 PowerShell 语法，日志 UTF-8 无乱码，exit <code> 语义安全；pwsh 7 优先、5.1 兜底）。workdir 须为 DSH 工作区内绝对路径。可选 sandbox 约束文件效果（read-only/workspace-write），权限不高于当前会话模式，请求更宽需审批或面板「全权限」。',
    presentCall: (args) => ({
      card: 'generic',
      title: '提交 PowerShell 后台任务',
      kind: 'execute',
      rawInput: args && typeof args.name === 'string' ? args.name : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '任务名（显示在监控面板与完成通知里）' },
        command: { type: 'string', description: '要执行的 PowerShell 命令（可多行；PowerShell 语法，如 foreach/管道；exit <code> 安全）' },
        workdir: { type: 'string', description: '工作目录绝对路径（DSH 工作区内）' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'off'], description: '可选：任务沙箱模式（复用 dsh 沙箱，仅约束文件效果：read-only 禁止写、workspace-write 只允许写工作目录+临时区；网络不受限）。缺省继承当前受限会话模式，会话全权限则为 off=全权限；任务权限不得高于会话模式——请求更宽（如受限会话里要 off）且 bgjobs 面板 full access 开关关闭时，会弹窗请用户批准（可提供 justification 说明理由）。未挂载 dsh 沙箱策略服务（sandbox-policy）的部署默认拒绝提交，需在面板打开 full access 开关。' },
        justification: { type: 'string', description: '可选：升权理由（当 sandbox 请求权限高于当前会话模式时展示给用户审批）' },
        notify: { type: 'string', enum: BGJOB_NOTIFY_MODES, default: 'off', description: '可选：任务结束后是否通知创建它的 agent 会话。off=不通知（缺省，仅网页 Toast）；on-completion=仅成功（exit 0）时通知；on-fail=仅异常退出（exit≠0）时通知；on-exit=任何退出都通知。' },
        notify_mode: { type: 'string', enum: BGJOB_NOTIFY_DELIVERIES, default: 'wakeup', description: '可选：通知送达方式（仅 notify≠off 时有意义）。wakeup=缺省，会话空闲则唤醒一轮（忙碌时排入下一步收件箱，连续唤醒有预算防自激链）；quiet=仅排入收件箱不唤醒（等用户下一条消息才被模型看到）；always=空闲恒唤醒（无预算）。' },
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
          interpreter: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const createdBySession = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
      const mode = await decideJobSandbox(args, exec, 'bgjob_submit_pwsh', 'pwsh')
      return submitJob(args.name, args.command, args.workdir, createdBySession, 'pwsh', mode, args.notify, args.notify_mode)
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
    for (const d of [disposeSubmit, disposeStatus, disposeWait, disposePwshSubmit]) { try { d() } catch (e) { /* noop */ } }
    if (typeof disposeWokeReset === 'function') { try { disposeWokeReset() } catch (e) { /* noop */ } }
    if (typeof disposeRoutes === 'function') { try { disposeRoutes() } catch (e) { /* noop */ } }
    try { disposeGuidance() } catch (e) { /* noop */ }
  }
}
