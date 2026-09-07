// bgjobs tests —— 提交路径（v0.1.61 自 tests/index.test.js 拆分）。
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

test('submitJob: 成功路径完整落盘（run.bat+cmd.bat+job.json）+ /Create /Run /Delete 调用', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo ok', workdir }, { agent: undefined })
    assert.equal(res.ok, true)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'running')
    assert.equal(meta.name, 't')
    const bat = await fsp.readFile(path.join(jobDir, 'run.bat'), 'utf8')
    assert.ok(bat.includes('call "' + meta.cmdPath + '" >>'))
    const cmd = await fsp.readFile(path.join(jobDir, 'cmd.bat'), 'utf8')
    assert.equal(cmd, 'echo ok\r\n')
    // 隐藏窗口启动器：launch.vbs（纯 ASCII）+ /TR 经 wscript.exe 执行
    const vbs = await fsp.readFile(path.join(jobDir, 'launch.vbs'), 'utf8')
    assert.match(vbs, /^[\x00-\x7F]*$/, 'launch.vbs 应为纯 ASCII')
    assert.ok(vbs.includes('GetParentFolderName(WScript.ScriptFullName)'))
    assert.ok(vbs.includes('"\\run.bat""", 0, True'))
    const createCall = calls.find((argv) => argv.includes('/Create'))
    const trIdx = createCall.indexOf('/TR')
    assert.equal(
      createCall[trIdx + 1],
      '"' + (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\wscript.exe" "' + jobDir + '\\launch.vbs"',
      '/TR 应经 wscript.exe 隐藏启动 run.bat'
    )
    assert.ok(calls.some((argv) => argv.includes('/Create')))
    assert.ok(calls.some((argv) => argv.includes('/Run')))
    // /Run 成功后立即 /Change /DISABLE（防 /ST 整分双跑；禁用而非删除，防排队实例被丢弃）
    const runIdx = calls.findIndex((argv) => argv.includes('/Run'))
    const disableIdx = calls.findIndex((argv) => argv.includes('/DISABLE'))
    assert.ok(runIdx >= 0 && disableIdx > runIdx, '/Run 成功后应立即 /Change /DISABLE 任务计划')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob: /Create 失败时清理目录且不调用 /Run', async () => {
  const calls = []
  setSchtasksRunner(async (argv, _cwd) => {
    calls.push(argv)
    return argv.includes('/Create')
      ? { exitCode: 1, stdout: '', stderr: 'create denied' }
      : { exitCode: 0, stdout: '', stderr: '' }
  })
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    assert.equal(res.ok, false)
    assert.match(res.error, /schtasks create failed/)
    const jobsRoot = workdir + '\\.dsh\\bgjobs'
    const leftovers = await fsp.readdir(jobsRoot).catch(() => [])
    assert.equal(leftovers.length, 0, '失败后 job 目录应被清理')
    assert.ok(!calls.some((argv) => argv.includes('/Run')), '/Create 失败不应 /Run')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob: /Run 失败时删除残留任务计划并清理目录', async () => {
  const calls = []
  setSchtasksRunner(async (argv, _cwd) => {
    calls.push(argv)
    return argv.includes('/Run')
      ? { exitCode: 1, stdout: '', stderr: 'run denied' }
      : { exitCode: 0, stdout: '', stderr: '' }
  })
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    assert.equal(res.ok, false)
    assert.match(res.error, /schtasks run failed/)
    const jobsRoot = workdir + '\\.dsh\\bgjobs'
    const leftovers = await fsp.readdir(jobsRoot).catch(() => [])
    assert.equal(leftovers.length, 0, '失败后 job 目录应被清理')
    assert.ok(calls.some((argv) => argv.includes('/Delete')), '/Run 失败应删除残留任务计划')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): 写 job.ps1 + run.ps1（UTF-8 BOM，无 run.bat），/TR 直接调 interpreter -File run.ps1', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'C:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const res = await submit.execute({ name: 'pwsh-job', command: "Write-Output '中文'\nexit 2", workdir }, { agent: undefined })
    assert.equal(res.ok, true)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    // job.ps1：以 UTF-8 BOM 开头（5.1 无 BOM 按 GBK 读会乱），preamble + 命令原样
    const ps1Buf = await fsp.readFile(path.join(jobDir, 'job.ps1'))
    assert.deepEqual([ps1Buf[0], ps1Buf[1], ps1Buf[2]], [0xef, 0xbb, 0xbf], 'job.ps1 应为 UTF-8 with BOM')
    const ps1 = ps1Buf.toString('utf8')
    assert.ok(ps1.startsWith('\ufeff# bgjobs: 强制 UTF-8 输出'))
    assert.ok(ps1.includes("Write-Output '中文'"))
    assert.ok(ps1.includes('exit 2'))
    // 无 cmd.bat、无 run.bat（pwsh 引擎不再生成 cmd 中间层）
    assert.equal(await fsp.stat(path.join(jobDir, 'cmd.bat')).catch(() => null), null, 'pwsh 任务不应生成 cmd.bat')
    assert.equal(await fsp.stat(path.join(jobDir, 'run.bat')).catch(() => null), null, 'pwsh 任务不应生成 run.bat')
    // run.ps1：UTF-8 BOM + 包装脚本（& job.ps1 *> 重定向）
    const runnerBuf = await fsp.readFile(path.join(jobDir, 'run.ps1'))
    assert.deepEqual([runnerBuf[0], runnerBuf[1], runnerBuf[2]], [0xef, 0xbb, 0xbf], 'run.ps1 应为 UTF-8 with BOM')
    const runner = runnerBuf.toString('utf8')
    assert.ok(runner.includes("& '" + jobDir + "\\job.ps1' *> $logPath"))
    assert.ok(runner.includes("WriteAllText('" + jobDir + "\\exitcode.txt'"))
    // meta
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.engine, 'pwsh')
    assert.equal(meta.interpreter, 'C:\\fake\\pwsh.exe')
    assert.equal(meta.status, 'running')
    // schtasks：/Create 的 /TR 直接调 interpreter -File run.ps1（-WindowStyle Hidden 隐藏窗口，普通引号形式，Node 自会转义）；/Run 后 /DISABLE
    const createCall = calls.find((argv) => argv.includes('/Create'))
    const trIdx = createCall.indexOf('/TR')
    assert.equal(
      createCall[trIdx + 1],
      '"C:\\fake\\pwsh.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + jobDir + '\\run.ps1"',
      '/TR 应直接指向 pwsh -File run.ps1（带 -WindowStyle Hidden）'
    )
    assert.ok(calls.some((argv) => argv.includes('/Run')))
    const runIdx = calls.findIndex((argv) => argv.includes('/Run'))
    const disableIdx = calls.findIndex((argv) => argv.includes('/DISABLE'))
    assert.ok(runIdx >= 0 && disableIdx > runIdx, '/Run 成功后应立即 /Change /DISABLE 任务计划')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): PowerShell 未找到时返回错误并清理目录', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => null)
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    assert.equal(res.ok, false)
    assert.match(res.error, /PowerShell not found/)
    const jobsRoot = workdir + '\\.dsh\\bgjobs'
    const leftovers = await fsp.readdir(jobsRoot).catch(() => [])
    assert.equal(leftovers.length, 0, '失败后 job 目录应被清理')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── tick / 完成检测 ──

/** 构造一个已提交 running 任务的插件实例，返回 tick 与工具。 */
