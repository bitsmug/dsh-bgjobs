// bgjobs —— 网页侧启动离线 GUI / 打开所在文件夹（v0.1.67）。
// DSH 运行中，设置页动作经 host webServer 路由落在此。两个动作对齐 DSH 第一方
// open-in-app 的机制（DSH 仓库 packages/host/open-in-app/src/resolver.ts 与
// packages/util/native-command），并针对「GUI 是 .ps1（pwsh 控制台程序）」做适配：
//
//   - 打开离线 GUI（第一方 GitHub Desktop 适配器的「载体 CLI 开 GUI」思路，但更进一层）：
//     第一方 launchDetachedApp 用 `detached:true + stdio:'ignore'` 直接 spawn，仅对 GUI
//     子系统 exe 有效；**pwsh（控制台子系统）以 DETACHED_PROCESS 启动会 exit 0 且不执行
//     脚本**（实机验证）。故此处 spawn 一个非 detached 的载体 pwsh（windowsHide 藏载体
//     控制台、env 清洗），由载体执行 `Start-Process -WindowStyle Hidden -File <gui.ps1>`
//     把真正 GUI 以「隐藏控制台 + 独立进程」起出来；载体随即 exit 0（watch 窗内 exit0=
//     成功），GUI 进程重挂系统、与宿主 DSH 生命周期彻底无关（宿主退出不影响）。
//     - 启动姿势用 -EncodedCommand（UTF-16LE base64），彻底规避路径/引号转义。
//     - 失败判据：载体 spawn error / 窗口内非零退出（Start-Process 抛错）→ {ok:false,error}。
//   - 打开所在文件夹：目录打开原语同第一方 path-opener——powershell.exe
//     -NoProfile -Command "Invoke-Item -LiteralPath '<dir>'"（execFile，
//     windowsHide:true）；**不再 spawn explorer /select,**（官方注释：不可靠）。
// spawn / execFile 分别可经 setGuiSpawn / setGuiExec 注入（测试替身）。

import { spawn, execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveShell } from './runners.js'
import { errorMsg } from './util.js'

/** 插件包内离线 GUI 脚本绝对路径（本模块位于 <root>/lib/ → 上一级即包根）。 */
export function guiScriptPath() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  return path.join(root, 'tools', 'dsh-bgjobs-gui.ps1')
}

/** GUI 脚本信息（设置页展示路径 + 存在性）。 */
export async function guiScriptInfo() {
  const p = guiScriptPath()
  let exists = false
  try { await fsp.access(p); exists = true } catch (e) { /* 不存在 */ }
  return { path: p, exists }
}

export function setGuiSpawn(fn) { guiSpawn = fn }
let guiSpawn = (file, args, options) => spawn(file, args, options)

export function setGuiExec(fn) { guiExec = fn }
let guiExec = (file, args, options, cb) => execFile(file, args, options, cb)

// 与 @deepseek-ai/dsh-subprocess 的 scrubbedParentEnv 同规则（本地实现，防泄凭据）：
// 丢弃名字含 KEY/PASSWORD/SECRET/TOKEN 与 DSH_* 前缀的环境变量。
const SENSITIVE_ENV = /(KEY|PASSWORD|SECRET|TOKEN)/i
function scrubEnv(env) {
  const out = {}
  for (const key of Object.keys(env || {})) {
    if (/^DSH_/i.test(key) || SENSITIVE_ENV.test(key)) continue
    out[key] = env[key]
  }
  return out
}

/** 载体脚本内 PowerShell 单引号字面量（路径可能含 '）。 */
function ps1Quote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/** 载体式启动 + 短 watch 窗判活（第一方 launchDetachedApp watch 思路，resolver.ts:74-96）：
 *   - spawn 'error'              → {ok:false}（ENOENT/权限等）
 *   - 窗口内 'exit' code!==0       → {ok:false}（载体失败，如 Start-Process 抛错）
 *   - 'exit' code===0 或超窗仍存活  → {ok:true}
 * 注：**不能传 detached:true**——DETACHED_PROCESS 会让 pwsh（控制台程序）exit 0 且
 * 不执行脚本（实机验证）；真正 GUI 由载体 Start-Process 起出后即与宿主无关。 */
function detachLaunch(file, args, env, watchMs = 1500) {
  return new Promise((resolve) => {
    let child
    try {
      child = guiSpawn(file, args, { stdio: 'ignore', windowsHide: true, env })
    } catch (e) {
      resolve({ ok: false, error: 'spawn failed: ' + errorMsg(e) })
      return
    }
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const settleOk = () => { try { child.unref() } catch { /* 已退出 */ }; finish({ ok: true }) }
    const timer = setTimeout(() => settleOk(), watchMs)
    child.once('error', (e) => finish({ ok: false, error: 'spawn error: ' + errorMsg(e) }))
    child.once('exit', (code) => {
      if (code === 0) settleOk()
      else finish({ ok: false, error: 'launch failed (exit ' + String(code) + ')' })
    })
  })
}

/** 启动离线 GUI：载体 pwsh 经 Start-Process 起出 GUI（隐藏控制台、独立进程）。 */
export async function launchGui() {
  const info = await guiScriptInfo()
  if (!info.exists) return { ok: false, error: 'gui script not found: ' + info.path }
  const shell = await resolveShell()
  if (shell === null) return { ok: false, error: 'no PowerShell (pwsh/powershell.exe) found to run the GUI' }
  // 目标 pwsh 的命令行：-WindowStyle Hidden 让控制台创建即隐藏（GUI 窗口由 gui.ps1 开出，不受影响）。
  const targetCmdline = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + String(info.path).replace(/"/g, '\\"') + '"'
  const cmd =
    'Start-Process -WindowStyle Hidden -FilePath ' + ps1Quote(shell.exe) +
    ' -ArgumentList ' + ps1Quote(targetCmdline) + ' -ErrorAction Stop'
  const encoded = Buffer.from(cmd, 'utf16le').toString('base64')
  const r = await detachLaunch(shell.exe, ['-NoProfile', '-EncodedCommand', encoded], scrubEnv(process.env))
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, path: info.path, shell: shell.engine }
}

/** 打开所在文件夹：目录打开原语同第一方（powershell Invoke-Item -LiteralPath）。 */
export async function revealGuiFolder() {
  const info = await guiScriptInfo()
  if (!info.exists) return { ok: false, error: 'gui script not found: ' + info.path }
  const dir = path.dirname(info.path)
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const literal = ps1Quote(dir)
  return new Promise((resolve) => {
    guiExec(ps, ['-NoProfile', '-Command', 'Invoke-Item -LiteralPath ' + literal], { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) resolve({ ok: false, error: 'open failed: ' + errorMsg(err) + (String(stderr || '').trim() ? ' (' + String(stderr).trim() + ')' : '') })
      else resolve({ ok: true, path: dir })
    })
  })
}
