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
    assert.equal(meta.nodeExe, process.execPath)
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
