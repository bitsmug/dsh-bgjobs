// bgjobs —— 网页侧启动离线 GUI / 资源管理器定位（v0.1.66）。
// DSH 运行中，设置页「打开离线 GUI / 打开所在文件夹」经 host webServer 路由落在此：
//   - 解释器复用 runners.resolveShell()（pwsh7 → PS5.1），可被 setShellResolver 替换；
//   - spawn 由 setGuiSpawn 注入（测试替身），与 runners.setSchtasksRunner 同款模式。
// GUI 脚本以 powershell -WindowStyle Hidden -File 启动（与 tools/dsh-bgjobs-gui.bat 同款），
// 隐藏控制台由脚本自身 ShowWindow 兜底；进程 detach + stdio ignore，宿主退出不影响。
// v0.1.66：等待 'spawn' 事件确认真正拉起（ENOENT/权限等启动错误 → ok:false+error）；
// reveal 用单参数 `/select,<file>`（explorer 官方形态，双参不可靠）。

import { spawn } from 'node:child_process'
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

/**
 * detached 启动一个进程并 unref。等 'spawn' 事件确认已拉起；
 * 启动前即失败（ENOENT/权限等 'error'）→ { ok:false, error }。
 */
function detach(file, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = guiSpawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (e) {
      resolve({ ok: false, error: 'spawn failed: ' + errorMsg(e) })
      return
    }
    const onError = (e) => { resolve({ ok: false, error: 'spawn error: ' + errorMsg(e) }) }
    const onSpawn = () => { try { child.unref() } catch { /* 已退出 */ }; resolve({ ok: true }) }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
}

/** 启动离线 GUI（独立进程）。解释器缺失/脚本缺失/启动失败 → fail loud { ok:false, error }。 */
export async function launchGui() {
  const info = await guiScriptInfo()
  if (!info.exists) return { ok: false, error: 'gui script not found: ' + info.path }
  const shell = await resolveShell()
  if (shell === null) return { ok: false, error: 'no PowerShell (pwsh/powershell.exe) found to run the GUI' }
  const r = await detach(shell.exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', info.path])
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, path: info.path, shell: shell.engine }
}

/** 在资源管理器中定位 GUI 脚本（单参数 `/select,<file>` 形态）。 */
export async function revealGuiFolder() {
  const info = await guiScriptInfo()
  if (!info.exists) return { ok: false, error: 'gui script not found: ' + info.path }
  const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
  const r = await detach(explorer, ['/select,' + info.path])
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, path: info.path }
}
