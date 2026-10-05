// bgjobs tests —— 沙箱联动与 full access（v0.1.61 自 tests/index.test.js 拆分）。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, strip, buildBat, buildCmdBat, buildPwshRunner, buildPs1, buildLaunchVbs, parseExitCode,
  jobSandboxDecision, shouldNotifyForExit,
  setSchtasksRunner, setShellResolver, setSandboxRunnerResolver,
  setNodeExeResolver, peSubsystem,
  resolveBgjobsHome, bgjobsIndexPath, readBgjobsIndex, writeBgjobsIndex,
  updateBgjobsIndex, rebuildBgjobsIndex, buildBgjobsGuidance,
} from '../lib/index.js'
import {
  makeDshHome, makeWorkdir, makeCtx, makeFakeRunner, attachWebServer,
  runningPlugin, waitFor, setFullAccessEnabled, restrictedPolicy, fullPolicy,
  agentHandle, submitAndFinish, scheduleExitWrite, installSuiteHooks,
} from './helpers/common.js'

installSuiteHooks()

test('jobSandboxDecision: 未挂载沙箱服务（none）——full access 关拒绝、开才放行', () => {
  // 关 → 拒绝（fail closed，不能默认放行），bat/pwsh 同
  assert.throws(() => jobSandboxDecision('none', undefined, 'pwsh', false), /no dsh sandbox policy service/)
  assert.throws(() => jobSandboxDecision('none', undefined, 'bat', false), /no dsh sandbox policy service/)
  assert.throws(() => jobSandboxDecision('none', 'read-only', 'pwsh', false), /no dsh sandbox policy service/)
  // 开 → 原模式放行
  assert.deepEqual(jobSandboxDecision('none', undefined, 'pwsh', true), { mode: 'off', escalate: false })
  assert.deepEqual(jobSandboxDecision('none', undefined, 'bat', true), { mode: 'off', escalate: false })
})


test('jobSandboxDecision: full（服务在但会话全权限）放行任意请求，无审批', () => {
  assert.deepEqual(jobSandboxDecision('full', undefined, 'pwsh', false), { mode: 'off', escalate: false })
  assert.deepEqual(jobSandboxDecision('full', 'workspace-write', 'pwsh', false), { mode: 'workspace-write', escalate: false })
  assert.deepEqual(jobSandboxDecision('full', 'read-only', 'pwsh', false), { mode: 'read-only', escalate: false })
  assert.deepEqual(jobSandboxDecision('full', undefined, 'bat', false), { mode: 'off', escalate: false })
})


test('jobSandboxDecision: 受限会话缺省继承；更宽请求才 escalate（full access 关时）', () => {
  assert.deepEqual(jobSandboxDecision('read-only', undefined, 'pwsh', false), { mode: 'read-only', escalate: false })
  assert.deepEqual(jobSandboxDecision('workspace-write', undefined, 'pwsh', false), { mode: 'workspace-write', escalate: false })
  // 更窄/等宽请求恒放行
  assert.deepEqual(jobSandboxDecision('workspace-write', 'read-only', 'pwsh', false), { mode: 'read-only', escalate: false })
  // 更宽（off）→ escalate；full access 开 → 预批准
  assert.deepEqual(jobSandboxDecision('workspace-write', 'off', 'pwsh', false), { mode: 'off', escalate: true })
  assert.deepEqual(jobSandboxDecision('workspace-write', 'off', 'pwsh', true), { mode: 'off', escalate: false })
  assert.deepEqual(jobSandboxDecision('read-only', 'workspace-write', 'pwsh', false), { mode: 'workspace-write', escalate: true })
  // bat 引擎恒全权限、无法沙箱化 → 受限会话仅 full access 模式支持（关则拒绝，不走逐次审批）
  assert.throws(() => jobSandboxDecision('workspace-write', undefined, 'bat', false), /full access/)
  assert.throws(() => jobSandboxDecision('read-only', undefined, 'bat', false), /full access/)
  assert.deepEqual(jobSandboxDecision('workspace-write', undefined, 'bat', true), { mode: 'off', escalate: false })
})


test('jobSandboxDecision: 非法参数 fail loud', () => {
  assert.throws(() => jobSandboxDecision('read-only', 'danger-full-access', 'pwsh', false), /invalid sandbox/)
  assert.throws(() => jobSandboxDecision('read-only', 'off', 'bat', false), /only supported on bgjob_submit_pwsh/)
  assert.throws(() => jobSandboxDecision('nonsense', undefined, 'pwsh', true), /unexpected session state/)
  assert.throws(() => jobSandboxDecision('full', undefined, 'cmd', true), /unexpected engine/)
})


test('jobSandboxDecision: mcp 引擎恒 off 且不受会话模式/full access 影响（与 DSH 对 MCP 的现状一致）', () => {
  // DSH 的 sandbox policy 只作用于 shell 沙箱执行器 / fs-sandbox / terminal-bash；MCP server
  // 由 SDK 自持 spawn，不经 ctx.subprocess / ctx.sandbox → 受限会话不限制 MCP。故 mcp 引擎在
  // 任意会话态与 full access 开关下都直接 off、不抛错（含 state='none' 未挂载策略服务）。
  for (const state of ['none', 'full', 'read-only', 'workspace-write']) {
    for (const fullAccess of [true, false]) {
      assert.deepEqual(jobSandboxDecision(state, undefined, 'mcp', fullAccess), { mode: 'off', escalate: false })
      // requested 对 MCP 任务无意义：显式传入同样被忽略（不抛错，仍 off）
      assert.deepEqual(jobSandboxDecision(state, 'read-only', 'mcp', fullAccess), { mode: 'off', escalate: false })
      assert.deepEqual(jobSandboxDecision(state, 'off', 'mcp', fullAccess), { mode: 'off', escalate: false })
    }
  }
})


test('buildPwshRunner: 沙箱任务把用户命令经 runner 包装（受限子进程），外层职责不变', () => {
  const base = {
    workdir: 'C:\\work', scriptPath: 'C:\\work\\job.ps1', jsonPath: 'C:\\work\\job.json',
    logPath: 'C:\\work\\log.txt', exitcodePath: 'C:\\work\\exit.txt', taskName: 'dsh-bgj-x',
  }
  const job = {
    meta: Object.assign({}, base, {
      sandbox: 'workspace-write', sandboxRunnerPath: 'C:\\r\\runner.js',
      sandboxTempPath: 'C:\\home\\sandbox\\tmp1', nodeExe: 'C:\\node\\node.exe',
      interpreter: 'C:\\pwsh\\pwsh.exe',
    }),
  }
  const ps1 = buildPwshRunner(job)
  assert.ok(ps1.includes("& 'C:\\node\\node.exe' 'C:\\r\\runner.js' --workspace 'C:\\work' --temp 'C:\\home\\sandbox\\tmp1' --mode workspace-write '--' 'C:\\pwsh\\pwsh.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 'C:\\work\\job.ps1' *> $logPath"), '沙箱任务应经 runner 包装 job.ps1')
  assert.ok(!ps1.includes("& 'C:\\work\\job.ps1' *> $logPath"), '沙箱任务不再直接 & job.ps1')
  assert.ok(ps1.includes("[System.IO.File]::WriteAllText('C:\\work\\exit.txt', [string]$code, $utf8)"), 'exitcode 写入仍在外层')
  assert.ok(ps1.includes("& schtasks /Delete /TN 'dsh-bgj-x' /F *> $null"), '自删任务计划仍在外层')
  const ro = buildPwshRunner({ meta: Object.assign({}, base, {
    sandbox: 'read-only', sandboxRunnerPath: 'C:\\r\\runner.js',
    sandboxTempPath: 'C:\\home\\sandbox\\tmp2', nodeExe: 'C:\\node\\node.exe',
    interpreter: 'C:\\pwsh\\pwsh.exe',
  }) })
  assert.ok(ro.includes('--mode read-only '), 'read-only 模式注入 runner')
})


test('full access: /bgjobs/fullaccess POST 持久化并反映到 state；缺省关', async () => {
  await setFullAccessEnabled(false)
  const { ctx, injectCallbacks } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  const handler = attachWebServer(ctx, injectCallbacks)().handler
  const call = async (url, method = 'GET') => {
    let body = ''
    const req = { url, method }
    const res = { writeHead: () => {}, end: (b) => { body = b } }
    await handler(req, res)
    return JSON.parse(body)
  }
  assert.equal((await call('/bgjobs/fullaccess')).enabled, false, '缺省关')
  assert.equal((await call('/bgjobs/fullaccess?enabled=1', 'POST')).enabled, true)
  const persisted = JSON.parse(await fsp.readFile(path.join(process.env.DSH_HOME, 'bgjobs', 'fullaccess.json'), 'utf8'))
  assert.equal(persisted.enabled, true, '开关应持久化到 fullaccess.json')
  assert.equal((await call('/bgjobs/state')).fullAccess, true, 'state 应携带 fullAccess')
  assert.equal((await call('/bgjobs/fullaccess?enabled=0', 'POST')).enabled, false)
  assert.equal((await call('/bgjobs/state')).fullAccess, false)
  dispose()
})


test('bgjob_submit_pwsh: 受限会话请求 off + full access 关 → approval 弹窗放行（allowed-once）落盘 resolved 值', async () => {
  await setFullAccessEnabled(false)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  const approvals = []
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({
    services: Object.assign(restrictedPolicy(workdir), {
      approval: { request: async (req) => { approvals.push(req); return 'allowed-once' } },
    }),
  })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const exec = { agent: { session: { id: 's1' } }, callId: 'call-1' }
    const res = await submit.execute({ name: 't', command: 'Write-Output ok', workdir, sandbox: 'off', justification: '需要全权限' }, exec)
    assert.equal(res.ok, true)
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].toolName, 'bgjob_submit_pwsh')
    assert.equal(approvals[0].callId, 'call-1')
    assert.ok(approvals[0].reason.includes('escalate bgjob sandbox to full access: 需要全权限'))
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.sandbox, 'off', 'job.json 应落盘 resolved 模式')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit_pwsh: 受限会话宽请求被拒 → 抛错且不创建任何任务', async () => {
  await setFullAccessEnabled(false)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({
    services: Object.assign(restrictedPolicy(workdir), {
      approval: { request: async () => 'rejected' },
    }),
  })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const exec = { agent: { session: { id: 's1' } }, callId: 'call-1' }
    await assert.rejects(
      submit.execute({ name: 't', command: 'echo x', workdir, sandbox: 'off' }, exec),
      /user rejected/,
    )
    assert.deepEqual(calls, [], '拒绝后不得有任何 schtasks 调用')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit_pwsh: 受限会话宽请求但无 approval 服务 → fail closed 抛错', async () => {
  await setFullAccessEnabled(false)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: restrictedPolicy(workdir) }) // 无 approval
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const exec = { agent: { session: { id: 's1' } } }
    await assert.rejects(
      submit.execute({ name: 't', command: 'echo x', workdir, sandbox: 'off' }, exec),
      /approval service/,
    )
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit: 未挂载沙箱服务 + full access 关 → 拒绝提交（fail closed，不默认放行）', async () => {
  await setFullAccessEnabled(false)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: {} }) // 无 sandboxPolicy
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    await assert.rejects(
      submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined }),
      /no dsh sandbox policy service/,
    )
    assert.deepEqual(calls, [], '拒绝后不得有任何 schtasks 调用')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit: 受限会话 + full access 关 → 直接拒绝（bat 恒全权限，不弹审批）', async () => {
  await setFullAccessEnabled(false)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  let approvalAsked = 0
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({
    services: Object.assign(restrictedPolicy(workdir), {
      approval: { request: async () => { approvalAsked++; return 'allowed-once' } },
    }),
  })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    await assert.rejects(
      submit.execute({ name: 't', command: 'echo x', workdir }, exec),
      /full access/,
    )
    assert.equal(approvalAsked, 0, 'bat 恒全权限不再逐次弹审批')
    assert.deepEqual(calls, [], '拒绝后不得有任何 schtasks 调用')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit: 受限会话 + full access 开 → 原模式放行', async () => {
  await setFullAccessEnabled(true)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({
    services: Object.assign(restrictedPolicy(workdir), {
      approval: { request: async () => { throw new Error('full access 开不应触发审批') } },
    }),
  })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, exec)
    assert.equal(res.ok, true)
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.sandbox, 'off', 'full access 放行的 bat 任务落盘 off')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit_pwsh: 受限会话缺省继承 → 自动沙箱化（不弹审批）+ wiring 完整', async () => {
  await setFullAccessEnabled(false)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  setSandboxRunnerResolver(async () => 'C:\\runner\\runner.js')
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({
    services: Object.assign(restrictedPolicy(workdir), {
      approval: { request: async () => { throw new Error('继承模式不应触发审批') } },
    }),
  })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const exec = { agent: { session: { id: 's1' } } }
    const res = await submit.execute({ name: 't', command: 'Write-Output ok', workdir }, exec) // 无 sandbox 参数
    assert.equal(res.ok, true)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.sandbox, 'workspace-write', '缺省应继承会话受限模式')
    assert.equal(meta.sandboxRunnerPath, 'C:\\runner\\runner.js')
    // 沙箱 runner 必须由【真 node】拉起（v0.1.90-alpha，issue #1）：桌面版 DSH 的 execPath 是
    // Electron GUI 子系统 exe（被重定向 stdout 到文件会静默秒退）。故只断言"文件名是 node"
    // 这一不变式——原先的 assert.equal(meta.nodeExe, process.execPath) 在桌面版上正是 bug 本身。
    const nodeBase = path.basename(meta.nodeExe).toLowerCase()
    assert.ok(nodeBase === 'node' || nodeBase === 'node.exe', '沙箱 nodeExe 必须是真 node（实测 ' + meta.nodeExe + '）')
    assert.ok(meta.sandboxTempPath.startsWith(path.join(process.env.DSH_HOME, 'bgjobs', 'sandbox')), 'sandbox 临时根应在 DSH home 下')
    // icacls 授读 jobDir（受限子进程要读 job.ps1/解释器）
    assert.ok(calls.some((argv) => argv.length >= 3 && argv[0].endsWith('icacls.exe') && argv[1] === jobDir && argv[2] === '/grant'))
    const run = await fsp.readFile(path.join(jobDir, 'run.ps1'), 'utf8')
    assert.ok(run.includes("--workspace '" + workdir.replace(/\//g, '\\') + "'"), 'runner 应包 job.ps1 于工作区根')
    assert.ok(run.includes('--mode workspace-write'))
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit_pwsh: 会话全权限（danger-full-access）+ 显式 sandbox → 沙箱任务落盘 + state 展示', async () => {
  await setFullAccessEnabled(false)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  setSandboxRunnerResolver(async () => 'C:\\runner\\runner.js')
  const workdir = await makeWorkdir()
  const { ctx, tools, injectCallbacks } = makeCtx({ services: fullPolicy(workdir) })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const exec = { agent: { session: { id: 's1' } } }
    const res = await submit.execute({ name: 't', command: 'Write-Output ok', workdir, sandbox: 'workspace-write' }, exec)
    assert.equal(res.ok, true)
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.sandbox, 'workspace-write')
    const state = attachWebServer(ctx, injectCallbacks)()
    let body = ''
    await state.handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs[0].sandbox, 'workspace-write', 'state 视图应携带 sandbox 字段')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit_pwsh: 请求沙箱但 runner 不可得 → fail loud + 清理', async () => {
  await setFullAccessEnabled(false)
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  setSandboxRunnerResolver(async () => null)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: fullPolicy(workdir) })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const exec = { agent: { session: { id: 's1' } } }
    const res = await submit.execute({ name: 't', command: 'Write-Output ok', workdir, sandbox: 'workspace-write' }, exec)
    assert.equal(res.ok, false)
    assert.match(res.error, /runner not found/)
    const leftovers = await fsp.readdir(path.join(workdir, '.dsh', 'bgjobs')).catch(() => [])
    assert.equal(leftovers.length, 0, 'runner 不可得时应清理 job 目录')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 完成通知创建者（v0.1.31，可选 notify 参数）──

/** 构造记录调用的 mock agent handle（createdBySession 解析目标）。 */

// ── 沙箱 runner 的真 node 解析（v0.1.90-alpha，issue #1）──────────────────────────────
// 症状：桌面版（Electron）DSH 的 process.execPath 是 GUI 子系统 exe，被 run.ps1 重定向
// stdout 到文件后静默秒退 → 沙箱 pwsh 任务日志空白 + 假 exit 0。修法：真 node 优先
// （basename 门保 koffi ABI 快路径）→ where.exe node → 都拿不到则 fail-closed + PE 守卫。
// 三个用例分别覆盖：PE 子系统判据 / 注入缝与 fail-closed / suspect 提示标记。

test('沙箱 runner 的 node：GUI 子系统 exe（Subsystem=2）被守卫拒绝，console 子系统放行', async () => {
  await setFullAccessEnabled(false)
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  setSandboxRunnerResolver(async () => 'C:\\runner\\runner.js')
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const notepadExe = path.join(systemRoot, 'System32', 'notepad.exe')
  const cmdExe = path.join(systemRoot, 'System32', 'cmd.exe')
  // 判据基线：打印本机实测期望值（2 = GUI ⇒ 拒绝 / 3 = console ⇒ 放行），逐条与断言对照。
  const notepadSub = await peSubsystem(notepadExe)
  const cmdSub = await peSubsystem(cmdExe)
  const execSub = await peSubsystem(process.execPath)
  console.log('[PE 子系统基线] notepad.exe=' + notepadSub + '（期望 2 = GUI ⇒ 拒绝）; cmd.exe=' + cmdSub
    + '（期望 3 = console ⇒ 放行）; process.execPath=' + process.execPath + '=' + execSub + '（期望 3 = console ⇒ 放行）')
  assert.equal(notepadSub, 2, 'notepad.exe 应是 GUI 子系统（实测 ' + notepadSub + '）')
  assert.equal(cmdSub, 3, 'cmd.exe 应是 console 子系统（实测 ' + cmdSub + '）')
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: fullPolicy(workdir) })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const exec = { agent: { session: { id: 's1' } } }
    const args = { name: 't', command: 'Write-Output ok', workdir, sandbox: 'workspace-write' }
    // ① GUI 子系统 ⇒ 响亮拒绝（带路径）+ 清理
    setNodeExeResolver(async () => notepadExe)
    const rejected = await submit.execute(args, exec)
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /GUI-subsystem executable/)
    assert.ok(rejected.error.includes(notepadExe), '错误应带上被拒的 exe 路径')
    assert.equal((await fsp.readdir(path.join(workdir, '.dsh', 'bgjobs')).catch(() => [])).length, 0, 'PE 守卫拒绝时应清理 job 目录')
    // ② console 子系统（cmd.exe）⇒ 放行并落盘 meta.nodeExe
    setNodeExeResolver(async () => cmdExe)
    const allowed = await submit.execute(args, exec)
    assert.equal(allowed.ok, true)
    const cmdMeta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', allowed.jobId, 'job.json'), 'utf8'))
    assert.equal(cmdMeta.nodeExe, cmdExe)
    // ③ process.execPath：期望值由本机实测子系统决定（node --test 下 = 3 ⇒ 放行；Electron 下 = 2 ⇒ 拒绝）
    setNodeExeResolver(async () => process.execPath)
    const execRes = await submit.execute(args, exec)
    if (execSub === 2) {
      assert.equal(execRes.ok, false, 'GUI 子系统的 execPath 应被拒（实测 ' + execSub + '）')
      assert.match(execRes.error, /GUI-subsystem executable/)
    } else {
      assert.equal(execRes.ok, true, 'console 子系统/非 PE 的 execPath 应放行（实测 ' + execSub + '）')
      const execMeta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', execRes.jobId, 'job.json'), 'utf8'))
      assert.equal(execMeta.nodeExe, process.execPath)
    }
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('setNodeExeResolver 注入缝：替换沙箱 node 解析；解析不出真 node ⇒ 明确报错 + 清理', async () => {
  await setFullAccessEnabled(false)
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  setSandboxRunnerResolver(async () => 'C:\\runner\\runner.js')
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: fullPolicy(workdir) })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const exec = { agent: { session: { id: 's1' } } }
    const args = { name: 't', command: 'Write-Output ok', workdir, sandbox: 'workspace-write' }
    setNodeExeResolver(async () => 'C:\\fake\\node.exe')
    const ok = await submit.execute(args, exec)
    assert.equal(ok.ok, true)
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', ok.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.nodeExe, 'C:\\fake\\node.exe', '注入的解析器结果应落盘 meta.nodeExe（PE 读不到 ⇒ 守卫放行）')
    // 解析不出（桌面版 PATH 上没有 node）⇒ fail-closed 明确报错，绝不退回 execPath 假成功
    setNodeExeResolver(async () => null)
    const bad = await submit.execute(args, exec)
    assert.equal(bad.ok, false)
    assert.match(bad.error, /node executable not found/)
    const leftovers = await fsp.readdir(path.join(workdir, '.dsh', 'bgjobs')).catch(() => [])
    assert.deepEqual(leftovers, [ok.jobId], '解析失败应清理自己的 job 目录（只留前一条成功的）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('suspect 标记：沙箱任务秒退 + 日志只含 [BGJOB] marker ⇒ 记提示字段（不改状态/退出码语义）', async () => {
  await setFullAccessEnabled(false)
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  setSandboxRunnerResolver(async () => 'C:\\runner\\runner.js')
  setNodeExeResolver(async () => process.execPath)
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({ services: fullPolicy(workdir) })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const tick = intervals.find((i) => i.ms === 1000).fn
    const exec = { agent: { session: { id: 's1' } } }
    const base = { name: 't', command: 'Write-Output ok', workdir }
    const finish = async (args, logText) => {
      const res = await submit.execute(args, exec)
      assert.equal(res.ok, true)
      const jobDir = path.join(workdir, '.dsh', 'bgjobs', res.jobId)
      await fsp.writeFile(path.join(jobDir, 'stdout.log'), logText, 'utf8')
      await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
      await tick()
      return { jobId: res.jobId, meta: JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8')) }
    }
    // ① bug 指纹：沙箱 + 秒退 + exit 0 + 日志仅 runner 自己的 marker
    const suspectJob = await finish({ ...base, sandbox: 'workspace-write' }, '[BGJOB] exit code: 0\r\n')
    assert.equal(suspectJob.meta.status, 'done')
    assert.equal(suspectJob.meta.exitCode, 0, 'suspect 只是提示：退出码语义不变')
    assert.equal(suspectJob.meta.suspect, 'sandbox-runner-no-output')
    // ② 沙箱 + 有真实输出 ⇒ 不标
    const normalJob = await finish({ ...base, sandbox: 'workspace-write' }, 'hello\r\n[BGJOB] exit code: 0\r\n')
    assert.equal(normalJob.meta.suspect, undefined, '有真实输出的沙箱任务不得被标')
    // ③ 非沙箱任务同样秒退 + 空日志 ⇒ 不标（判据只看沙箱任务）
    const plainJob = await finish(base, '[BGJOB] exit code: 0\r\n')
    assert.equal(plainJob.meta.suspect, undefined, '非沙箱任务不适用该提示')
    // ④ /bgjobs/state 视图带出提示字段（面板可展示），其余任务不带
    const state = attachWebServer(ctx, injectCallbacks)()
    let body = ''
    await state.handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.find((j) => j.id === suspectJob.jobId).suspect, 'sandbox-runner-no-output')
    assert.equal(jobs.find((j) => j.id === normalJob.jobId).suspect, undefined, '无标记的任务不应出现 suspect 字段')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})
