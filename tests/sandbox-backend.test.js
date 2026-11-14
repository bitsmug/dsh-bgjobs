// bgjobs tests —— 沙箱后端选择（实验开关 + sandbox_backend='dsh'；Plan A）。
// 纪律（本方案的核心护栏）：开关关闭 ⇒ 老路径（内置 ACL runner）**逐字不变**；
// 开关关闭 + 'dsh' ⇒ fail loud 且**零副作用**（不建 jobDir / 不建计划任务 / 不写盘）。
// ★ 未覆盖（环境级，不属本单测）：真 dsh provider 下的端到端沙箱行为、以及
//   "提交后退出 DSH，任务照常跑完" 的生命周期验收 —— 需真机跑（见 docs/developer.md）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  apply, setSchtasksRunner, setShellResolver, setSandboxRunnerResolver, psQuote, psQuoteArgv,
  buildPwshEnvelope, buildEnvPrefix,
} from '../lib/index.js'
import { DSH_BACKEND_DISABLED_ERROR } from '../lib/core/store.js'
import {
  makeWorkdir, makeCtx, makeFakeRunner, restrictedPolicy, installSuiteHooks, captureTaskAction,
} from './helpers/common.js'

installSuiteHooks()

/** 写沙箱后端开关（<DSH_HOME>/bgjobs/sandbox-backends.json）。 */
async function setSandboxBackendsEnabled(enabled) {
  await fsp.mkdir(path.join(process.env.DSH_HOME, 'bgjobs'), { recursive: true })
  await fsp.writeFile(
    path.join(process.env.DSH_HOME, 'bgjobs', 'sandbox-backends.json'),
    JSON.stringify({ enabled }), 'utf8',
  )
}

const SHELL = { exe: 'X:\\pwsh\\pwsh.exe', engine: 'pwsh' }
const ACL_RUNNER = 'X:\\runner\\runner.js'

function servicesFor(workdir, extra) {
  return Object.assign(restrictedPolicy(workdir), extra)
}

function findSubmit(tools) {
  return tools.find((t) => t.name === 'bgjob_submit')
}

function jobDirOf(workdir, jobId) {
  return path.join(workdir, '.dsh', 'bgjobs', jobId)
}

async function exists(p) {
  return fsp.access(p).then(() => true).catch(() => false)
}

const MIRROR_PS1 = fileURLToPath(new URL('../tools/dsh-bgjobs-lib.ps1', import.meta.url))

/**
 * 用 PowerShell **自己的解析器**验收一个 .ps1（★ 测试盲区钉子：只断言字符串内容抓不到
 * 「缺调用运算符 `&` ⇒ 引号开头的语句被当表达式」这类语法缺陷 —— 实测该缺陷 parse-errors=10）。
 * ★ 必须用 **spawnSync（同步）**：本环境会话沙箱给 node 注入了管道捕获 shim
 * （异步 API 立即报错、同步 API 改用文件句柄），异步 spawn + 管道会误红。
 * ★ 编码（复核方实测的假红根因）：Windows PowerShell 5.1 对**无 BOM 的 UTF-8** 按 ANSI/GBK 读
 * ⇒ 含中文的库源文件会报一堆**假**解析错（`tools/dsh-bgjobs-lib.ps1` 实测 44 条、文本乱码）。
 * 故先以 UTF-8 读入、写成**带 BOM 的临时副本**再解析 —— 编码无关，且**不动仓库的无 BOM 家规**
 * （`node scripts/fix-bom.mjs --check` 必须继续通过；方向是改测试，不是给产物加 BOM）。
 */
function psParseFile(ps1Path) {
  const exe = path.join(process.env.SystemRoot || 'X:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('"
    + ps1Path.replace(/'/g, "''") + "', [ref]$null, [ref]$e); 'PARSE_ERRORS=' + @($e).Count"
  const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 })
  if (res.error) assert.fail('powershell spawnSync failed: ' + res.error.message)
  const m = /PARSE_ERRORS=(\d+)/.exec(String(res.stdout || ''))
  if (m === null) assert.fail('no PARSE_ERRORS marker; stdout=' + String(res.stdout) + ' stderr=' + String(res.stderr))
  return Number(m[1])
}

function psParseErrors(ps1Path) {
  const raw = readFileSync(ps1Path, 'utf8').replace(/^\uFEFF/, '')
  const tmp = path.join(os.tmpdir(), 'bgjobs-parse-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ps1')
  writeFileSync(tmp, '\uFEFF' + raw, 'utf8')
  try {
    return psParseFile(tmp)
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* 尽力而为 */ }
  }
}

/** 解析一段 PowerShell 文本（信封）：写入带 BOM 的临时 .ps1 再交给 PowerShell 解析器。 */
function psParseText(text) {
  const tmp = path.join(os.tmpdir(), 'bgjobs-parse-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ps1')
  writeFileSync(tmp, '\uFEFF' + String(text).replace(/^\uFEFF/, ''), 'utf8')
  try {
    return psParseFile(tmp)
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* 尽力而为 */ }
  }
}

// ── 纯函数：引用（最高危处）──────────────────────────────────────────────────

test('psQuote/psQuoteArgv：单引号包裹 + 内部单引号双写（逐元素，不整串拼接）', () => {
  assert.equal(psQuote('a'), "'a'")
  assert.equal(psQuote("it's"), "'it''s'")
  assert.equal(psQuote('X:\\Program Files\\x'), "'X:\\Program Files\\x'")
  assert.equal(psQuoteArgv(['X:\\a b', "x'y"]), "'X:\\a b' 'x''y'")
  assert.equal(psQuoteArgv([]), '')
})

// ── ① 显式 acl ⇒ 描述符链路（b=acl；工作区无脚本、无 ACL 处理）─────────────

test('沙箱后端：显式 acl ⇒ 描述符链路（b=acl / c / p / t），不再生成 run.ps1 或动 ACL', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => SHELL)
  setSandboxRunnerResolver(async () => ACL_RUNNER)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'acl' }, { agent: undefined },
  )
  assert.equal(res.ok, true)
  const jobDir = jobDirOf(workdir, res.jobId)
  const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
  assert.equal(meta.sandbox, 'workspace-write')
  assert.equal(meta.layout, 2, '新提交应为描述符布局')
  assert.equal(meta.sandboxBackend, 'acl')
  assert.equal(meta.sandboxRunnerPath, ACL_RUNNER)
  assert.ok(meta.sandboxTempPath && meta.sandboxTempPath.length > 0, 'acl 应建私有 temp 根')
  assert.equal(meta.confinedArgv, undefined, 'acl 不得有 confinedArgv')
  // 工作区只留记录：没有被执行的脚本
  assert.equal(await exists(path.join(jobDir, 'run.ps1')), false)
  assert.equal(await exists(path.join(jobDir, 'job.ps1')), false)
  assert.equal(await exists(path.join(jobDir, 'cmd.ps1')), true, 'cmd.ps1 只作为记录')
  assert.ok(!calls.some((argv) => String(argv[0]).toLowerCase().endsWith('icacls.exe')), '新链路不得再对 jobDir 做 ACL')
  // 任务定义 = <node> host.mjs <jobDir> <descriptor>
  const action = captureTaskAction(calls)
  assert.equal(action.execute, meta.nodeExe)
  assert.equal(action.jobDir, jobDir, 'jobDir 必须明文出现在任务定义（kill-tree 所有权门禁）')
  assert.equal(action.descriptor.m, 'sandbox')
  assert.equal(action.descriptor.b, 'acl')
  assert.equal(action.descriptor.p, 'workspace-write')
  assert.equal(action.descriptor.c, 'echo ok')
  assert.equal(action.descriptor.t, meta.sandboxTempPath)
  assert.equal(action.descriptor.w, workdir)
})

// ── ② 开关关 + 'dsh' ⇒ fail loud + 零副作用 ─────────────────────────────────

test('沙箱后端：开关关 + dsh ⇒ fail loud（文案整串相等）且零副作用（不建 jobDir、不调 confine）', async () => {
  await setSandboxBackendsEnabled(false)   // v0.3.1：门默认开，本用例显式关
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  let confineCalled = false
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({
    services: servicesFor(workdir, {
      sandbox: { confine: async () => { confineCalled = true; throw new Error('must not be called') } },
    }),
  })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'dsh' },
    { agent: undefined },
  )
  assert.equal(res.ok, false)
  assert.equal(res.error, DSH_BACKEND_DISABLED_ERROR, '文案必须与常量逐字相等（两层共享）')
  assert.equal(confineCalled, false, '开关关闭时绝不得触碰 sandbox 服务')
  const jobsRoot = path.join(workdir, '.dsh', 'bgjobs')
  if (await exists(jobsRoot)) {
    const names = await fsp.readdir(jobsRoot)
    assert.equal(names.filter((n) => n.startsWith('bg-')).length, 0, '不得创建 jobDir')
  }
})
test('沙箱后端：**不传 backend** ⇒ 缺省 dsh（v0.3.3），无服务时按 dsh 报错', async () => {
  await setSandboxBackendsEnabled(true)
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) }) // 未合成 sandbox 服务
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write' },
    { agent: undefined },
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /requires the dsh sandbox service/, '缺省应是 dsh（而不是 acl）')
})

// ── ③ 开关开 + 无 sandbox 服务 ⇒ fail loud ─────────────────────────────────

test('沙箱后端：开关开 + 无 sandbox 服务 ⇒ fail loud 且不建 jobDir', async () => {
  await setSandboxBackendsEnabled(true)
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) }) // 未合成 sandbox 服务
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'dsh' },
    { agent: undefined },
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /requires the dsh sandbox service/)
  const jobsRoot = path.join(workdir, '.dsh', 'bgjobs')
  if (await exists(jobsRoot)) {
    const names = await fsp.readdir(jobsRoot)
    assert.equal(names.filter((n) => n.startsWith('bg-')).length, 0, '不得创建 jobDir')
  }
})

// ── ④ 开关开 + 假服务 ⇒ confine 产物进描述符 a（工作区无脚本）───────────────

test('沙箱后端：开关开 + 假 sandbox 服务 ⇒ confine 返回的 argv 逐字进描述符 a（含空格/单引号）', async () => {
  await setSandboxBackendsEnabled(true)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => SHELL)
  const workdir = await makeWorkdir()
  const seen = []
  // 故意含：空格路径、单引号文件名、绝对 .exe、长 base64 参数
  const confined = [
    'X:\\wxc\\wxc-exec.exe', '--config-base64', 'QUJD', '--',
    'X:\\Program Files\\pwsh 7\\pwsh.exe', '-NoProfile', '-NoLogo',
    '-File', "X:\\a b\\it's.ps1",
  ]
  const { ctx, tools } = makeCtx({
    services: servicesFor(workdir, {
      sandbox: {
        confine: async (argv, policy) => {
          seen.push({ argv, policy })
          return { argv: confined, enforcement: 'full', denialSignatures: ['Access is denied'], runnerFailureRules: [] }
        },
      },
    }),
  })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'dsh' },
    { agent: undefined },
  )
  assert.equal(res.ok, true, res.error)
  const jobDir = jobDirOf(workdir, res.jobId)
  const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
  assert.equal(meta.sandboxBackend, 'dsh')
  assert.deepEqual(meta.confinedArgv, confined)
  assert.equal(meta.enforcement, 'full')
  // ★ dsh 分支必须跳过 ACL 档专属字段（host 的 node 仍需要）
  assert.equal(meta.sandboxRunnerPath, undefined)
  assert.equal(meta.sandboxTempPath, undefined)
  assert.ok(meta.nodeExe, '任务定义的 execute 仍必须是真 node')
  assert.equal(meta.nodeExeVersion, undefined, 'dsh 不需要 ACL runner 的 N-API 版本探针')
  // confine 收到的 policy/argv：解释器 + -EncodedCommand（信封），不再有 -File job.ps1
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].policy, { mode: 'workspace-write', workspaceRoot: workdir })
  assert.deepEqual(
    seen[0].argv.slice(0, 6),
    [meta.interpreter, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'],
  )
  const envelope = Buffer.from(seen[0].argv[6], 'base64').toString('utf16le')
  assert.ok(envelope.includes('& {'), '信封应包裹原始命令')
  assert.ok(envelope.includes('echo ok'))
  assert.equal(psParseText(envelope), 0, 'dsh 交付的信封必须 parse-errors=0')
  // 任务定义：描述符 a 逐字保留；工作区不得再出现 run.ps1 / job.ps1
  const action = captureTaskAction(calls)
  assert.deepEqual(action.descriptor.a, confined)
  assert.equal(action.descriptor.b, 'dsh')
  assert.equal(action.descriptor.c, undefined)
  assert.equal(await exists(path.join(jobDir, 'run.ps1')), false)
  assert.equal(await exists(path.join(jobDir, 'job.ps1')), false)
})

// ── ⑤ 开关开 + 'acl' ⇒ 描述符链路（b=acl）──────────────────────────────────

test('沙箱后端：开关开 + acl ⇒ 仍走描述符链路（b=acl，显式写老值也放行）', async () => {
  await setSandboxBackendsEnabled(true)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => SHELL)
  setSandboxRunnerResolver(async () => ACL_RUNNER)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'acl' },
    { agent: undefined },
  )
  assert.equal(res.ok, true)
  const meta = JSON.parse(await fsp.readFile(path.join(jobDirOf(workdir, res.jobId), 'job.json'), 'utf8'))
  assert.equal(meta.sandboxBackend, 'acl')
  assert.equal(meta.sandboxRunnerPath, ACL_RUNNER)
  assert.equal(captureTaskAction(calls).descriptor.b, 'acl')
})

// ── ⑥ 提交后关开关 ⇒ 在跑任务不受影响 ────────────────────────────────────────

test('沙箱后端：提交后关闭开关 ⇒ 已提交任务的任务定义与记录逐字不变', async () => {
  await setSandboxBackendsEnabled(true)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => SHELL)
  const workdir = await makeWorkdir()
  const confined = ['X:\\wxc\\wxc-exec.exe', '--config-base64', 'QUJD', '--', 'X:\\pwsh\\pwsh.exe', '-File', 'x.ps1']
  const { ctx, tools } = makeCtx({
    services: servicesFor(workdir, {
      sandbox: { confine: async () => ({ argv: confined, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) },
    }),
  })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'dsh' },
    { agent: undefined },
  )
  assert.equal(res.ok, true, res.error)
  const jobDir = jobDirOf(workdir, res.jobId)
  const jsonPath = path.join(jobDir, 'job.json')
  const beforeJson = await fsp.readFile(jsonPath, 'utf8')
  const beforeDescriptor = captureTaskAction(calls).descriptorText
  // 关掉开关（并让新的一次 apply 读到"关"）：在跑任务不应受任何影响
  await setSandboxBackendsEnabled(false)
  const { ctx: ctx2 } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx2)
  assert.equal(await fsp.readFile(jsonPath, 'utf8'), beforeJson, '开关翻转不得改写已提交任务的记录')
  assert.equal(captureTaskAction(calls).descriptorText, beforeDescriptor, '任务定义已在注册时固化，不受开关影响')
  assert.deepEqual(captureTaskAction(calls).descriptor.a, confined)
  assert.equal(await exists(path.join(jobDir, 'run.ps1')), false)
})

// ── ⑦ 非法取值 ⇒ 拒（程序直调绕过 schema 的兜底）────────────────────────────

test('沙箱后端：非法 sandbox_backend ⇒ 拒绝且零副作用', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'mxc' },
    { agent: undefined },
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /invalid sandbox_backend/)
  const jobsRoot = path.join(workdir, '.dsh', 'bgjobs')
  if (await exists(jobsRoot)) {
    const names = await fsp.readdir(jobsRoot)
    assert.equal(names.filter((n) => n.startsWith('bg-')).length, 0, '不得创建 jobDir')
  }
})

// ── ⑧ ★ 解析器验收（命令信封必须能被 PowerShell 自己解析）────────────────────

test('解析器验收：dsh 后端交付的 -EncodedCommand 信封 parse-errors=0，a 逐字进描述符', async () => {
  await setSandboxBackendsEnabled(true)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => SHELL)
  const workdir = await makeWorkdir()
  const seen = []
  // 真实形状：wxc-exec + --config-base64 + '--' + 解释器 + 交付参数（含空格路径）
  const confined = [
    'X:\\wxc\\wxc-exec.exe', '--config-base64', 'eyJ2ZXJzaW9uIjoiMS4wLjAifQ==', '--',
    SHELL.exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', 'QUJD',
  ]
  const { ctx, tools } = makeCtx({
    services: servicesFor(workdir, {
      sandbox: {
        confine: async (argv) => {
          seen.push(argv)
          return { argv: confined, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
        },
      },
    }),
  })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'dsh' },
    { agent: undefined },
  )
  assert.equal(res.ok, true, res.error)
  const action = captureTaskAction(calls)
  assert.deepEqual(action.descriptor.a, confined, 'confine 产物必须逐字进描述符（I3）')
  assert.equal(seen.length, 1)
  const envelope = Buffer.from(seen[0][seen[0].indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  assert.ok(envelope.startsWith('# bgjobs') || envelope.includes('& {'), '信封应含包装结构')
  assert.equal(psParseText(envelope), 0, 'dsh 交付的信封必须 parse-errors=0')
  assert.equal(await exists(path.join(jobDirOf(workdir, res.jobId), 'run.ps1')), false)
})

test('解析器验收：acl 形态由 host 运行期生成同一信封（工作区无脚本）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  setSandboxRunnerResolver(async () => ACL_RUNNER)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'acl' }, { agent: undefined },
  )
  assert.equal(res.ok, true)
  const meta = JSON.parse(await fsp.readFile(path.join(jobDirOf(workdir, res.jobId), 'job.json'), 'utf8'))
  assert.equal(meta.sandboxBackend, 'acl')
  assert.equal(await exists(path.join(jobDirOf(workdir, res.jobId), 'run.ps1')), false)
  const envelope = buildPwshEnvelope('echo ok', { encoding: 'auto', interpreter: SHELL.exe })
  assert.ok(envelope.includes('& {'))
  assert.equal(psParseText(envelope), 0, 'acl 形态的信封必须 parse-errors=0')
})

test('镜像一致性：tools/dsh-bgjobs-lib.ps1 的 dsh 行也带 & 且镜像自身可被解析', async () => {
  const mirror = await fsp.readFile(MIRROR_PS1, 'utf8')
  assert.ok(
    mirror.includes("$runLine = '& ' + (($argv | ForEach-Object { ConvertTo-BgjobsPsQuote ([string]$_) }) -join ' ') + ' *> $logPath'"),
    'PS 镜像的 dsh 行必须以 & 开头',
  )
  assert.ok(mirror.includes("$runLine = \"    & '__SCRIPTPATH__' *> `$logPath\""), 'PS 镜像的老路径行应以 & 开头')
  assert.ok(mirror.includes('__RUNLINE__'), '模板应使用 __RUNLINE__ 占位')
  assert.equal(psParseErrors(MIRROR_PS1), 0, 'tools/dsh-bgjobs-lib.ps1 必须 parse-errors=0')
})

test('解析器验收：output_encoding=native ⇒ 描述符 o=native，信封取继承码页（v0.2.6）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  setSandboxRunnerResolver(async () => ACL_RUNNER)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'acl', output_encoding: 'native' },
    { agent: undefined },
  )
  assert.equal(res.ok, true)
  const meta = JSON.parse(await fsp.readFile(path.join(jobDirOf(workdir, res.jobId), 'job.json'), 'utf8'))
  assert.equal(meta.outputEncoding, 'native')
  const envelope = buildPwshEnvelope('echo ok', { encoding: 'native', interpreter: SHELL.exe })
  assert.ok(envelope.includes('$bgjobNative = [Console]::OutputEncoding'), 'native：先取继承码页')
  assert.ok(envelope.includes('[Console]::OutputEncoding = $bgjobNative'), 'native：用继承码页解码')
  assert.ok(!envelope.includes('[Console]::OutputEncoding = $bgjobUtf8'), 'native：不得按 UTF-8 解码')
  assert.equal(psParseText(envelope), 0, 'native 形态信封必须 parse-errors=0')
  // 镜像：占位与判据都在，且自身可解析（两处逐字一致的纪律）。
  // ★ 模板必须【独立成行】地留占位、并【逐字保留】默认编码行 —— 否则"默认逐字节一致"被破坏
  //   （半行占位会让 $pidPath / 兜底行的字面量消失，kill-tree.test.js 的两条守卫会抓住）。
  const mirror = await fsp.readFile(MIRROR_PS1, 'utf8')
  assert.ok(mirror.includes('__NATIVEENC__'), '镜像模板应用 __NATIVEENC__ 占位')
  assert.ok(
    mirror.includes('\n__NATIVEENC__\r\n$pidPath = \'__JOBDIR__\\run.pid\''),
    '镜像里 __NATIVEENC__ 必须独立成行，下一行逐字是 $pidPath = …（默认逐字节不变的前提）',
  )
  assert.ok(
    mirror.includes('    try { [Console]::OutputEncoding = $utf8 } catch { }'),
    '镜像必须逐字保留默认编码兜底行（native 时才在运行时替换）',
  )
  assert.ok(!mirror.includes('__ENCTARGET__'), '不得再用半行占位 __ENCTARGET__（会抹掉字面默认行）')
  assert.ok(
    mirror.includes("$encNative = ($Job.meta.outputEncoding -eq 'native')"),
    '镜像应从 meta.outputEncoding 判定 native',
  )
  assert.equal(psParseErrors(MIRROR_PS1), 0, '镜像必须 parse-errors=0')
})

test('解析器验收：output_encoding=auto ⇒ 描述符 o=auto，信封按 UTF-8（读取端 decodeAutoText 兜底）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  setSandboxRunnerResolver(async () => ACL_RUNNER)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', sandbox_backend: 'acl', output_encoding: 'auto' },
    { agent: undefined },
  )
  assert.equal(res.ok, true)
  const meta = JSON.parse(await fsp.readFile(path.join(jobDirOf(workdir, res.jobId), 'job.json'), 'utf8'))
  assert.equal(meta.outputEncoding, 'auto', '缺省编码仍落盘 auto（显示层 decodeAutoText 闸门）')
  const envelope = buildPwshEnvelope('echo ok', { encoding: 'auto', interpreter: SHELL.exe })
  assert.ok(envelope.includes('GetEncoding(28591)'), 'auto：native 字节按 28591 成像（PS 原生中文走 UTF-8 写入器）')
  assert.ok(envelope.includes('[Console]::SetOut($bgjobOut)'), 'auto：PS 自身输出走显式 UTF-8 写入器')
  assert.ok(envelope.includes('2>&1 | ForEach-Object'), 'auto：错误流在脚本内合并，避免 CLIXML')
  assert.ok(!envelope.includes('$bgjobNative'), 'auto：不得含 $bgjobNative')
  assert.equal(psParseText(envelope), 0, 'auto 形态信封必须 parse-errors=0')
  // env 前缀（v0.4：env 是命令的一部分）：含空格/单引号的 TMP 与普通变量都必须可解析
  const withEnv = buildPwshEnvelope(
    buildEnvPrefix('pwsh', { TMP: 'X:\\tmp\\bg job', FOO: "it's" }) + 'Write-Output $env:FOO',
    { encoding: 'auto', interpreter: SHELL.exe },
  )
  assert.equal(psParseText(withEnv), 0, '带 env 前缀的信封必须 parse-errors=0')
  // 镜像：判据与占位都在，且自身可解析（两处逐字一致的纪律）。
  const mirror = await fsp.readFile(MIRROR_PS1, 'utf8')
  assert.ok(
    mirror.includes("$encAuto = ($Job.meta.outputEncoding -eq 'auto')"),
    '镜像应从 meta.outputEncoding 判定 auto',
  )
  assert.ok(mirror.includes('__AUTOFINAL__'), '镜像模板应用 __AUTOFINAL__ 占位（收尾块独立成行注入）')
  assert.equal(psParseErrors(MIRROR_PS1), 0, '镜像必须 parse-errors=0')
})
