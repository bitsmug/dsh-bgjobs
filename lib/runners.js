// bgjobs —— schtasks / PowerShell / 沙箱 runner 执行层（v0.1.61 结构重构自 lib/index.js 拆分）。
// 可测试替身：setSchtasksRunner / setShellResolver / setSandboxRunnerResolver 供测试替换；
// 其余成员经 runSchtasks / resolveShell / resolveSandboxRunner 间接访问当前实现。

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { errorMsg } from './util.js'

const SPAWN_TIMEOUT_MS = 30000
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
 * 默认解析：**真 node** 优先——`process.execPath` 的文件名是 node/node.exe 时直接用
 * （= DSH 进程同款 node，koffi 原生绑定 ABI 匹配，docs/developer.md「runner 获取与任务 wiring」）；
 * 否则（桌面版 DSH：Electron GUI 子系统 exe）回退 `where.exe node`。
 * 返回绝对路径或 null（未安装 → 调用方 fail loud）。
 */
async function resolveNodeExeImpl(workdir) {
  const exe = process.execPath || ''
  const base = path.basename(exe).toLowerCase()
  if (base === 'node' || base === 'node.exe') return exe
  const r = await runSchtasks(['where.exe', 'node'], workdir)
  if (r.exitCode === 0 && r.stdout) {
    const line = String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (line) return line
  }
  return null
}

/** 解析 Node 解释器绝对路径；null = 不可用。 */
export async function resolveNodeExe(workdir) {
  return nodeExeResolver(workdir)
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
