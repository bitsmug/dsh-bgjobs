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
} from '../lib/index.js'
import { DSH_BACKEND_DISABLED_ERROR } from '../lib/core/store.js'
import { makeWorkdir, makeCtx, makeFakeRunner, restrictedPolicy, installSuiteHooks } from './helpers/common.js'

installSuiteHooks()

/** 写沙箱后端开关（<DSH_HOME>/bgjobs/sandbox-backends.json）。 */
async function setSandboxBackendsEnabled(enabled) {
  await fsp.mkdir(path.join(process.env.DSH_HOME, 'bgjobs'), { recursive: true })
  await fsp.writeFile(
    path.join(process.env.DSH_HOME, 'bgjobs', 'sandbox-backends.json'),
    JSON.stringify({ enabled }), 'utf8',
  )
}

const SHELL = { exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }
const ACL_RUNNER = 'C:\\runner\\runner.js'

function servicesFor(workdir, extra) {
  return Object.assign(restrictedPolicy(workdir), extra)
}

function findSubmit(tools) {
  return tools.find((t) => t.name === 'bgjob_submit_pwsh')
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
function psParseErrors(ps1Path) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const raw = readFileSync(ps1Path, 'utf8').replace(/^\uFEFF/, '')
  const tmp = path.join(os.tmpdir(), 'bgjobs-parse-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ps1')
  writeFileSync(tmp, '\uFEFF' + raw, 'utf8')
  try {
    const script = "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('"
      + tmp.replace(/'/g, "''") + "', [ref]$null, [ref]$e); 'PARSE_ERRORS=' + @($e).Count"
    const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 })
    if (res.error) assert.fail('powershell spawnSync failed: ' + res.error.message)
    const m = /PARSE_ERRORS=(\d+)/.exec(String(res.stdout || ''))
    if (m === null) assert.fail('no PARSE_ERRORS marker; stdout=' + String(res.stdout) + ' stderr=' + String(res.stderr))
    return Number(m[1])
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* 尽力而为 */ }
  }
}

// ── 纯函数：引用（最高危处）──────────────────────────────────────────────────

test('psQuote/psQuoteArgv：单引号包裹 + 内部单引号双写（逐元素，不整串拼接）', () => {
  assert.equal(psQuote('a'), "'a'")
  assert.equal(psQuote("it's"), "'it''s'")
  assert.equal(psQuote('C:\\Program Files\\x'), "'C:\\Program Files\\x'")
  assert.equal(psQuoteArgv(['C:\\a b', "x'y"]), "'C:\\a b' 'x''y'")
  assert.equal(psQuoteArgv([]), '')
})

// ── ① 开关关 + 不传 backend ⇒ 老路径（ACL），逐字不变 ────────────────────────

test('沙箱后端：开关关 + 不传 backend ⇒ 老路径（ACL runner；不写 sandboxBackend）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => SHELL)
  setSandboxRunnerResolver(async () => ACL_RUNNER)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write' }, { agent: undefined },
  )
  assert.equal(res.ok, true)
  const meta = JSON.parse(await fsp.readFile(path.join(jobDirOf(workdir, res.jobId), 'job.json'), 'utf8'))
  assert.equal(meta.sandbox, 'workspace-write')
  assert.equal(meta.sandboxBackend, undefined, '老路径不得新增 sandboxBackend 字段')
  assert.equal(meta.sandboxRunnerPath, ACL_RUNNER)
  assert.ok(meta.sandboxTempPath && meta.sandboxTempPath.length > 0, '老路径应建私有 temp 根')
  assert.equal(meta.confinedArgv, undefined, '老路径不得有 confinedArgv')
  const runner = await fsp.readFile(path.join(jobDirOf(workdir, res.jobId), 'run.ps1'), 'utf8')
  assert.ok(runner.includes("--workspace '" + workdir + "'"), 'run.ps1 应为 ACL runner 形态')
  assert.ok(runner.includes("'--' '" + meta.interpreter + "'"), "run.ps1 应含 '--' 后的解释器")
  assert.ok(runner.includes('*> $logPath'))
})

// ── ② 开关关 + 'dsh' ⇒ fail loud + 零副作用 ─────────────────────────────────

test('沙箱后端：开关关 + dsh ⇒ fail loud（文案整串相等）且零副作用（不建 jobDir、不调 confine）', async () => {
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

// ── ④ 开关开 + 假服务 ⇒ 走 confine；run.ps1 烘的是 service 返回的 argv ───────

test('沙箱后端：开关开 + 假 sandbox 服务 ⇒ 烘入 run.ps1 的是 service 返回的 argv（含空格/单引号）', async () => {
  await setSandboxBackendsEnabled(true)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => SHELL)
  const workdir = await makeWorkdir()
  const seen = []
  // 故意含：空格路径、单引号文件名、绝对 .exe、长 base64 参数
  const confined = [
    'C:\\wxc\\wxc-exec.exe', '--config-base64', 'QUJD', '--',
    'C:\\Program Files\\pwsh 7\\pwsh.exe', '-NoProfile', '-NoLogo',
    '-File', "C:\\a b\\it's.ps1",
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
  assert.equal(res.ok, true)
  const jobDir = jobDirOf(workdir, res.jobId)
  const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
  assert.equal(meta.sandboxBackend, 'dsh')
  assert.deepEqual(meta.confinedArgv, confined)
  assert.equal(meta.enforcement, 'full')
  // ★ dsh 分支必须跳过 ACL 档专属字段
  assert.equal(meta.sandboxRunnerPath, undefined)
  assert.equal(meta.sandboxTempPath, undefined)
  assert.equal(meta.nodeExe, undefined)
  assert.equal(meta.nodeExeVersion, undefined)
  // confine 收到的 policy/argv（形状与 shell 沙箱执行器同款）
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].policy, { mode: 'workspace-write', workspaceRoot: workdir })
  assert.deepEqual(seen[0].argv, [meta.interpreter, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', meta.scriptPath])
  // run.ps1：逐元素引用 + 保留重定向/退出码镜像/run.pid
  const runner = await fsp.readFile(path.join(jobDir, 'run.ps1'), 'utf8')
  assert.ok(runner.includes(psQuoteArgv(confined)), 'run.ps1 应逐元素引用烘入 confined argv')
  assert.ok(runner.includes("'C:\\a b\\it''s.ps1'"), '内部单引号应双写')
  assert.ok(runner.includes('*> $logPath'))
  assert.ok(runner.includes('if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }'))
  assert.ok(runner.includes('run.pid'))
  assert.ok(!runner.includes(ACL_RUNNER), 'dsh 路径不得再出现 ACL runner')
})

// ── ⑤ 开关开 + 'acl' ⇒ 老路径 ──────────────────────────────────────────────

test('沙箱后端：开关开 + acl ⇒ 仍是老路径（显式写老值也放行）', async () => {
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
  assert.equal(meta.sandboxBackend, undefined, "显式 'acl' 也走老路径 ⇒ 不写 sandboxBackend")
  assert.equal(meta.sandboxRunnerPath, ACL_RUNNER)
})

// ── ⑥ 提交后关开关 ⇒ 在跑任务不受影响 ────────────────────────────────────────

test('沙箱后端：提交后关闭开关 ⇒ 已在跑任务的 run.ps1 逐字节不变（argv 已落盘）', async () => {
  await setSandboxBackendsEnabled(true)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => SHELL)
  const workdir = await makeWorkdir()
  const confined = ['C:\\wxc\\wxc-exec.exe', '--config-base64', 'QUJD', '--', 'C:\\pwsh\\pwsh.exe', '-File', 'x.ps1']
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
  assert.equal(res.ok, true)
  const runnerPath = path.join(jobDirOf(workdir, res.jobId), 'run.ps1')
  const before = await fsp.readFile(runnerPath, 'utf8')
  // 关掉开关（并让新的一次 apply 读到"关"）：在跑任务不应受任何影响
  await setSandboxBackendsEnabled(false)
  const { ctx: ctx2 } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx2)
  const after = await fsp.readFile(runnerPath, 'utf8')
  assert.equal(after, before, '开关翻转不得改写已提交任务的 run.ps1')
  assert.ok(before.includes(psQuoteArgv(confined)))
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

// ── ⑧ ★ 解析器验收（阻断级缺陷回归钉子：缺 & ⇒ 引号开头被当表达式）──────────────

test('解析器验收：dsh 后端生成的 run.ps1 必须 parse-errors=0 且生成行以 & 开头', async () => {
  await setSandboxBackendsEnabled(true)
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  const workdir = await makeWorkdir()
  // 真实形状：wxc-exec + --config-base64 + '--' + 解释器 + 参数（含空格路径）
  const confined = [
    'C:\\wxc\\wxc-exec.exe', '--config-base64', 'eyJ2ZXJzaW9uIjoiMS4wLjAifQ==', '--',
    SHELL.exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\a b\\job.ps1',
  ]
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
  assert.equal(res.ok, true)
  const runnerPath = path.join(jobDirOf(workdir, res.jobId), 'run.ps1')
  const text = await fsp.readFile(runnerPath, 'utf8')
  const dshLine = text.split(/\r?\n/).find((l) => l.includes('wxc-exec.exe'))
  assert.ok(dshLine !== undefined, 'run.ps1 应含 dsh 生成行')
  assert.ok(dshLine.trimStart().startsWith('& '), 'dsh 生成行必须以调用运算符 & 开头，实际: ' + dshLine)
  assert.equal(psParseErrors(runnerPath), 0, 'dsh 形态 run.ps1 必须 parse-errors=0')
})

test('解析器验收：老路径（ACL）生成的 run.ps1 同样 parse-errors=0（对照）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  setSandboxRunnerResolver(async () => ACL_RUNNER)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write' }, { agent: undefined },
  )
  assert.equal(res.ok, true)
  assert.equal(psParseErrors(path.join(jobDirOf(workdir, res.jobId), 'run.ps1')), 0)
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

test('解析器验收：output_encoding=native 的 run.ps1 与镜像同款分支都可解析（v0.2.6）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => SHELL)
  setSandboxRunnerResolver(async () => ACL_RUNNER)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: servicesFor(workdir) })
  apply(ctx)
  const res = await findSubmit(tools).execute(
    { name: 't', command: 'echo ok', workdir, sandbox: 'workspace-write', output_encoding: 'native' },
    { agent: undefined },
  )
  assert.equal(res.ok, true)
  const runnerPath = path.join(jobDirOf(workdir, res.jobId), 'run.ps1')
  const text = await fsp.readFile(runnerPath, 'utf8')
  assert.ok(text.includes('$nativeEnc = [Console]::OutputEncoding'), 'native：run.ps1 先取继承码页')
  assert.ok(text.includes('[Console]::OutputEncoding = $nativeEnc'), 'native：用 $nativeEnc 解码')
  assert.ok(!text.includes('[Console]::OutputEncoding = $utf8'), 'native：不得按 UTF-8 解码')
  assert.equal(psParseErrors(runnerPath), 0, 'native 形态 run.ps1 必须 parse-errors=0')
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
