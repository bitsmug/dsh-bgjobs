// bgjobs exec —— 启动策略（docs/spec-launch-strategy.md）：把「目标 argv」包装成计划任务动作。
//
// 缺省 `direct`：动作与加本特性前**逐字相同**（L11）。面板开关「隐藏任务窗口」开启后改用
// `wscript.exe`（GUI 子系统 ⇒ 不创建控制台）跑包内静态启动器 `launch.vbs`，再转发目标 argv。
// 为什么需要它：node.exe 是控制台子系统程序，Win11 把控制台委托给 Windows Terminal 后
// `-WindowStyle Hidden` 对 embedding 窗口无效 ⇒ 任务会弹出可见终端。
//
// ★ L9：启动器是包内**单一静态资产**，不按作业生成副本；jobDir 只放数据。
// ★ L10：开关状态只住 $DSH_HOME/bgjobs/launch.json（见 core/store.js），本模块只消费布尔值。

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { quoteArg, joinArguments, MAX_ACTION_CHARS } from './descriptor.mjs'

/** 包内静态启动器（随 package.json 的 files: ["lib"] 发布）。 */
export const LAUNCHER_SCRIPT = fileURLToPath(new URL('./launch.vbs', import.meta.url))
/** 启动失败时 launch.vbs 写在 jobDir 的文件名（纯诊断用）。 */
export const LAUNCHER_ERROR_FILE = 'launch-error.txt'

/** 固定的 GUI 子系统解释器（绝对路径，不查 PATH —— 同 I6 的精神）。 */
export function wscriptExe() {
  return (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\wscript.exe'
}

/**
 * WSH（cscript/wscript）自己的命令行解析是**纯引号开关**模型：不认 `\"` 转义、不折叠反斜杠，
 * 边界规则只有一条——含空白或为空 ⇒ 用一对引号包住。所以 shim 这一层**不能**复用 MSVCRT 口径的
 * `joinArguments`（它会在引号前翻倍反斜杠，WSH 会原样留给下一个解析器）。
 * ★ 内嵌 `"` 无法经 WSH argv 承载（`\"` 与 `""` 都会被拆词或吞掉）；本插件的 argv 只有
 * 绝对路径与 base64url 描述符，不含 `"`（spec-launch-strategy §4.3）。
 */
export function quoteArgWsh(value) {
  const s = String(value)
  return s.length === 0 || /\s/.test(s) ? '"' + s + '"' : s
}

/** 按 WSH 口径拼 wscript 的命令行参数串。 */
export function joinArgumentsWsh(args) {
  return (Array.isArray(args) ? args : []).map(quoteArgWsh).join(' ')
}

/** 直连策略：目标 argv 原样成为任务动作（rootKind=direct，与旧行为逐字相同）。 */
export const directStrategy = {
  kind: 'direct',
  plan(target) {
    const args = joinArguments(target.args)
    const commandLine = quoteArg(target.execute) + (args.length > 0 ? ' ' + args : '')
    return { execute: target.execute, arguments: args, commandLine, rootKind: 'direct', chars: commandLine.length }
  },
}

/**
 * shim 策略：`wscript.exe //B //Nologo <launch.vbs> <errorDir> <target argv...>`。
 * `//B` 抑制运行时错误弹窗（否则交互桌面上会出现模态框把任务挂死）。
 */
export const wscriptShimStrategy = {
  kind: 'shim',
  plan(target, ctx) {
    const errorDir = String((ctx && ctx.errorDir) || '')
    if (!path.isAbsolute(errorDir)) throw new Error('launch shim requires an absolute errorDir')
    // argv: //B //Nologo <launch.vbs> <errorDir> <target.exe> <target argv...>
    const args = joinArgumentsWsh(['//B', '//Nologo', LAUNCHER_SCRIPT, errorDir, target.execute, ...target.args])
    const commandLine = quoteArg(wscriptExe()) + ' ' + args
    return { execute: wscriptExe(), arguments: args, commandLine, rootKind: 'shim', chars: commandLine.length }
  },
}

/**
 * 单一入口：包装 + **包装后**预算复核（L2 —— 预算口径是整条命令行，不是包装前的）。
 * 超预算抛错（fail-closed，提交期）。
 */
export function planLaunch({ target, strategy, errorDir, budget = MAX_ACTION_CHARS }) {
  const chosen = strategy || directStrategy
  const action = chosen.plan(target, { errorDir })
  if (action.chars > budget) {
    const over = action.chars - budget
    throw new Error('action command line is ' + action.chars + ' chars after launch wrapping ('
      + chosen.kind + '), over the ' + budget + ' budget by ' + over
      + ' (shorten the command or turn off the hidden-window switch)')
  }
  return action
}

// ── WSH 可用性（仅开关开启时探测；不改变任务语义，只决定 shim 还是降级 direct）──────────

function regDword(key, name) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const m = new RegExp(name + '\\s+REG_DWORD\\s+(0x[0-9a-f]+|\\d+)', 'i').exec(String(out))
    return m ? Number(m[1]) : null
  } catch (e) { return null }
}

function probeWshDisabled() {
  const settings = '\\SOFTWARE\\Microsoft\\Windows Script Host\\Settings'
  const hkcu = regDword('HKCU' + settings, 'Enabled')
  const hklm = hkcu === null ? regDword('HKLM' + settings, 'Enabled') : null
  const enabled = hkcu !== null ? hkcu : hklm
  if (enabled === 0) return true
  return regDword('HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows Script Host', 'DisableWindowsScriptHost') === 1
    || regDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Script Host', 'DisableWindowsScriptHost') === 1
}

let wshProbe = probeWshDisabled
let wshDisabledCache = null

/** 测试注入缝（与 runners.js 的 setSchtasksRunner 同款）。 */
export function setWshProbe(fn) {
  wshProbe = typeof fn === 'function' ? fn : probeWshDisabled
  wshDisabledCache = null
}

/** Windows Script Host 是否被禁用（提交期读一次并缓存；失败 ⇒ false，照常尝试 shim）。 */
export function isWshDisabled() {
  if (wshDisabledCache === null) {
    try { wshDisabledCache = wshProbe() === true } catch (e) { wshDisabledCache = false }
  }
  return wshDisabledCache
}

/** 读取启动失败的诊断文件（不存在/空 ⇒ null）。只有 launch.vbs 的 Run 抛错时才写。 */
export async function readLaunchError(jobDir) {
  try {
    const text = await fsp.readFile(path.join(String(jobDir), LAUNCHER_ERROR_FILE), 'utf8')
    const first = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
    return first || null
  } catch (e) { return null }
}
