// bgjobs exec —— 链首薄主机（spec v7 §4.1 / §4.4）。
//
// 任务定义固定为：`<node.exe> "<host.mjs>" "<jobDir>" "<descriptor>"`。host 只做四件事：
// 解码+校验描述符 → 打开日志（stdout+stderr 合并）与写 pid → 起一个子进程 → 收尾记账。
// 它**从不**读取工作区里的任何脚本/配置（I1/I2），也绝不把校验失败降级成"未沙箱执行"（I5）。
//
// 关键约束：
//   - I12：受限令牌下不能创建管道 ⇒ 子进程 stdio 必须是文件句柄 `['ignore', fd, fd]`；
//   - I11：只有 host 自身预执行校验失败才写 exitcode.txt=1；子进程被系统杀掉（拿不到退出码）
//     时**不写**，让"进程消失"可区分；
//   - I3：沙箱 argv 来自提交期 provider `confine()`，host 不重新拼装。

import { promises as fsp } from 'node:fs'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseDescriptor } from './descriptor.mjs'
import { buildPwshEnvelope, buildPwshDelivery } from './envelope.mjs'
import { deleteScheduledTask, taskNameOf } from './task.mjs'
import { decodeAutoText, LOG_FORMAT_FILE, LOG_FORMAT_UTF8, writeFileAtomic } from '../util.js'

const requireInPlugin = createRequire(import.meta.url)

const msgOf = (e) => (e && e.message) || String(e)

/** 固定候选序列（I6：不做 PATH 搜索、不接受描述符指定任意 exe）。 */
export function resolveInterpreter(engine) {
  const root = process.env.SystemRoot || 'C:\\Windows'
  if (engine === 'bat') {
    const cmd = path.join(root, 'System32', 'cmd.exe')
    return fs.existsSync(cmd) ? cmd : null
  }
  const programFiles = [...new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean))]
  const candidates = []
  for (const dir of programFiles) {
    candidates.push(path.join(dir, 'PowerShell', '7', 'pwsh.exe'))
    candidates.push(path.join(dir, 'PowerShell', '7-preview', 'pwsh.exe'))
  }
  candidates.push(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 沙箱 runner 绝对路径（插件依赖优先；BGJOBS_SANDBOX_RUNNER 兜底）。 */
export function resolveSandboxRunner() {
  try {
    return requireInPlugin.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
  } catch (e) { /* 未安装，走显式路径 */ }
  const fromEnv = process.env.BGJOBS_SANDBOX_RUNNER
  return fromEnv !== undefined && fromEnv.trim().length > 0 ? path.resolve(fromEnv.trim()) : null
}

/**
 * 描述符 → 子进程计划。纯函数（仅查文件是否存在），导出以便单测。
 * 返回 `{ execute, args, kind }`；任何不支持的分支都抛错（fail-closed）。
 */
export function planForDescriptor(d) {
  if (d.m === 'sandbox' && d.b === 'dsh') {
    return { execute: d.a[0], args: d.a.slice(1), kind: 'dsh', interpreter: d.a[0] }
  }
  if (d.e === 'bat') {
    throw new Error('engine bat is not supported by the descriptor chain yet')
  }
  const interpreter = resolveInterpreter(d.e)
  if (interpreter === null) throw new Error('no supported interpreter found for engine "' + d.e + '"')
  const envelope = buildPwshEnvelope(d.c, { encoding: d.o, interpreter })
  const delivery = buildPwshDelivery({ interpreter, envelope })
  if (d.m === 'direct') {
    return { execute: delivery[0], args: delivery.slice(1), kind: 'direct', interpreter }
  }
  const runner = resolveSandboxRunner()
  if (runner === null) throw new Error('sandbox runner not found: install @deepseek-ai/dsh-sandbox-windows-acl or set BGJOBS_SANDBOX_RUNNER')
  if (!d.t) throw new Error('sandbox_backend=acl requires a temp root ("t")')
  return {
    execute: process.execPath,
    args: [runner, '--workspace', d.w, '--temp', d.t, '--mode', d.p, '--', ...delivery],
    kind: 'acl',
    interpreter,
  }
}

async function appendHostError(jobDir, message) {
  const line = '[bgjobs-host] ' + message + '\r\n'
  try {
    if (jobDir) await fsp.appendFile(path.join(jobDir, 'host-error.log'), line, 'utf8')
    else await fsp.appendFile(path.join(os.tmpdir(), 'bgjobs-host-error.log'), line, 'utf8')
  } catch (e) { /* 尽力而为 */ }
}

async function writeExitCode(jobDir, code) {
  try {
    // v16：原子发布 —— exitcode.txt 一旦可见即内容完整（读取端不再需要轮询重试）。
    if (jobDir) await writeFileAtomic(path.join(jobDir, 'exitcode.txt'), String(code))
  } catch (e) { /* 尽力而为 */ }
}

/** 校验描述符与运行环境；返回 null（通过）或错误文本。 */
function verifyDescriptor(d, jobDir) {
  if (d.id !== path.basename(jobDir)) return 'descriptor id does not match job dir basename'
  let stat
  try { stat = fs.statSync(d.w) } catch (e) { return 'workdir does not exist: ' + d.w }
  if (!stat.isDirectory()) return 'workdir is not a directory: ' + d.w
  if (d.a !== undefined && !fs.existsSync(d.a[0])) return 'sandbox executable does not exist: ' + d.a[0]
  if (d.t !== undefined && !fs.existsSync(d.t)) return 'sandbox temp root does not exist: ' + d.t
  return null
}

/**
 * host 主体。返回进程退出码（0 = 命令成功；非 0 = 命令失败或 host 自身失败）。
 * 任何异常都走 fail-closed：写 exitcode=1 + host-error.log，绝不执行未校验的命令。
 */
export async function runHost(argv) {
  const jobDir = argv && argv[0] ? path.resolve(String(argv[0])) : ''
  const descriptorText = argv && argv[1] ? String(argv[1]) : ''
  if (!jobDir) {
    await appendHostError('', 'missing jobDir argument')
    return 2
  }
  let descriptor
  try {
    if (!descriptorText) throw new Error('missing descriptor argument')
    descriptor = parseDescriptor(descriptorText)
  } catch (e) {
    await appendHostError(jobDir, 'descriptor rejected: ' + msgOf(e))
    await writeExitCode(jobDir, 1)
    await deleteScheduledTask(taskNameOf(path.basename(jobDir)), jobDir)
    return 1
  }
  const invalid = verifyDescriptor(descriptor, jobDir)
  let plan
  if (invalid === null) {
    try {
      plan = planForDescriptor(descriptor)
    } catch (e) {
      await appendHostError(jobDir, 'plan rejected: ' + msgOf(e))
      await writeExitCode(jobDir, 1)
      await deleteScheduledTask(taskNameOf(descriptor.id), jobDir)
      return 1
    }
  } else {
    await appendHostError(jobDir, 'descriptor rejected: ' + invalid)
    await writeExitCode(jobDir, 1)
    await deleteScheduledTask(taskNameOf(descriptor.id), jobDir)
    return 1
  }

  // stdout.log：启动时 truncate → append 打开；同一 fd 同时给 stdout/stderr（§4.2 / I12）。
  const logPath = path.join(jobDir, 'stdout.log')
  let handle = null
  try {
    await fsp.writeFile(logPath, '')
    handle = await fsp.open(logPath, 'a')
    const stat = await handle.stat()
    if (stat.nlink !== 1) throw new Error('stdout.log has ' + stat.nlink + ' hard links; refusing to write')
  } catch (e) {
    if (handle) await handle.close().catch(() => {})
    await appendHostError(jobDir, 'open log failed: ' + msgOf(e))
    await writeExitCode(jobDir, 1)
    await deleteScheduledTask(taskNameOf(descriptor.id), jobDir)
    return 1
  }

  const fd = handle.fd
  // run.pid = host 自身 = 任务根（kill-tree 的树根；命令行含 jobDir 通过所有权门禁）。
  try {
    await fsp.writeFile(path.join(jobDir, 'run.pid'), String(process.pid), 'utf8')
  } catch (e) { /* pid 写失败不拦命令（与旧 run.ps1 同语义） */ }
  try {
    await handle.appendFile('[BGJOB] interpreter: ' + plan.interpreter + ' (' + plan.kind + ')\r\n')
  } catch (e) { /* 日志提示尽力而为 */ }

  const outcome = await new Promise((resolve) => {
    let child
    try {
      child = spawn(plan.execute, plan.args, {
        cwd: descriptor.w,
        env: process.env,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
    } catch (e) {
      resolve({ error: e })
      return
    }
    child.on('error', (e) => resolve({ error: e }))
    child.on('close', (code) => resolve({ code }))
  })

  await handle.close().catch(() => {})

  // auto 收尾（v11，§4.4 第 7 步）：把 28591 成像段还原成干净 UTF-8 再写 exitcode，
  // 与旧 run.ps1 的收尾块同一口径（decodeAutoText 幂等）。必须在写 exitcode 之前 ——
  // 面板/registry 见到退出码时日志已可读。失败不拦任务：读取端仍会兜底解码。
  if (descriptor.o === 'auto') await finalizeAutoLog(logPath)

  if (outcome.error !== undefined) {
    await appendHostError(jobDir, 'spawn failed: ' + msgOf(outcome.error))
    await writeExitCode(jobDir, 1)
  } else if (typeof outcome.code === 'number') {
    // I11：拿到退出码才写；拿不到（进程消失）保持缺失。
    await writeExitCode(jobDir, outcome.code)
  }
  await deleteScheduledTask(taskNameOf(descriptor.id), jobDir)
  return outcome.error !== undefined ? 1 : (typeof outcome.code === 'number' ? outcome.code : 1)
}

/**
 * auto 日志收尾：成像文本 → 干净 UTF-8（幂等；已干净时零改写）。
 * 导出以便单测；运行期只在 `o === 'auto'` 且子进程已退出后调用。
 */
export async function finalizeAutoLog(logPath) {
  try {
    const text = await fsp.readFile(logPath, 'utf8')
    const decoded = decodeAutoText(text)
    if (decoded !== text) await fsp.writeFile(logPath, decoded, 'utf8')
    // v13：落"日志已是干净 UTF-8"标记（早于 exitcode）。读取端据此跳过 decodeAutoText，
    // 避免把 `°±·` 这类纯 Latin-1 文本误判成成像段还原成乱码。标记写失败不拦任务（读取端仍兜底）。
    await writeFileAtomic(path.join(path.dirname(logPath), LOG_FORMAT_FILE), LOG_FORMAT_UTF8)
  } catch (e) { /* 收尾尽力而为：失败保持成像，读取端 decodeAutoText 兜底 */ }
}

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  } catch (e) {
    return false
  }
})()

if (isMain) {
  runHost(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }).catch(async (e) => {
    await appendHostError(process.argv[2] ? path.resolve(String(process.argv[2])) : '', 'host crashed: ' + msgOf(e))
    process.exitCode = 1
  })
}
