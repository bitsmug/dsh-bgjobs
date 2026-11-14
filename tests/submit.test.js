// bgjobs tests —— 提交路径（v0.1.61 自 tests/index.test.js 拆分）。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, strip, buildBat, buildCmdBat, buildPwshRunner, buildPs1, buildLaunchVbs, parseExitCode,
  jobSandboxDecision, shouldNotifyForExit,
  setSchtasksRunner, setShellResolver, setSandboxRunnerResolver,
  resolveBgjobsHome, bgjobsIndexPath, readBgjobsIndex, writeBgjobsIndex,
  updateBgjobsIndex, rebuildBgjobsIndex, buildBgjobsGuidance, buildPwshEnvelope,
  LAUNCHER_SCRIPT, setWshProbe,
} from '../lib/index.js'
// v0.2.6：解释器解析（跳过 MSIX 应用执行别名）——直接取内部实现与解析缝来钉分支
import { resolveShellImpl, isMsixAliasPath, setShellProbes } from '../lib/runners.js'
import {
  makeDshHome, makeWorkdir, makeCtx, makeFakeRunner, attachWebServer,
  runningPlugin, waitFor, setFullAccessEnabled, restrictedPolicy, fullPolicy,
  agentHandle, submitAndFinish, scheduleExitWrite, installSuiteHooks, captureTaskAction,
} from './helpers/common.js'

installSuiteHooks()

// ─────────────────────────────────────────────────────────────────────────────
// PowerShell 解释器解析（v0.2.6）：★ 跳过 MSIX 应用执行别名
//
// 现场：本机**没装 MSI 版 pwsh7**（`%ProgramFiles%\PowerShell\7\pwsh.exe` 不存在）⇒ 旧逻辑经
// `where pwsh` 命中 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`（**MSIX 应用执行别名**）；
// 而 MXC 沙箱容器**拒绝启动 MSIX 打包应用**（`… appears to be a packaged (MSIX) app. Packaged
// apps cannot be launched inside a sandboxed container.` / `backend_error`）⇒ dsh 沙箱任务连锁失败
// 修复：跳过 MSIX 别名（本机最终解析到 5.1 powershell.exe）。
// ─────────────────────────────────────────────────────────────────────────────
const MSIX_PWSH = 'X:\\Users\\demo\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
const MSIX_PS = 'X:\\Users\\demo\\AppData\\Local\\Microsoft\\WindowsApps\\powershell.exe'
const PS51 = path.join(process.env.SystemRoot || 'X:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** 注入解析缝：access 白名单 + whereAll 合成输出（大小写不敏感，模拟 Windows 行为）。 */
function stubShellProbes({ where = {}, access = [] } = {}) {
  const accessSet = new Set(access.map((s) => String(s).toLowerCase()))
  setShellProbes(async () => ({
    access: async (p) => {
      if (!accessSet.has(String(p).toLowerCase())) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    },
    whereAll: async (name) => where[name] || [],
  }))
}
after(() => setShellProbes(null))

test('isMsixAliasPath：WindowsApps 别名 ✓ / 便携版与 MSI 版 ✗（正反例）', () => {
  assert.equal(isMsixAliasPath(MSIX_PWSH), true)
  assert.equal(isMsixAliasPath(MSIX_PS), true)
  assert.equal(isMsixAliasPath('X:\\pwsh7.7\\pwsh.exe'), false)
  assert.equal(isMsixAliasPath('X:\\Program Files\\PowerShell\\7\\pwsh.exe'), false)
  assert.equal(isMsixAliasPath(''), false)
})

test('resolveShellImpl：where pwsh 只命中 MSIX 别名 ⇒ 跳过并回落 5.1（绝不选 MSIX）', async () => {
  stubShellProbes({ where: { pwsh: [MSIX_PWSH] }, access: [PS51] })
  const r = await resolveShellImpl()
  assert.equal(r.exe, PS51)
  assert.equal(r.engine, 'powershell')
})

test('resolveShellImpl：where pwsh 多条命中 ⇒ 取第一个非 MSIX', async () => {
  const portable = 'X:\\pwsh7.7\\pwsh.exe'
  stubShellProbes({ where: { pwsh: [MSIX_PWSH, portable] }, access: [] })
  const r = await resolveShellImpl()
  assert.equal(r.exe, portable)
  assert.equal(r.engine, 'pwsh')
})

test('resolveShellImpl：BGJOBS_PWSH 可访问 ⇒ 最高优先（压过 ProgramFiles/where/5.1）', async () => {
  const override = 'X:\\pwsh7.7\\pwsh.exe'
  const old = process.env.BGJOBS_PWSH
  process.env.BGJOBS_PWSH = override
  try {
    stubShellProbes({ where: { pwsh: [MSIX_PWSH] }, access: [override, PS51] })
    const r = await resolveShellImpl()
    assert.equal(r.exe, override)
    assert.equal(r.engine, 'pwsh')
  } finally {
    if (old === undefined) delete process.env.BGJOBS_PWSH
    else process.env.BGJOBS_PWSH = old
  }
})

test('resolveShellImpl：全部候选都是 MSIX ⇒ 返回 null（fail loud，不退化成 MSIX）', async () => {
  stubShellProbes({ where: { pwsh: [MSIX_PWSH], powershell: [MSIX_PS] }, access: [] })
  assert.equal(await resolveShellImpl(), null)
})

test('submitJob: 成功路径完整落盘（run.bat+cmd.bat+job.json）+ /Create /Run /Delete 调用', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo ok', workdir, engine: 'bat' }, { agent: undefined })
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
      '"' + (process.env.SystemRoot || 'X:\\Windows') + '\\System32\\wscript.exe" "' + jobDir + '\\launch.vbs"',
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
    const res = await submit.execute({ name: 't', command: 'echo x', workdir, engine: 'bat' }, { agent: undefined })
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
    const res = await submit.execute({ name: 't', command: 'echo x', workdir, engine: 'bat' }, { agent: undefined })
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


test('submitJob(pwsh): 描述符链路 —— 工作区只留记录（cmd.ps1），任务定义 = node host.mjs <jobDir> <descriptor>', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'X:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const command = "Write-Output '中文'\nexit 2"
    const res = await submit.execute({ name: 'pwsh-job', command, workdir }, { agent: undefined })
    assert.equal(res.ok, true, res.error)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    // v0.4：工作区不再有任何可执行脚本（执行输入全在任务定义里）
    for (const name of ['job.ps1', 'run.ps1', 'cmd.bat', 'run.bat']) {
      assert.equal(await fsp.stat(path.join(jobDir, name)).catch(() => null), null, '描述符链路不得生成 ' + name)
    }
    // cmd.ps1 只是人读记录：UTF-8 BOM + 原始命令（CRLF 归一），不含信封
    const recBuf = await fsp.readFile(path.join(jobDir, 'cmd.ps1'))
    assert.deepEqual([recBuf[0], recBuf[1], recBuf[2]], [0xef, 0xbb, 0xbf], 'cmd.ps1 应为 UTF-8 with BOM')
    assert.equal(recBuf.toString('utf8'), '\ufeff' + "Write-Output '中文'\r\nexit 2\r\n")
    // meta
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.engine, 'pwsh')
    assert.equal(meta.interpreter, 'X:\\fake\\pwsh.exe')
    assert.equal(meta.layout, 2)
    assert.equal(meta.recordPath, path.join(jobDir, 'cmd.ps1'))
    assert.ok(typeof meta.nodeExe === 'string' && meta.nodeExe.toLowerCase().endsWith('node.exe'), '任务定义的 execute 必须是真 node')
    assert.equal(meta.status, 'running')
    // 任务定义：<node.exe> "<host.mjs>" "<jobDir>" "<descriptor>"（CIM 注册 = 一次 -EncodedCommand）
    const action = captureTaskAction(calls)
    assert.equal(action.execute, meta.nodeExe)
    assert.ok(action.hostScript.endsWith('host.mjs'), '第二段应是 host.mjs 绝对路径')
    assert.equal(action.jobDir, jobDir)
    assert.equal(action.descriptor.id, res.jobId)
    assert.equal(action.descriptor.m, 'direct')
    assert.equal(action.descriptor.e, 'pwsh')
    assert.equal(action.descriptor.o, 'auto')
    assert.equal(action.descriptor.c, command)
    assert.equal(action.descriptor.w, workdir)
    assert.ok(!calls.some((argv) => argv.includes('/Create')), '描述符链路不得再用 schtasks /Create /TR')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): 启动开关关（缺省）⇒ 任务定义仍是 node 直连（rootKind=direct，零附加文件）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'X:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 'direct-launch', command: 'echo x', workdir }, { agent: undefined })
    assert.equal(res.ok, true, res.error)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.rootKind, 'direct')
    assert.equal(meta.launch, 'direct')
    assert.equal(captureTaskAction(calls).execute, meta.nodeExe, '缺省必须是 node 直连（逐字同改动前）')
    assert.equal(await fsp.stat(path.join(jobDir, 'launch.vbs')).catch(() => null), null, '缺省不得产生启动器副本')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): 启动开关开 ⇒ 任务定义 = wscript //B + 包内 launch.vbs（rootKind=shim）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'X:\\fake\\pwsh.exe', engine: 'pwsh' }))
  setWshProbe(() => false) // 确定性：不读真实注册表
  const home = process.env.DSH_HOME
  await fsp.mkdir(path.join(home, 'bgjobs'), { recursive: true })
  await fsp.writeFile(path.join(home, 'bgjobs', 'launch.json'), JSON.stringify({ enabled: true }), 'utf8')
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 'hidden-launch', command: 'echo x', workdir }, { agent: undefined })
    assert.equal(res.ok, true, res.error)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.rootKind, 'shim')
    assert.equal(meta.launch, 'wscript-shim')
    const action = captureTaskAction(calls)
    assert.match(action.execute, /wscript\.exe$/i)
    assert.deepEqual(action.tokens.slice(0, 2), ['//B', '//Nologo'], '//B 抑制错误弹窗')
    assert.equal(action.tokens[2], LAUNCHER_SCRIPT, '必须引用包内静态资产（L9：不按作业生成）')
    assert.equal(action.tokens[3], jobDir, 'errorDir = 该任务目录')
    assert.equal(action.tokens[4], meta.nodeExe, '目标 execute 必须是 node')
    assert.ok(action.tokens[5].endsWith('host.mjs'))
    assert.equal(action.tokens[6], jobDir)
    assert.equal(action.descriptor.id, res.jobId)
    assert.equal(await fsp.stat(path.join(jobDir, 'launch.vbs')).catch(() => null), null, 'jobDir 只放数据')
  } finally {
    await fsp.writeFile(path.join(home, 'bgjobs', 'launch.json'), JSON.stringify({ enabled: false }), 'utf8').catch(() => {})
    setWshProbe(null)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): 开关开但 WSH 被禁 ⇒ 降级 direct + warning（任务仍可跑）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'X:\\fake\\pwsh.exe', engine: 'pwsh' }))
  setWshProbe(() => true) // 模拟 WSH 被策略禁用
  const home = process.env.DSH_HOME
  await fsp.mkdir(path.join(home, 'bgjobs'), { recursive: true })
  await fsp.writeFile(path.join(home, 'bgjobs', 'launch.json'), JSON.stringify({ enabled: true }), 'utf8')
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 'wsh-disabled', command: 'echo x', workdir }, { agent: undefined })
    assert.equal(res.ok, true, res.error)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.rootKind, 'direct', 'WSH 不可用不得写 shim')
    const action = captureTaskAction(calls)
    assert.doesNotMatch(action.execute, /wscript\.exe$/i)
    assert.ok(Array.isArray(res.warnings) && res.warnings.some((w) => w.includes('Script Host')), '应回降级 warning：' + JSON.stringify(res.warnings))
  } finally {
    await fsp.writeFile(path.join(home, 'bgjobs', 'launch.json'), JSON.stringify({ enabled: false }), 'utf8').catch(() => {})
    setWshProbe(null)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): options.env ⇒ 命令前缀（不是进程注入），TMP 不再被剔除', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'X:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({
      name: 'env-job', command: 'Write-Output $env:FOO', workdir,
      options: { env: { FOO: "it's", TMP: 'X:\\tmp\\bg' } },
    }, { agent: undefined })
    assert.equal(res.ok, true, res.error)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.deepEqual(meta.env, { FOO: "it's", TMP: 'X:\\tmp\\bg' }, '原值仍落盘可查')
    // 记录文件 = 前缀 + 原始命令（可复制重跑）
    const record = (await fsp.readFile(path.join(jobDir, 'cmd.ps1'))).toString('utf8')
    assert.equal(record, "\ufeff$env:FOO = 'it''s'\r\n$env:TMP = 'X:\\tmp\\bg'\r\nWrite-Output $env:FOO\r\n")
    // 描述符：c 自带前缀，且不再有 x
    const action = captureTaskAction(calls)
    assert.equal(action.descriptor.c, "$env:FOO = 'it''s'\r\n$env:TMP = 'X:\\tmp\\bg'\r\nWrite-Output $env:FOO")
    assert.equal('x' in action.descriptor, false, 'env 不再走进程注入通道')
    assert.equal(meta.effectiveCommand, action.descriptor.c)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('submitJob(pwsh): 非法 env（键名/对象值/换行）⇒ 提交期 fail loud 且不建任务', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'X:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    for (const env of [{ 'A-B': 'v' }, { FOO: { a: 1 } }, { FOO: 'a\nb' }]) {
      const res = await submit.execute({ name: 'bad-env', command: 'echo ok', workdir, options: { env } }, { agent: undefined })
      assert.equal(res.ok, false)
      assert.match(res.error, /^env:/, '错误必须点名 env：' + res.error)
    }
    assert.deepEqual(calls, [], '校验失败不得注册任务')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('submitJob(pwsh): 解释器是 powershell.exe（5.1）⇒ meta 记录，运行期信封写编码 preamble', async () => {
  const PS51 = 'X:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: PS51, engine: 'powershell' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 'pwsh51-job', command: "Write-Output '中文'", workdir }, { agent: undefined })
    assert.equal(res.ok, true, res.error)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const meta51 = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta51.interpreter, PS51)
    // 信封不在工作区，由 host 运行期生成：直接验收同一纯函数的产物
    const envelope = buildPwshEnvelope(meta51.command, { encoding: meta51.outputEncoding, interpreter: PS51 })
    assert.ok(envelope.startsWith('# bgjobs: 强制 UTF-8 输出'), '5.1：首行应是 preamble 注释')
    assert.ok(envelope.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'), '5.1：应设 Console.OutputEncoding')
    assert.ok(envelope.includes('$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'), '5.1：应设 $OutputEncoding')
    assert.ok(!envelope.includes('Add-Type'))
    assert.ok(envelope.includes("Write-Output '中文'"))
    assert.equal(captureTaskAction(calls).descriptor.m, 'direct')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): output_encoding=native ⇒ 描述符 o=native，信封按继承码页（v0.2.6）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'X:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 'native-job', command: "Write-Output '中文'", workdir, output_encoding: 'native' }, { agent: undefined })
    assert.equal(res.ok, true, res.error)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const metaNative = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(metaNative.outputEncoding, 'native', "meta.outputEncoding 应落盘 'native'")
    assert.equal(captureTaskAction(calls).descriptor.o, 'native', '描述符 o 必须携带逐任务编码')
    const envelope = buildPwshEnvelope(metaNative.command, { encoding: 'native', interpreter: metaNative.interpreter })
    assert.ok(envelope.includes('$bgjobNative = [Console]::OutputEncoding'), 'native：先取继承码页')
    assert.ok(envelope.includes('[Console]::OutputEncoding = $bgjobNative'), 'native：用继承码页解码')
    assert.ok(!envelope.includes('[Console]::OutputEncoding = $bgjobUtf8'), 'native：不得按 UTF-8 解码')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): 缺省（不传）⇒ o=auto 与 utf8 同按 UTF-8 输出；显式 utf8 ⇒ o=utf8（v0.3.2 / v0.4）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'X:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    // 缺省（不传）：auto（v0.3.2 破坏性变更：原缺省 utf8）
    const def = await submit.execute({ name: 'default-enc', command: 'echo ok', workdir }, { agent: undefined })
    assert.equal(def.ok, true, def.error)
    const defMeta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', def.jobId, 'job.json'), 'utf8'))
    assert.equal(defMeta.outputEncoding, 'auto', '缺省（不传）应落盘 auto')
    assert.equal(captureTaskAction(calls).descriptor.o, 'auto')
    const defEnvelope = buildPwshEnvelope('echo ok', { encoding: 'auto', interpreter: defMeta.interpreter })
    assert.ok(defEnvelope.includes('GetEncoding(28591)'), 'auto：native 字节按 28591 成像（字节级无损）')
    assert.ok(defEnvelope.includes('[Console]::SetOut($bgjobOut)'), 'auto：PS 自身输出（含 Write-Host）走显式 UTF-8 写入器')
    assert.ok(!defEnvelope.includes('$bgjobNative'), 'auto 不得含 native 分支')
    // 显式 utf8：同样按 UTF-8（0.3.1 逐字节承诺仅对显式取值保留）
    const utf8Res = await submit.execute({ name: 'utf8-enc', command: 'echo ok', workdir, output_encoding: 'utf8' }, { agent: undefined })
    assert.equal(utf8Res.ok, true, utf8Res.error)
    const utf8Meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', utf8Res.jobId, 'job.json'), 'utf8'))
    assert.equal(utf8Meta.outputEncoding, 'utf8', "显式 utf8 应落盘 'utf8'")
    const utf8Envelope = buildPwshEnvelope('echo ok', { encoding: 'utf8', interpreter: utf8Meta.interpreter })
    assert.ok(utf8Envelope.includes('[Console]::OutputEncoding = $bgjobUtf8'), '显式 utf8 仍按 UTF-8 输出')
    assert.ok(!utf8Envelope.includes('$bgjobNative'), '显式 utf8 不得含 native 分支')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('submitJob(pwsh): 非法 output_encoding ⇒ fail loud 且零副作用（v0.2.6）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => ({ exe: 'X:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    // 非法值：fail loud + 不建 jobDir / 不建计划任务
    for (const bad of ['utf-16', 'NATIVE', 'gbk']) {
      const r = await submit.execute({ name: 'bad-enc', command: 'echo ok', workdir, output_encoding: bad }, { agent: undefined })
      assert.equal(r.ok, false, 'output_encoding=' + bad + ' 必须被拒')
      assert.ok(String(r.error).includes('invalid output_encoding'), '错误应指明 invalid output_encoding，实际: ' + r.error)
    }
    const entries = await fsp.readdir(path.join(workdir, '.dsh', 'bgjobs')).catch(() => [])
    assert.deepEqual(entries.filter((n) => n.startsWith('bg-')), [], '被拒的提交不得留下 jobDir（零副作用）')
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
    const submit = tools.find((t) => t.name === 'bgjob_submit')
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


test('T5: 项目 .dsh/bgjobs.json 的 submit 默认经工具入口生效（notify 被项目值覆盖）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  await fsp.mkdir(path.join(workdir, '.dsh'), { recursive: true })
  await fsp.writeFile(
    path.join(workdir, '.dsh', 'bgjobs.json'),
    JSON.stringify({ submit: { notify: 'on-exit' } }),
    'utf8'
  )
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-t5', header: { cwd: workdir } } } }
    // 用 bat 引擎：不依赖 pwsh 解析（本文件其它用例会改 shell 探针）；notify 通过项目默认传入
    const res = await submit.execute({ name: 't5', engine: 'bat', command: 'echo ok', workdir }, exec)
    assert.equal(res.ok, true, 'T5: submit 应成功，实际 res=' + JSON.stringify(res))
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.notify, 'on-exit', '项目默认 notify 应经工具入口生效；meta=' + JSON.stringify(meta).slice(0, 300))
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('认知负担: workdir 可省 ⇒ 缺省用当前会话工作目录', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-wd', header: { cwd: workdir } } } }
    // 只给 name + engine + command，完全不给 workdir
    const res = await submit.execute({ name: 'wd', engine: 'bat', command: 'echo ok' }, exec)
    assert.equal(res.ok, true, 'workdir 省略时应成功，res=' + JSON.stringify(res))
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'job.json'), 'utf8'))
    assert.equal(path.resolve(meta.workdir), path.resolve(workdir), 'workdir 应缺省为会话 cwd')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('认知负担: name 可省 ⇒ 取 command 首行前 24 字', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-name', header: { cwd: workdir } } } }
    const res = await submit.execute({ engine: 'bat', command: 'echo first-line\necho second' }, exec)
    assert.equal(res.ok, true, 'res=' + JSON.stringify(res))
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.name, 'echo first-line', 'name 应取 command 首行；实际=' + meta.name)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('认知负担: 命令里没有 exit ⇒ 返回 warning（退出码可能假成功）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-warn', header: { cwd: workdir } } } }
    const noExit = await submit.execute({ engine: 'bat', command: 'echo ok' }, exec)
    assert.ok(Array.isArray(noExit.warnings) && noExit.warnings.some((w) => w.includes('exit')), '缺 exit 应给 warning')
    const withExit = await submit.execute({ engine: 'bat', command: 'echo ok\nexit 0' }, exec)
    assert.ok(!Array.isArray(withExit.warnings) || !withExit.warnings.some((w) => w.includes('退出码可能恒为 0')), '有 exit 时不应给该 warning')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('④ submit.env: 注入的环境变量写进 cmd.bat（pwsh 与 bat 两个引擎共用该文件）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-env', header: { cwd: workdir } } } }
    const res = await submit.execute({
      engine: 'bat',
      command: 'echo ok',
      options: { env: { MATLAB_PREFDIR: 'X:\\A\\.dsh\\matlab-prefs', TEMP: 'X:\\A\\.dsh\\tmp' } },
    }, exec)
    assert.equal(res.ok, true, 'res=' + JSON.stringify(res))
    const cmd = await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'cmd.bat'), 'utf8')
    assert.ok(cmd.includes('set MATLAB_PREFDIR=X:\\A\\.dsh\\matlab-prefs'), 'cmd.bat 应含 env 的 set 行；实际头部=' + cmd.slice(0, 200))
    assert.ok(cmd.includes('set TEMP='), 'cmd.bat 应含 TEMP')
    assert.ok(cmd.trim().endsWith('echo ok'), '命令本体应在 env 行之后；实际=' + cmd.slice(-80))
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── R1 + R3 守新契约 ───────────────────────────────────────────────

test('R1: bgjob_submit 不再接受 mcp 参数（指路 bgjob_submit_mcp）', async () => {
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-r1', header: { cwd: process.cwd() } } } }
    const a = await submit.execute({ name: 'x', command: 'echo ok', tool: 'echo', server: 'demo' }, exec)
    assert.equal(a.ok, false, 'raw=' + JSON.stringify(a))
    assert.ok(a.error.includes('bgjob_submit_mcp'), 'error 应指路 bgjob_submit_mcp：' + a.error)
    const b = await submit.execute({ name: 'x', engine: 'mcp', command: 'echo ok' }, exec)
    assert.equal(b.ok, false, 'raw=' + JSON.stringify(b))
    assert.ok(b.error.includes('bgjob_submit_mcp'), 'error 应指路：' + b.error)
  } finally { dispose() }
})

test('R3: bgjob_submit 顶层字段 = 5（env 降级进袋），options 袋 = 8', () => {
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const t = tools.find((x) => x.name === 'bgjob_submit')
    assert.deepEqual(Object.keys(t.parameters.properties).sort(), ['command', 'engine', 'name', 'options', 'workdir'])
    assert.deepEqual(t.parameters.required, ['command'], 'required 只有 command（name/workdir 有缺省）')
    const bag = t.parameters.properties.options
    assert.equal(bag.type, 'object')
    assert.equal(bag.additionalProperties, true, 'A 方案：袋用 true，未知键由插件告警')
    assert.deepEqual(Object.keys(bag.properties).sort(), ['env', 'justification', 'notify', 'notify_mode', 'output_encoding', 'sandbox', 'sandbox_backend', 'wait'])
  } finally { dispose() }
})

test('R3: options 袋内的 notify 生效（落到 job.json）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-bag', header: { cwd: workdir } } } }
    const res = await submit.execute({ engine: 'bat', command: 'echo ok', options: { notify: 'on-exit' } }, exec)
    assert.equal(res.ok, true, 'res=' + JSON.stringify(res))
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.notify, 'on-exit', '袋内 notify 应生效；meta.notify=' + meta.notify)
  } finally { dispose(); await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {}) }
})

test('R3: 平铺优先于 options 袋（混用时平铺赢）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-flat', header: { cwd: workdir } } } }
    const res = await submit.execute({ engine: 'bat', command: 'echo ok', notify: 'on-fail', options: { notify: 'on-exit' } }, exec)
    assert.equal(res.ok, true, 'res=' + JSON.stringify(res))
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', res.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.notify, 'on-fail', '平铺应覆盖袋；meta.notify=' + meta.notify)
  } finally { dispose(); await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {}) }
})

test('R3: options 袋里未知键只告警、提交仍成功', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-unknown', header: { cwd: workdir } } } }
    const res = await submit.execute({ engine: 'bat', command: 'echo ok', options: { nosuchkey: 1 } }, exec)
    assert.equal(res.ok, true, '未知袋键不应导致失败；res=' + JSON.stringify(res))
    assert.ok(Array.isArray(res.warnings) && res.warnings.some((w) => w.includes('nosuchkey')), 'warnings 应点名未知键：' + JSON.stringify(res.warnings))
  } finally { dispose(); await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {}) }
})
test('认知负担: 行内 `; exit $c` 不应误报"没有 exit"（v0.3.3 修）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's-inline-exit', header: { cwd: workdir } } } }
    const inlineExit = "Write-Output 'x'; $c = $LASTEXITCODE; exit $c"
    const r = await submit.execute({ engine: 'bat', command: inlineExit }, exec)
    assert.ok(
      !Array.isArray(r.warnings) || !r.warnings.some((w) => w.includes('退出码可能恒为 0')),
      '行内 ; exit $c 已有 exit，不该告警；实际 warnings=' + JSON.stringify(r.warnings),
    )
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})