// bgjobs —— 网页侧启动离线 GUI / 资源管理器定位（v0.1.65）。
// DSH 运行中，设置页「打开离线 GUI / 打开所在文件夹」经 host webServer 路由落在此：
//   - 解释器复用 runners.resolveShell()（pwsh7 → PS5.1），可被 setShellResolver 替换；
//   - spawn 由 setGuiSpawn 注入（测试替身），与 runners.setSchtasksRunner 同款模式。
// GUI 脚本以 powershell -WindowStyle Hidden -File 启动（与 tools/dsh-bgjobs-gui.bat 同款），
// 隐藏控制台由脚本自身 ShowWindow 兜底；进程 detach + stdio ignore，宿主退出不影响。

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

function detach(file, args) {
  try {
    const child = guiSpawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return null
  } catch (e) {
    return errorMsg(e)
  }
}

/** 启动离线 GUI（独立进程）。解释器缺失/脚本缺失 → fail loud { ok:false }。 */
export async function launchGui() {
  const info = await guiScriptInfo()
  if (!info.exists) return { ok: false, error: 'gui script not found: ' + info.path }
  const shell = await resolveShell()
  if (shell === null) return { ok: false, error: 'no PowerShell (pwsh/powershell.exe) found to run the GUI' }
  const err = detach(shell.exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', info.path])
  if (err !== null) return { ok: false, error: err }
  return { ok: true, path: info.path, shell: shell.engine }
}

/** 在资源管理器中定位（高亮）GUI 脚本。 */
export async function revealGuiFolder() {
  const info = await guiScriptInfo()
  if (!info.exists) return { ok: false, error: 'gui script not found: ' + info.path }
  const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
  const err = detach(explorer, ['/select,', info.path])
  if (err !== null) return { ok: false, error: err }
  return { ok: true, path: info.path }
}
