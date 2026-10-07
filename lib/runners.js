// bgjobs —— schtasks / PowerShell / 沙箱 runner 执行层（v0.1.61 结构重构自 lib/index.js 拆分）。
// 可测试替身：setSchtasksRunner / setShellResolver / setSandboxRunnerResolver 供测试替换；
// 其余成员经 runSchtasks / resolveShell / resolveSandboxRunner 间接访问当前实现。

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { errorMsg } from './util.js'

const SPAWN_TIMEOUT_MS = 30000
/** `node --version` 探测的短超时（v0.1.91）：只为诊断落盘，慢/挂死一律放弃，绝拖慢提交。 */
const NODE_VERSION_TIMEOUT_MS = 3000
const SCHTASKS = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\schtasks.exe'
const ICACLS = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\icacls.exe'

export { SCHTASKS, ICACLS }

/** 执行一次 schtasks 调用；测试通过 setSchtasksRunner 替换。 */
export function setSchtasksRunner(fn) { runner = fn }
let runner = (argv, cwd) => spawnRun(argv, cwd)

/** 走当前 runner 执行一次计划任务命令（schtasks/icacls 等）。 */
export function runSchtasks(argv, cwd) { return runner(argv, cwd) }

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

// ── Node 解释器解析（沙箱 runner / mcp 引擎用；测试经 setNodeExeResolver 替换）──
export function setNodeExeResolver(fn) { nodeExeResolver = fn }
let nodeExeResolver = resolveNodeExeImpl

/**
 * 测试注入缝：`node --version` 探测（v0.1.91）。生产缺省真跑一次解释器；
 * 测试可注入合成结果，避免依赖本机真有可执行的 node.exe。
 * ★ `setNodeVersionProber(null)` = 恢复生产实现（测试里先置桩、个别用例再取回真探测）。
 */
export function setNodeVersionProber(fn) { nodeVersionProber = fn || probeNodeVersionImpl }
let nodeVersionProber = probeNodeVersionImpl

/**
 * 测试注入缝：解析器读取的「搜索上下文」（execPath / env / resourcesPath）。
 * 生产缺省直接取 process.*；测试可注入合成上下文，逐层驱动兜底探测。
 */
export function setNodeSearchContext(fn) { nodeSearchContext = fn }
let nodeSearchContext = () => ({
  execPath: process.execPath || '',
  env: process.env,
  resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
})

/** 桌面版自带 node 的已知相对布局：<install>\resources\runtime\...\dependencies\node\bin\node.exe */
const DESKTOP_BUNDLED_NODE_RELATIVE = [
  path.join('runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  path.join('runtime', 'dependencies', 'node', 'bin', 'node.exe'),
]
/** 兜底扫描（目录布局变化时）上限：深度与访问条目数，避免在安装目录里做无界遍历。 */
const DESKTOP_NODE_SCAN_MAX_DEPTH = 5
const DESKTOP_NODE_SCAN_MAX_ENTRIES = 500

/**
 * 候选 exe 能否当沙箱 runner 的解释器：文件名必须是 `node.exe` **且** PE 子系统 = 3（console）。
 * 这是 issues #1 的防线——GUI 子系统 exe 的 stdout 重定向到文件会静默秒退（假成功）。
 * ★ 桌面版兜底层是 Windows 专用（沙箱 runner 本身即 windows-acl），故只认 `node.exe`：
 *   这条同时挡掉 `<install>\resources\runtime\bin\node`——那是非 PE 的 shim（`#!/bin/sh` 或 0 字节），
 *   双保险（文件名不是 node.exe，且 peSubsystem 也不是 3），且无扩展名路径 CreateProcess 也跑不起来。
 */
async function asConsoleNodeExe(candidate) {
  if (typeof candidate !== 'string') return null
  const exePath = candidate.trim()
  if (exePath.length === 0) return null
  if (path.basename(exePath).toLowerCase() !== 'node.exe') return null
  return (await peSubsystem(exePath)) === 3 ? exePath : null
}

/** 在 root 下限定深度/条目数广度优先搜 node.exe（只认 PE 子系统 = 3 的）。 */
async function scanForConsoleNodeExe(root) {
  if (typeof root !== 'string' || root.length === 0) return null
  const queue = [{ dir: root, depth: 0 }]
  let seen = 0
  while (queue.length > 0) {
    const current = queue.shift()
    let entries
    try { entries = await fsp.readdir(current.dir, { withFileTypes: true }) } catch (e) { continue }
    for (const entry of entries) {
      if (++seen > DESKTOP_NODE_SCAN_MAX_ENTRIES) return null
      const full = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < DESKTOP_NODE_SCAN_MAX_DEPTH) queue.push({ dir: full, depth: current.depth + 1 })
      } else if (entry.isFile() && entry.name.toLowerCase() === 'node.exe') {
        const hit = await asConsoleNodeExe(full)
        if (hit !== null) return hit
      }
    }
  }
  return null
}

/**
 * 桌面版兜底探测（v0.1.91）：**只装桌面版 DSH**（机器上没有独立 node、PATH 上也没有）时，
 * `where.exe node` 会落空——但桌面版自带一个真 node（实机实测 v24.21.0、PE = 3）。
 * 按优先级探测，三层都要求 PE 子系统 = 3：
 *   (a) `process.env.DSH_DESKTOP_NODE_EXECUTABLE`——桌面版 runtime 的 node.cmd 引用的变量；
 *       ★ 实机实测该变量在运行时可能为空 ⇒ 只当加分项，不能只靠它；
 *   (b) `<process.resourcesPath>` 下的已知布局（Electron 保证 resourcesPath 存在）；
 *   (c) `<process.resourcesPath>\runtime` 下限定深度/条目数扫描 node.exe（布局变化兜底）。
 * 命中返回 `{ exe, source }`；全落空返回 null ⇒ 调用方 fail-closed（**绝不**退回 GUI 子系统的 execPath）。
 */
async function resolveDesktopBundledNode(ctx) {
  const fromEnv = await asConsoleNodeExe(ctx.env ? ctx.env.DSH_DESKTOP_NODE_EXECUTABLE : undefined)
  if (fromEnv !== null) return { exe: fromEnv, source: 'desktop-env' }
  const resourcesPath = ctx.resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    for (const rel of DESKTOP_BUNDLED_NODE_RELATIVE) {
      const hit = await asConsoleNodeExe(path.join(resourcesPath, rel))
      if (hit !== null) return { exe: hit, source: 'desktop-bundled' }
    }
    const scanned = await scanForConsoleNodeExe(path.join(resourcesPath, 'runtime'))
    if (scanned !== null) return { exe: scanned, source: 'desktop-bundled' }
  }
  return null
}

/** `where.exe node` 命中结果也走 asConsoleNodeExe 校验；被拒或落空返回 null。 */
async function whereConsoleNodeExe(workdir) {
  const r = await runSchtasks(['where.exe', 'node'], workdir)
  if (r.exitCode !== 0 || !r.stdout) return null
  const line = String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  if (!line) return null
  return asConsoleNodeExe(line)
}

/**
 * 默认解析（v0.1.91 重排优先级，docs/developer.md「runner 获取与任务 wiring」）。逐层：
 *   ① `basename` 快路径——`execPath` 的文件名是 node/node.exe ⇒ 直接用（= DSH 进程同款 node）；
 *   ② `DSH_DESKTOP_NODE_EXECUTABLE`（桌面版 runtime 引用的变量，运行时可能为空）；
 *   ③ `<process.resourcesPath>` 按已知布局取桌面版自带 node（含限深扫描兜底）；
 *   ④ `where.exe node`——**降为最后手段**；
 *   ⑤ 全落空 ⇒ `null`（调用方 fail-closed，**绝不**退回 GUI 子系统的 execPath）。
 *
 * ★ ①②③ 的共同点是"**与 DSH 运行时同源**"：都是 DSH 自己那份 node，保 koffi 原生绑定的
 *   N-API ABI 匹配。★ ④ 命中的是**这台机器上任意的**一份 node（PATH 顺序决定），可能是别的
 *   版本、别的发行版，甚至 `resources\runtime\bin\node` 那个 `#!/bin/sh` shim（非 PE，spawn 直接
 *   失败）——所以它必须排在最后，且命中结果同样要过 asConsoleNodeExe（名 node.exe + PE = 3）。
 * 返回 `{ exe, source } | null`；source ∈ 'basename' | 'desktop-env' | 'desktop-bundled' | 'where'。
 */
async function resolveNodeExeImpl(workdir) {
  const ctx = nodeSearchContext() || {}
  const execPath = typeof ctx.execPath === 'string' ? ctx.execPath : (process.execPath || '')
  const base = path.basename(execPath).toLowerCase()
  if (base === 'node' || base === 'node.exe') return { exe: execPath, source: 'basename' }
  const bundled = await resolveDesktopBundledNode(ctx)
  if (bundled !== null) return bundled
  const whereHit = await whereConsoleNodeExe(workdir)
  if (whereHit !== null) return { exe: whereHit, source: 'where' }
  return null
}

/** 归一解析器返回值：兼容测试注入缝 setNodeExeResolver 直接返回路径字符串的旧写法。 */
function normalizeNodeChoice(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') return raw.length > 0 ? { exe: raw, source: 'injected' } : null
  if (typeof raw === 'object' && typeof raw.exe === 'string' && raw.exe.length > 0) {
    return { exe: raw.exe, source: typeof raw.source === 'string' ? raw.source : 'injected' }
  }
  return null
}

/** 解析 Node 解释器：返回 `{ exe, source } | null`（source 标明取自哪一层，便于事后诊断）。 */
export async function resolveNodeExeInfo(workdir) {
  return normalizeNodeChoice(await nodeExeResolver(workdir))
}

/** 解析 Node 解释器绝对路径；null = 不可用。 */
export async function resolveNodeExe(workdir) {
  const choice = await resolveNodeExeInfo(workdir)
  return choice === null ? null : choice.exe
}

/** 从 `node --version` 输出里取版本号（`v24.21.0` / `24.21.0` 都归一成 `24.21.0`）；认不出返回 null。 */
export function parseNodeVersion(output) {
  if (typeof output !== 'string') return null
  const match = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output.trim())
  return match === null ? null : match[1]
}

/**
 * 跑一次 `node --version`（短超时）取版本号；任何失败/超时/认不出 ⇒ null。
 * ★ 只为诊断落盘（job.json 的 meta.nodeExeVersion），**绝不阻断提交**。
 */
async function probeNodeVersionImpl(nodeExe) {
  if (typeof nodeExe !== 'string' || nodeExe.length === 0) return null
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(nodeExe, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve(null)
      return
    }
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(null)
    }, NODE_VERSION_TIMEOUT_MS)
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.on('error', () => finish(null))
    child.on('close', () => finish(parseNodeVersion(out)))
  })
}

/** 探测所选 node 的版本号；失败/超时 ⇒ null（测试经 setNodeVersionProber 替换）。 */
export async function probeNodeVersion(nodeExe) {
  try { return await nodeVersionProber(nodeExe) } catch (e) { return null }
}

/** PE Optional Header 的 Subsystem 字段偏移（PE32 与 PE32+ 同）：2=GUI、3=console。 */
const PE_SUBSYSTEM_OFFSET = 24 + 68
/**
 * 读 PE 映像的子系统（`2`=GUI / `3`=console）；非 PE、读不到、越界一律返回 null。
 * 调用方据此"只拒确证是 GUI 的"（null → 放行，宁可放过不可误杀）。
 */
export async function peSubsystem(exePath) {
  let bytes
  try { bytes = await fsp.readFile(exePath) } catch (e) { return null }
  try {
    if (bytes.length < 0x40) return null
    const peOffset = bytes.readUInt32LE(0x3c)
    if (peOffset + PE_SUBSYSTEM_OFFSET + 2 > bytes.length) return null
    if (bytes.readUInt32LE(peOffset) !== 0x00004550) return null // 'PE\0\0'
    return bytes.readUInt16LE(peOffset + PE_SUBSYSTEM_OFFSET)
  } catch (e) { return null }
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
