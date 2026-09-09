// bgjobs —— 网页侧启动离线 GUI / 打开所在文件夹（v0.1.68）。
// DSH 运行中，设置页动作经 host webServer 路由落在此。两个动作对齐 DSH 第一方
// open-in-app 的机制（DSH 仓库 packages/host/open-in-app/src/resolver.ts 与
// packages/util/native-command），并针对「GUI 是 .ps1（pwsh 控制台程序）」做适配：
//
//   - 打开离线 GUI（v0.1.68 重写）：v0.1.67 的 Start-Process 载体虽能起出 GUI，但 GUI pwsh
//     仍与宿主共享控制台会话——实机反馈 dsh 控制台按 Ctrl+C 后 GUI 随之退出（CTRL_C_EVENT
//     会打到附着同一控制台的进程）。v0.1.68 改经 **cmd `start`** 启动：cmd `start` 为控制台
//     程序分配【独立新控制台 + 独立进程组】，Ctrl+C 不再传播到 GUI；GUI 父进程=cmd 拉起的
//     pwsh 自身，独立于宿主生命周期（等价第一方「GUI 子系统进程不挂调用方控制台」的免疫性）。
//     - Node spawn 会把 argv 内嵌引号转义成 \"（cmd 收到反斜杠引号即解析错乱，实机验证：
//       `start "\"\"" ...` 起不来）→ **引号语义放进临时 UTF-8 .cmd 文件**（首行 chcp 65001
//       保非 ASCII 路径），spawn cmd.exe 只带 `/d /c <batch>` 纯 argv；cmd 秒级 exit 0=成功。
//     - pwsh 侧带 -WindowStyle Hidden：新控制台创建即隐藏、无闪烁，WinForms 窗口照常。
//     - 仍**不传 detached:true**（DETACHED_PROCESS 让 pwsh 秒退不执行，见 _开发日志 §56）。
//     - 失败判据：spawn error / watch 窗内非零退出 → {ok:false,error} 透出。
//   - 打开所在文件夹（v0.1.68）：**explorer.exe <目录绝对路径> 直开**（单参数、Node 直
//     spawn GUI 子系统 exe，无 cmd 中间层/引号转义）。实证：powershell Invoke-Item（第一方
//     path-opener 原语）对本机目录静默 exit 0 但**不弹窗**，explorer.exe 直开立即弹窗；
//     与第一方取舍差异见 _开发日志 §57。
// spawn 经 setGuiSpawn 注入（测试替身）。

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
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

/** 载体式启动 + 短 watch 窗判活（第一方 launchDetachedApp watch 思路，resolver.ts:74-96）：
 *   - spawn 'error'              → {ok:false}（ENOENT/权限等）
 *   - 窗口内 'exit' code!==0       → {ok:false}（cmd start 失败）
 *   - 'exit' code===0 或超窗仍存活  → {ok:true}
 * 注：**不能传 detached:true**——DETACHED_PROCESS 会让 pwsh（控制台程序）exit 0 且
 * 不执行脚本（实机验证）；独立新控制台由 cmd `start` 语义提供。 */
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

/** 启动离线 GUI：cmd `start`（批处理承载引号）给 gui.ps1 独立新控制台 + 独立进程组。 */
export async function launchGui() {
  const info = await guiScriptInfo()
  if (!info.exists) return { ok: false, error: 'gui script not found: ' + info.path }
  const shell = await resolveShell()
  if (shell === null) return { ok: false, error: 'no PowerShell (pwsh/powershell.exe) found to run the GUI' }
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  // Node spawn 会把 argv 里的内嵌引号转义成 \"，cmd 无法解析 → 引号语义放进临时 .cmd 文件
  // （文件文本不受 Node 转义影响）。文件按 UTF-8（无 BOM）写，首行 chcp 65001 让批处理
  // 按 UTF-8 解析后续行（非 ASCII 路径安全）；start 为 pwsh 分配独立新控制台。
  const batchPath = path.join(os.tmpdir(), `bgjobs-gui-launch-${process.pid}-${Date.now()}.cmd`)
  const escPct = (s) => String(s).replace(/%/g, '%%')
  const content =
    '@echo off\r\n' +
    'chcp 65001 >nul\r\n' +
    'start "" "' + escPct(shell.exe) + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + escPct(info.path) + '"\r\n'
  try {
    await fsp.writeFile(batchPath, content, 'utf8')
  } catch (e) {
    return { ok: false, error: 'cannot write launcher batch: ' + errorMsg(e) }
  }
  const r = await detachLaunch(cmd, ['/d', '/c', batchPath], scrubEnv(process.env))
  fsp.rm(batchPath, { force: true }).catch(() => { /* 清理失败无害 */ })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, path: info.path, shell: shell.engine, launcher: 'cmd-start' }
}

/** 打开所在文件夹：explorer.exe <目录> 直开（v0.1.68）。
 * 实证：powershell Invoke-Item 对本机目录静默 exit 0 但**不弹窗**（第一方原语在此失效）；
 * explorer.exe 直开立即弹窗。explorer 是单实例 shell：新进程把请求交给已运行的 explorer 后
 * 常以 exit 1 退出（退出码不可靠）→ 判活放宽为「spawn 成功（无 'error'）= ok」，退出码忽略；
 * 路径已先行校验为现存目录。与第一方 open-in-app 取舍差异见 _开发日志 §57。 */
export async function revealGuiFolder() {
  const info = await guiScriptInfo()
  if (!info.exists) return { ok: false, error: 'gui script not found: ' + info.path }
  const dir = path.dirname(info.path)
  const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
  return new Promise((resolve) => {
    let child
    try {
      child = guiSpawn(explorer, [dir], { stdio: 'ignore', windowsHide: true, env: scrubEnv(process.env) })
    } catch (e) {
      resolve({ ok: false, error: 'spawn failed: ' + errorMsg(e) })
      return
    }
    let done = false
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); resolve(result) }
    const ok = () => { try { child.unref() } catch { /* 已退出 */ }; finish({ ok: true, path: dir, via: 'explorer' }) }
    const timer = setTimeout(() => ok(), 1500)
    child.once('error', (e) => finish({ ok: false, error: 'spawn error: ' + errorMsg(e) }))
    child.once('exit', () => ok())
  })
}
