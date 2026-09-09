// bgjobs —— 网页侧启动离线 GUI / 打开所在文件夹（v0.1.69）。
//
//   - 打开离线 GUI（v0.1.69 重写）：宿主按「任务计划程序（schtasks）一次性任务」拉起 GUI。
//     实证链：dsh 宿主进程处于 Job Object——用户 dsh 控制台 Ctrl+C 后，连第一方 open-in-app
//     拉起的 VS Code/资源管理器（GUI 子系统、独立控制台）都一并消失 → 任何「宿主 spawn 的
//     子进程」都在该 job 内，Ctrl+C/宿主退出时被 kill-on-close 连带结束；独立新控制台/进程组
//     都逃不掉。唯一可靠出路 = 由 **job 之外的进程**创建 GUI：Task Scheduler 服务创建的进程
//     不属于 dsh 的 job → 与宿主生命周期彻底无关。
//     姿势（复刻 lib/core/jobs.js 的提交模式）：
//       schtasks /Create /TN dsh-bgj-gui /TR "<pwsh> -NoProfile -ExecutionPolicy Bypass
//                   -WindowStyle Hidden -File <gui.ps1>" /SC ONCE /ST now+60s /F
//              → /Run（立即触发）→ /Change /DISABLE（防 /ST 整分双跑；保留注册，运行实例
//                照常跑完——不能紧接 /Delete，会连排队中的实例一起丢弃，见 jobs.js 注释）
//     每次打开 /F 覆盖同名任务，不堆积；GUI 自带单实例 mutex 防多开。
//   - 打开所在文件夹：v0.1.68 的 explorer.exe 直开在用户 Win10 造成「大量 explorer 进程且
//     不弹窗」→ 撤销。回到第一方原语 powershell.exe Invoke-Item（execFile+windowsHide，
//     v0.1.67 形态）；客户端优先走第一方 open-in-app 端点（与 DSH 右上角同链路），失败才
//     回退本宿主 reveal；两者失败均把宿主 error 透出到设置页结果行。
// execFile 可经 setGuiExec 注入（测试替身）。

import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SCHTASKS, runSchtasks, resolveShell } from './runners.js'
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

export function setGuiExec(fn) { guiExec = fn }
let guiExec = (file, args, options, cb) => execFile(file, args, options, cb)

/** 载体脚本内 PowerShell 单引号字面量（路径可能含 '）。 */
function ps1Quote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/** 一次性任务名（固定；每次 /F 覆盖，不与 job 任务 dsh-bgj-bg-* 冲突）。 */
const GUI_TASK = 'dsh-bgj-gui'

/** 启动离线 GUI：Task Scheduler 服务拉起（脱离宿主 job），宿主仅做 /Create + /Run + /DISABLE。 */
export async function launchGui() {
  const info = await guiScriptInfo()
  if (!info.exists) return { ok: false, error: 'gui script not found: ' + info.path }
  const shell = await resolveShell()
  if (shell === null) return { ok: false, error: 'no PowerShell (pwsh/powershell.exe) found to run the GUI' }
  // 同 jobs.js：/ST 取 now+60s 整分；/TR 直接调解释器（Node spawn 对 argv 的引号转义
  // schtasks 可正常还原——jobs 引擎已实证）。-WindowStyle Hidden：任务会话里控制台创建即隐藏。
  const d = new Date(Date.now() + 60000)
  const st = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
  const trValue = '"' + shell.exe + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + info.path + '"'
  const cwd = path.dirname(info.path)
  const create = await runSchtasks([SCHTASKS, '/Create', '/TN', GUI_TASK, '/TR', trValue, '/SC', 'ONCE', '/ST', st, '/F'], cwd)
  if (create.exitCode !== 0) return { ok: false, error: 'schtasks create failed: ' + create.stderr + create.stdout }
  const run = await runSchtasks([SCHTASKS, '/Run', '/TN', GUI_TASK], cwd)
  if (run.exitCode !== 0) return { ok: false, error: 'schtasks run failed: ' + run.stderr + run.stdout }
  // 防 /ST 整分双跑：立即禁用（保留注册；运行实例照常跑完，勿 /Delete 以免丢弃排队实例）。
  await runSchtasks([SCHTASKS, '/Change', '/TN', GUI_TASK, '/DISABLE'], cwd).catch(() => {})
  return { ok: true, path: info.path, shell: shell.engine, launcher: 'schtasks' }
}

/** 打开所在文件夹：第一方目录原语 powershell Invoke-Item（execFile + windowsHide）。 */
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
