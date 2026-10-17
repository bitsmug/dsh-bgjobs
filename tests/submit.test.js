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
  updateBgjobsIndex, rebuildBgjobsIndex, buildBgjobsGuidance,
} from '../lib/index.js'
// v0.2.6：解释器解析（跳过 MSIX 应用执行别名）——直接取内部实现与解析缝来钉分支
import { resolveShellImpl, isMsixAliasPath, setShellProbes } from '../lib/runners.js'
import {
  makeDshHome, makeWorkdir, makeCtx, makeFakeRunner, attachWebServer,
  runningPlugin, waitFor, setFullAccessEnabled, restrictedPolicy, fullPolicy,
  agentHandle, submitAndFinish, scheduleExitWrite, installSuiteHooks,
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
const MSIX_PWSH = 'C:\\Users\\demo\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
const MSIX_PS = 'C:\\Users\\demo\\AppData\\Local\\Microsoft\\WindowsApps\\powershell.exe'
const PS51 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

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
  assert.equal(isMsixAliasPath('C:\\pwsh7.7\\pwsh.exe'), false)
  assert.equal(isMsixAliasPath('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), false)
  assert.equal(isMsixAliasPath(''), false)
})

test('resolveShellImpl：where pwsh 只命中 MSIX 别名 ⇒ 跳过并回落 5.1（绝不选 MSIX）', async () => {
  stubShellProbes({ where: { pwsh: [MSIX_PWSH] }, access: [PS51] })
  const r = await resolveShellImpl()
  assert.equal(r.exe, PS51)
  assert.equal(r.engine, 'powershell')
})

test('resolveShellImpl：where pwsh 多条命中 ⇒ 取第一个非 MSIX', async () => {
  const portable = 'C:\\pwsh7.7\\pwsh.exe'
  stubShellProbes({ where: { pwsh: [MSIX_PWSH, portable] }, access: [] })
  const r = await resolveShellImpl()
  assert.equal(r.exe, portable)
  assert.equal(r.engine, 'pwsh')
})

test('resolveShellImpl：BGJOBS_PWSH 可访问 ⇒ 最高优先（压过 ProgramFiles/where/5.1）', async () => {
  const override = 'C:\\pwsh7.7\\pwsh.exe'
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
    // job.ps1：以 UTF-8 BOM 开头（5.1 无 BOM 按 GBK 读会乱）+ 命令原样；preamble 按解释器条件化
    const ps1Buf = await fsp.readFile(path.join(jobDir, 'job.ps1'))
    assert.deepEqual([ps1Buf[0], ps1Buf[1], ps1Buf[2]], [0xef, 0xbb, 0xbf], 'job.ps1 应为 UTF-8 with BOM')
    const ps1 = ps1Buf.toString('utf8')
    // v0.1.92 条件化：fake 解释器是 C:\fake\pwsh.exe（pwsh 7）⇒ 整段跳过编码 preamble，
    // 且不再含 Add-Type。5.1 分支的「preamble 存在」断言见紧随其后的用例（勿删，只是按解释器分支）。
    assert.ok(!ps1.startsWith('\ufeff# bgjobs: 强制 UTF-8 输出'), 'pwsh 7（C:\\fake\\pwsh.exe）不应写 preamble 注释')
    assert.ok(!ps1.includes('OutputEncoding'), 'pwsh 7 不应写任何编码设置')
    assert.ok(!ps1.includes('Add-Type'), 'v0.1.92：job.ps1 不再含 Add-Type（现编译 C#，+0.6 s/次且零语义）')
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


test('submitJob(pwsh): 解释器是 powershell.exe（5.1）时写编码 preamble（条件化的另一半，v0.1.92）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  setShellResolver(async () => ({ exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', engine: 'powershell' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const res = await submit.execute({ name: 'pwsh51-job', command: "Write-Output '中文'", workdir }, { agent: undefined })
    assert.equal(res.ok, true)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const ps51 = (await fsp.readFile(path.join(jobDir, 'job.ps1'))).toString('utf8')
    assert.ok(ps51.startsWith('\ufeff# bgjobs: 强制 UTF-8 输出'), '5.1：首行应是 preamble 注释')
    assert.ok(ps51.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'), '5.1：应设 Console.OutputEncoding')
    assert.ok(ps51.includes('$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'), '5.1：应设 $OutputEncoding')
    assert.ok(!ps51.includes('Add-Type'), '5.1 也不再含 Add-Type（乱码由 run.ps1 的 FF FE 转换兜底）')
    assert.ok(ps51.includes("Write-Output '中文'"))
    // 元数据与 /TR 同 5.1 解释器；run.ps1 的 FF FE 兜底转换仍在
    const meta51 = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta51.interpreter, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const runner51 = (await fsp.readFile(path.join(jobDir, 'run.ps1'))).toString('utf8')
    assert.ok(runner51.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'), '5.1：run.ps1 仍写编码设置')
    assert.ok(runner51.includes('0xFF') && runner51.includes('0xFE'), '5.1：FF FE 检测转换不得丢')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): output_encoding=native 落 meta 且 run.ps1 用 $nativeEnc（v0.2.6）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => ({ exe: 'C:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    const res = await submit.execute({ name: 'native-job', command: "Write-Output '中文'", workdir, output_encoding: 'native' }, { agent: undefined })
    assert.equal(res.ok, true)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const runner = (await fsp.readFile(path.join(jobDir, 'run.ps1'))).toString('utf8')
    assert.ok(runner.includes('$nativeEnc = [Console]::OutputEncoding'), 'native：run.ps1 先取继承码页')
    assert.ok(runner.includes('[Console]::OutputEncoding = $nativeEnc'), 'native：用 $nativeEnc 解码')
    assert.ok(!runner.includes('[Console]::OutputEncoding = $utf8'), 'native：不得按 UTF-8 解码')
    const metaNative = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(metaNative.outputEncoding, 'native', "meta.outputEncoding 应落盘 'native'")
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submitJob(pwsh): 缺省不写 meta.outputEncoding；非法 output_encoding ⇒ fail loud 且零副作用（v0.2.6）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => ({ exe: 'C:\\fake\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    // 缺省：meta 不含该键（job.json 与加参数之前一致）
    const def = await submit.execute({ name: 'default-enc', command: 'echo ok', workdir }, { agent: undefined })
    assert.equal(def.ok, true)
    const defMeta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', def.jobId, 'job.json'), 'utf8'))
    assert.equal(Object.prototype.hasOwnProperty.call(defMeta, 'outputEncoding'), false, '缺省不得写 outputEncoding')
    const defRunner = (await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', def.jobId, 'run.ps1'))).toString('utf8')
    assert.ok(!defRunner.includes('$nativeEnc'), '缺省 run.ps1 不得含 $nativeEnc')
    // 非法值：fail loud + 不建 jobDir / 不建计划任务
    for (const bad of ['utf-16', 'NATIVE', 'gbk']) {
      const r = await submit.execute({ name: 'bad-enc', command: 'echo ok', workdir, output_encoding: bad }, { agent: undefined })
      assert.equal(r.ok, false, 'output_encoding=' + bad + ' 必须被拒')
      assert.ok(String(r.error).includes('invalid output_encoding'), '错误应指明 invalid output_encoding，实际: ' + r.error)
    }
    const entries = await fsp.readdir(path.join(workdir, '.dsh', 'bgjobs')).catch(() => [])
    assert.deepEqual(entries.filter((n) => n.startsWith('bg-') && n !== def.jobId), [], '被拒的提交不得留下 jobDir（零副作用）')
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
