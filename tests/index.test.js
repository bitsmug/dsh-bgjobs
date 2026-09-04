// bgjobs host 半测试 —— node:test 零依赖，直接 import 源码（ESM）。
// 运行：node --test tests/
// schtasks 通过 setSchtasksRunner 替换为可控 fake；ctx 用轻量 mock。

import { test, beforeEach, after } from 'node:test'
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

// ── 测试工具 ──

/** 建一个临时 DSH home 并设置 DSH_HOME，返回清理函数。 */
async function makeDshHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-home-'))
  process.env.DSH_HOME = dir
  // legacy 语义：该 home 下提交默认 full access 放行（沙箱联动用例显式写 enabled=false）。
  await fsp.mkdir(path.join(dir, 'bgjobs'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'bgjobs', 'fullaccess.json'), JSON.stringify({ enabled: true }), 'utf8')
  return dir
}

// ── 套件级 DSH_HOME 隔离 ──
// recover 现按中央索引恢复（全局地图）：未隔离 DSH_HOME 的用例会读到真实的 ~/.dsh 索引
// （任务挂进注册表、计数断言被污染、剪枝还可能改动真实索引）。每个用例前重置一个全新
// 临时 home；makeDshHome 用例用自己的 home 并在 finally 删除 env，beforeEach 会在下一
// 个用例前重新铺好隔离 home。
let suiteHome = null
beforeEach(async () => {
  if (suiteHome) await fsp.rm(suiteHome, { recursive: true, force: true }).catch(() => {})
  suiteHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-suite-'))
  process.env.DSH_HOME = suiteHome
  // 套件默认 full access ON（沙箱联动功能 v0.1.29 之前的 legacy 语义）：
  // 无 sandboxPolicy 服务的用例照旧放行；需验证「拒绝/审批/继承」的用例自行写 enabled=false。
  await fsp.mkdir(path.join(suiteHome, 'bgjobs'), { recursive: true })
  await fsp.writeFile(path.join(suiteHome, 'bgjobs', 'fullaccess.json'), JSON.stringify({ enabled: true }), 'utf8')
})
after(async () => {
  if (suiteHome) await fsp.rm(suiteHome, { recursive: true, force: true }).catch(() => {})
  delete process.env.DSH_HOME
})

/** 建一个临时 workdir。 */
async function makeWorkdir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-test-'))
}

/** 构造一个 apply 可用的 mock ctx。 */
function makeCtx(overrides = {}) {
  const services = new Map(Object.entries(overrides.services || {}))
  const tools = []
  const intervals = []
  const injectCallbacks = new Map()
  const sections = []
  const onCallbacks = [] // ctx.on 事件监听（{ event, fn }）；测试可手动触发
  const ctx = {
    get(name) { return services.get(name) },
    interval(fn, ms) {
      const entry = { fn, ms, disposed: false }
      intervals.push(entry)
      return () => { entry.disposed = true }
    },
    on(event, fn) {
      onCallbacks.push({ event, fn })
      return () => {}
    },
    inject(names, cb) {
      injectCallbacks.set(names[0], cb)
      return () => {}
    },
    tools: { register(def) { tools.push(def); return () => {} } },
    systemPrompt: { section(def) { sections.push(def); return () => {} } },
  }
  return { ctx, tools, intervals, services, injectCallbacks, sections, onCallbacks }
}

/** 默认 fake schtasks：全部成功，记录调用。 */
function makeFakeRunner(log) {
  return async (argv, _cwd) => {
    log.push(argv)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

/** 挂 webServer，返回注册到的路由定义。 */
function attachWebServer(ctx, injectCallbacks) {
  let registered
  const webServer = { register: (def) => { registered = def; return () => {} } }
  injectCallbacks.get('webServer')({ webServer })
  return () => registered
}

// ── 单元测试：纯函数 ──

test('strip: 保留盘符根路径的尾部反斜杠', () => {
  assert.equal(strip('C:\\'), 'C:\\')
  assert.equal(strip('c:\\'), 'c:\\')
})

test('strip: 去掉普通路径尾部斜杠（/ 与 \\）', () => {
  assert.equal(strip('C:\\Users\\bgjobs-dev\\'), 'C:\\Users\\bgjobs-dev')
  assert.equal(strip('C:/Users/pseudo/'), 'C:/Users/pseudo')
  assert.equal(strip('C:\\Users'), 'C:\\Users')
})

test('parseExitCode: 正常/负数/无数字', () => {
  assert.equal(parseExitCode('0'), 0)
  assert.equal(parseExitCode('-1'), -1)
  assert.equal(parseExitCode(' 42 \n'), 42)
  assert.equal(parseExitCode('abc'), null)
  assert.equal(parseExitCode(''), null)
})

test('buildBat: run.bat 用 call 包裹子 bat 整体重定向，含 chcp 65001，无逐行重定向', () => {
  const job = {
    meta: {
      workdir: 'C:\\work', command: 'echo hi\n\necho bye', jsonPath: 'C:\\work\\job.json',
      logPath: 'C:\\work\\log.txt', exitcodePath: 'C:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  const bat = buildBat(job)
  assert.ok(bat.startsWith('@echo off\r\n'))
  assert.ok(bat.includes('>nul chcp 65001'))
  assert.ok(bat.includes('cd /d "C:\\work"'))
  // 命令被 call 包裹整体重定向到 cmd.bat（由 jsonPath 推导），不逐行重定向。
  assert.ok(bat.includes('call "C:\\work\\cmd.bat" >> "C:\\work\\log.txt" 2>&1'))
  assert.ok(!bat.includes('echo hi >> "C:\\work\\log.txt" 2>&1'))
  assert.ok(!bat.includes('echo bye >> "C:\\work\\log.txt" 2>&1'))
})

test('buildCmdBat: 用户命令原样保留（含空行与 for/if 块行）', () => {
  const job = {
    meta: {
      workdir: 'C:\\work',
      command: 'for /L %%i in (1,1,3) do (\n  echo step %%i\n)\necho done',
    },
  }
  assert.equal(buildCmdBat(job), 'for /L %%i in (1,1,3) do (\r\n  echo step %%i\r\n)\r\necho done\r\n')
  // 空行保留，不出现逐行重定向破坏块结构。
  const job2 = { meta: { workdir: 'C:\\work', command: 'echo a\n\necho b' } }
  assert.equal(buildCmdBat(job2), 'echo a\r\n\r\necho b\r\n')
})

test('buildBat: cmdPath 显式指定时优先使用；exitcode 写入顺序符合 cmd 陷阱（`> file echo` 在日志 marker 之后，自删最后）', () => {
  const job = {
    meta: {
      workdir: 'C:\\work', command: 'exit 3', jsonPath: 'C:\\work\\job.json',
      cmdPath: 'C:\\work\\my-cmd.bat',
      logPath: 'C:\\work\\log.txt', exitcodePath: 'C:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  const bat = buildBat(job)
  assert.ok(bat.includes('call "C:\\work\\my-cmd.bat" >> "C:\\work\\log.txt" 2>&1'))
  const logMarker = bat.indexOf('>> "C:\\work\\log.txt" echo [BGJOB] exit code: %bgrc%')
  const exitWrite = bat.indexOf('> "C:\\work\\exit.txt" echo %bgrc%')
  const selfDelete = bat.indexOf('schtasks /Delete /TN dsh-bgj-x /F >nul 2>&1')
  assert.ok(logMarker >= 0 && exitWrite >= 0 && selfDelete >= 0)
  assert.ok(exitWrite > logMarker, 'exitcode 写入应在日志 marker 之后')
  assert.ok(selfDelete > exitWrite, '自删任务应在写 exitcode 之后')
})

test('buildPwshRunner: run.ps1 用 & job.ps1 *> 重定向；exitcode 顺序与自删同 buildBat（无 cmd 语法）', () => {
  const job = {
    meta: {
      workdir: 'C:\\work', jsonPath: 'C:\\work\\job.json',
      scriptPath: 'C:\\work\\job.ps1',
      logPath: 'C:\\work\\log.txt', exitcodePath: 'C:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  const ps1 = buildPwshRunner(job)
  assert.ok(ps1.startsWith('# bgjobs pwsh runner'))
  assert.ok(!ps1.includes('@echo off'), '不应再有 cmd bat 语法')
  assert.ok(ps1.includes("Set-Location -LiteralPath 'C:\\work'"))
  assert.ok(ps1.includes("& 'C:\\work\\job.ps1' *> $logPath"), '应以 & 调用 job.ps1 并 *> 重定向全部流')
  assert.ok(ps1.includes("$logPath = 'C:\\work\\log.txt'"))
  const logMarker = ps1.indexOf("[System.IO.File]::AppendAllText($logPath, '[BGJOB] exit code: ' + $code + [Environment]::NewLine, $utf8)")
  const exitWrite = ps1.indexOf("[System.IO.File]::WriteAllText('C:\\work\\exit.txt', [string]$code, $utf8)")
  const selfDelete = ps1.indexOf("& schtasks /Delete /TN 'dsh-bgj-x' /F *> $null")
  assert.ok(logMarker >= 0 && exitWrite >= 0 && selfDelete >= 0)
  assert.ok(exitWrite > logMarker, 'exitcode 写入应在日志 marker 之后')
  assert.ok(selfDelete > exitWrite, '自删任务应在写 exitcode 之后')
  assert.ok(ps1.includes("try {") && ps1.includes('} catch {'), 'try/catch 兜底保证 exitcode 必写')
  assert.ok(ps1.includes('0xFF -and $logBytes[1] -eq 0xFE'), '5.1 UTF-16LE 日志转 UTF-8 兜底')
})

test('buildPwshRunner: scriptPath 缺省时由 jsonPath 推导 job.ps1', () => {
  const job = {
    meta: {
      workdir: 'C:\\work', jsonPath: 'C:\\work\\job.json',
      logPath: 'C:\\work\\log.txt', exitcodePath: 'C:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  assert.ok(buildPwshRunner(job).includes("& 'C:\\work\\job.ps1' *> $logPath"))
})

test('buildLaunchVbs: 纯 ASCII 模板，FSO 自推导目录启动同目录 run.bat（SW_HIDE=0，等待）', () => {
  const vbs = buildLaunchVbs()
  assert.match(vbs, /^[\x00-\x7F]*\r\n$/, 'launch.vbs 应为纯 ASCII')
  assert.ok(vbs.includes('CreateObject("Scripting.FileSystemObject")'))
  assert.ok(vbs.includes('GetParentFolderName(WScript.ScriptFullName)'))
  assert.ok(vbs.includes('sh.Run """" & dir & "\\run.bat""", 0, True'), '应以 SW_HIDE(0) 隐藏启动并等待(True)')
  assert.ok(!vbs.includes('powershell'), 'bat 引擎启动器不得依赖 PowerShell')
})

test('buildPs1: 编码 preamble + 用户命令原样保留（含空行）', () => {
  const job = { meta: { workdir: 'C:\\work', command: 'Write-Output "中文"\n\n1..3 | ForEach-Object { "step $_" }' } }
  const ps1 = buildPs1(job)
  assert.ok(ps1.startsWith('# bgjobs: 强制 UTF-8 输出'))
  assert.ok(ps1.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  assert.ok(ps1.includes('$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  // 命令原样（CRLF 归一，含空行）
  assert.ok(ps1.includes('Write-Output "中文"\r\n\r\n1..3 | ForEach-Object { "step $_" }\r\n'))
})

// ── 工具注册契约 ──

test('apply: 注册四个工具，output 结构合法', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  assert.equal(tools.length, 4)
  for (const tool of tools) {
    assert.ok(tool.output, `${tool.name} 必须声明 output`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.deepEqual(tools.map((t) => t.name).sort(), ['bgjob_status', 'bgjob_submit', 'bgjob_submit_pwsh', 'bgjob_wait'])
  dispose()
})

test('apply: presentCall 返回 generic 卡片', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  assert.deepEqual(submit.presentCall({ name: 'sim' }), {
    card: 'generic', title: '提交后台任务', kind: 'execute', rawInput: 'sim',
  })
  dispose()
})

test('guidance: buildBgjobsGuidance 提及四个工具与关键注意事项', () => {
  const text = buildBgjobsGuidance()
  assert.ok(text.includes('bgjob_submit'))
  assert.ok(text.includes('bgjob_submit_pwsh'))
  assert.ok(text.includes('bgjob_status'))
  assert.ok(text.includes('bgjob_wait'))
  assert.ok(text.includes('bat 语法'))
  assert.ok(text.includes('PowerShell'))
  assert.ok(text.includes('workdir'))
  assert.ok(text.includes('Toast'))
})

test('guidance: apply 注册 tool:bgjobs system prompt section', () => {
  const { ctx, sections } = makeCtx()
  const dispose = apply(ctx)
  const sec = sections.find((s) => s.name === 'tool:bgjobs')
  assert.ok(sec, 'apply 应注册 tool:bgjobs section')
  assert.equal(sec.order, 150)
  assert.ok(sec.text.includes('bgjob_submit'))
  assert.ok(sec.text.includes('bgjob_submit_pwsh'))
  dispose()
})

// ── 提交路径 ──

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
async function runningPlugin(workdir, exec) {
  const { ctx, tools, intervals, services, injectCallbacks } = makeCtx({
    services: { workspaceRegistry: { list: () => [] } },
  })
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  const res = await submit.execute({ name: 't', command: 'echo x', workdir }, exec)
  const tick = intervals.find((i) => i.ms === 1000).fn
  return { ctx, dispose, res, tick, services, tools, injectCallbacks }
}

test('tick: 日志增量读 + exitcode 未出现时保持 running', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { dispose, res, tick, ctx, injectCallbacks } = await runningPlugin(workdir)
  try {
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'hello\nworld\n', 'utf8')
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    const req = { url: '/bgjobs/state' }
    let body = ''
    const httpRes = { writeHead: () => {}, end: (b) => { body = b } }
    await getJobs().handler(req, httpRes)
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].status, 'running')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('tick: exitcode 出现 → done、落盘、兜底删除任务计划；tail 含最后写入的行', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, dispose, res, tick, injectCallbacks } = await runningPlugin(workdir)
  try {
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'final-line\n', 'utf8')
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    await tick()
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done')
    assert.equal(meta.exitCode, 0)
    assert.ok(calls.some((argv) => argv.includes('/Delete')), 'done 后应 fire-and-forget /Delete')
    // 完成检测（含 checkCompletion 内的补读）后，tail 应包含日志最后写入的行。
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].status, 'done')
    assert.ok(jobs[0].tail.includes('final-line'), '完成时 tail 应包含日志最后一行')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('完成迁移：不再注入会话消息（v0.1.8 起改 UI toast，host 侧不调 agents）', async () => {
  const calls = []
  let agentsCalled = 0
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const exec = { agent: { session: { id: 'sess-1' } } }
  const { ctx, dispose, res, tick, services } = await runningPlugin(workdir, exec)
  try {
    services.set('agents', {
      get: () => { agentsCalled++ ; return { session: { id: 'sess-1' }, followup: () => { agentsCalled++ } } },
    })
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '3', 'utf8')
    await tick()
    assert.equal(agentsCalled, 0, 'host 侧完成迁移不应调 agents（通知改由 client 轮询弹 toast）')
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done', '完成迁移仍正常落盘 job.json')
    assert.equal(meta.exitCode, 3)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('完成迁移：无 agents 服务时静默不抛错', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, dispose, res, tick, services } = await runningPlugin(workdir) // exec 缺省 → 无 session
  try {
    // 不设置 agents 服务：host 侧完全不触碰，完成迁移不受影响。
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    await assert.doesNotReject(tick())
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 恢复 ──

test('recover: 重挂 running 任务并在 exitcode 出现后迁移 done', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const jobsRoot = workdir + '\\.dsh\\bgjobs'
  await fsp.mkdir(path.join(jobsRoot, 'bg-running'), { recursive: true })
  await fsp.writeFile(path.join(jobsRoot, 'bg-running', 'job.json'), JSON.stringify({
    id: 'bg-running', name: 'r', workdir, jobDir: jobsRoot + '\\bg-running',
    logPath: jobsRoot + '\\bg-running\\stdout.log',
    exitcodePath: jobsRoot + '\\bg-running\\exitcode.txt',
    jsonPath: jobsRoot + '\\bg-running\\job.json',
    taskName: 'dsh-bgj-r', command: 'echo r', status: 'running', createdAt: Date.now(),
  }), 'utf8')
  // 模拟 DSH 离线期间任务已结束：exitcode 在首次 tick 前就绪。
  await fsp.writeFile(path.join(jobsRoot, 'bg-running', 'exitcode.txt'), '7', 'utf8')
  const { ctx, intervals } = makeCtx({
    services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
  })
  const dispose = apply(ctx)
  try {
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const meta = JSON.parse(await fsp.readFile(path.join(jobsRoot, 'bg-running', 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done')
    assert.equal(meta.exitCode, 7)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('recover: workspaceRegistry 未就绪时 tick 不抛错（持续重试）', async () => {
  const workdir = await makeWorkdir()
  const { ctx, intervals } = makeCtx({ services: {} }) // 无 workspaceRegistry
  const dispose = apply(ctx)
  try {
    const tick = intervals.find((i) => i.ms === 1000).fn
    await assert.doesNotReject(tick())
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('recover: 任务 workdir 不在当前工作区也能恢复（中央索引）', async () => {
  const home = await makeDshHome()
  try {
    const workdirA = await makeWorkdir() // 任务所在工作区
    const workdirB = await makeWorkdir() // 当前会话工作区（不含任务）
    const jobId = 'bg-cross-ws'
    const jobDir = workdirA + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'cross', workdir: workdirA, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-cross',
      command: 'echo x', status: 'running', createdAt: Date.now(),
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir: workdirA, name: 'cross', createdAt: Date.now() }] }, home)
    // 当前会话的工作区是 workdirB，与任务 workdir 不同——只能经中央索引恢复。
    const { ctx, intervals, injectCallbacks } = makeCtx({
      services: { workspaceRegistry: { list: () => [{ path: workdirB }] } },
    })
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1, '跨工作区任务应经中央索引恢复')
    assert.equal(jobs[0].id, jobId)
    assert.equal(jobs[0].status, 'running')
    dispose()
    await fsp.rm(workdirA, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(workdirB, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('recover: 无 workspaceRegistry 时按中央索引恢复成功', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-no-ws'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'nows', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-nows',
      command: 'echo x', status: 'done', exitCode: 0, finishedAt: Date.now(), createdAt: Date.now(),
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'nows', createdAt: Date.now() }] }, home)
    const { ctx, intervals, injectCallbacks } = makeCtx({ services: {} }) // 无 workspaceRegistry
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await assert.doesNotReject(tick())
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1, '无 workspaceRegistry 也应从索引恢复')
    assert.equal(jobs[0].id, jobId)
    assert.equal(jobs[0].status, 'done')
    assert.equal(jobs[0].exitCode, 0)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('recover: 索引缺失时工作区扫描兜底', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-scan-fallback'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'scan', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-scan',
      command: 'echo x', status: 'running', createdAt: Date.now(),
    }), 'utf8')
    // 不写中央索引：仅靠工作区扫描兜底。
    const { ctx, intervals, injectCallbacks } = makeCtx({
      services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
    })
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1, '索引缺失时应由工作区扫描兜底')
    assert.equal(jobs[0].id, jobId)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 保留策略：已完成任务不按时间剪枝（面板与索引保留，直到手动删除/一键清理）──

test('保留: 已完成任务不被时间剪枝（近期与超过24h都保留）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const jobsRoot = workdir + '\\.dsh\\bgjobs'
  const now = Date.now()
  const writeJob = async (id, status, finishedAt) => {
    await fsp.mkdir(path.join(jobsRoot, id), { recursive: true })
    await fsp.writeFile(path.join(jobsRoot, id, 'job.json'), JSON.stringify({
      id, name: id, workdir, jobDir: jobsRoot + '\\' + id,
      logPath: jobsRoot + '\\' + id + '\\stdout.log',
      exitcodePath: jobsRoot + '\\' + id + '\\exitcode.txt',
      jsonPath: jobsRoot + '\\' + id + '\\job.json',
      taskName: 'dsh-bgj-' + id, command: 'echo x', status,
      exitCode: status === 'done' ? 0 : undefined,
      finishedAt, createdAt: finishedAt - 1000,
    }), 'utf8')
  }
  await writeJob('bg-fresh', 'done', now - 60 * 60 * 1000) // 1h 前
  await writeJob('bg-old', 'done', now - 25 * 60 * 60 * 1000) // 25h 前
  const { ctx, intervals, injectCallbacks } = makeCtx({
    services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
  })
  const dispose = apply(ctx)
  try {
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 2, '已完成任务应一直保留（不按时间剪枝）')
    assert.ok(jobs.some((j) => j.id === 'bg-fresh') && jobs.some((j) => j.id === 'bg-old'), '近期与超期 done 均保留')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('state 视图含 finishedAt：面板可据此区分"超 24h 清理"范围', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({
    services: { workspaceRegistry: { list: () => [] } },
  })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1)
    const done = jobs[0]
    assert.equal(done.status, 'done')
    assert.equal(typeof done.finishedAt, 'number', 'done 任务视图应携带 finishedAt（时间戳）')
    assert.ok(done.finishedAt <= Date.now())
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── webServer 路由 ──

test('webServer: /bgjobs/state 返回 jobs 列表，其他路径 404', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({
    services: { workspaceRegistry: { list: () => [] } },
  })
  const dispose = apply(ctx)
  try {
    const getJobs = attachWebServer(ctx, injectCallbacks)
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    let body = ''
    let status = 0
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: (code) => { status = code }, end: (b) => { body = b } })
    assert.equal(status, 200)
    const parsed = JSON.parse(body)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.jobs.length, 1)
    assert.equal(parsed.jobs[0].id, res.jobId)
    // 其他路径 404
    let status404 = 0
    await getJobs().handler({ url: '/other' }, { writeHead: (code) => { status404 = code }, end: () => {} })
    assert.equal(status404, 404)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('webServer: /bgjobs/delete 删除单个任务（目录+任务计划+索引）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const { ctx, tools, intervals, injectCallbacks } = makeCtx({
      services: { workspaceRegistry: { list: () => [] } },
    })
    const dispose = apply(ctx)
    const getJobs = attachWebServer(ctx, injectCallbacks)
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    await waitFor(async () => (await readBgjobsIndex(home)).jobs.length === 1)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const call = (url) => new Promise((resolve) => {
      let body = ''
      getJobs().handler({ url }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
    })
    const r = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(r.ok, true)
    assert.equal(r.removed, res.jobId)
    // 目录删除
    assert.ok(!(await fsp.stat(jobDir).catch(() => null)), 'job 目录应被删除')
    // running 任务：/End + /Delete 都调过
    assert.ok(calls.some((argv) => argv.includes('/End')))
    assert.ok(calls.some((argv) => argv.includes('/Delete')))
    // 索引移除（fire-and-forget，等待）
    await waitFor(async () => (await readBgjobsIndex(home)).jobs.length === 0)
    // 再次删除 → not found
    const again = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(again.ok, false)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('webServer: /bgjobs/cleanup 一键清理 done 任务（含异常退出），保留 running', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const { ctx, tools, intervals, injectCallbacks } = makeCtx({
      services: { workspaceRegistry: { list: () => [] } },
    })
    const dispose = apply(ctx)
    const getJobs = attachWebServer(ctx, injectCallbacks)
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    // 提交 3 个任务
    const a = await submit.execute({ name: 'a', command: 'echo a', workdir }, { agent: undefined })
    const b = await submit.execute({ name: 'b', command: 'echo b', workdir }, { agent: undefined })
    const c = await submit.execute({ name: 'c', command: 'echo c', workdir }, { agent: undefined })
    const tick = intervals.find((i) => i.ms === 1000).fn
    // a,b 完成（a 正常、b 异常）；c 保持 running
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + a.jobId + '\\exitcode.txt', '0', 'utf8')
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + b.jobId + '\\exitcode.txt', '5', 'utf8')
    await tick()
    const call = (url) => new Promise((resolve) => {
      let body = ''
      getJobs().handler({ url }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
    })
    const r = await call('/bgjobs/cleanup')
    assert.equal(r.ok, true)
    assert.deepEqual(r.removed.sort(), [a.jobId, b.jobId].sort())
    // c 仍在
    const state = await call('/bgjobs/state')
    assert.equal(state.jobs.length, 1)
    assert.equal(state.jobs[0].id, c.jobId)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

/** 等待条件成立（轮询，最多 ~500ms），用于 fire-and-forget 的索引写入。 */
async function waitFor(cond, ms = 500) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail('waitFor timed out')
}

// ── 中央索引 ──

test('索引: resolveBgjobsHome 优先 DSH_HOME，缺省 ~/.dsh', async () => {
  const home = await makeDshHome()
  try {
    assert.equal(resolveBgjobsHome(), path.resolve(home))
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('索引: read/write/update 基本读写', async () => {
  const home = await makeDshHome()
  try {
    assert.deepEqual(await readBgjobsIndex(home), { version: 1, updatedAt: 0, jobs: [] })
    await updateBgjobsIndex((jobs) => jobs.push({ id: 'bg-1', jobDir: 'C:\\d' }), home)
    const idx = await readBgjobsIndex(home)
    assert.equal(idx.jobs.length, 1)
    assert.equal(idx.jobs[0].id, 'bg-1')
    await updateBgjobsIndex((jobs) => jobs.push({ id: 'bg-2', jobDir: 'C:\\e' }), home)
    assert.equal((await readBgjobsIndex(home)).jobs.length, 2)
    // upsert 语义：同 id 覆盖而非重复
    await updateBgjobsIndex((jobs) => {
      const at = jobs.findIndex((j) => j.id === 'bg-1')
      if (at >= 0) jobs[at] = { ...jobs[at], name: 'renamed' }
      else jobs.push({ id: 'bg-1', name: 'renamed' })
    }, home)
    const after = await readBgjobsIndex(home)
    assert.equal(after.jobs.filter((j) => j.id === 'bg-1').length, 1)
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('索引: 损坏文件读为空且不抛错', async () => {
  const home = await makeDshHome()
  try {
    const p = bgjobsIndexPath(home)
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, 'not-json{{{', 'utf8')
    const idx = await readBgjobsIndex(home)
    assert.deepEqual(idx, { version: 1, updatedAt: 0, jobs: [] })
    // 非预期结构（jobs 不是数组）同样容错
    await fsp.writeFile(p, JSON.stringify({ jobs: 'oops' }), 'utf8')
    assert.deepEqual(await readBgjobsIndex(home), { version: 1, updatedAt: 0, jobs: [] })
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('索引: rebuildBgjobsIndex 扫描工作区重建', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobsRoot = workdir + '\\.dsh\\bgjobs'
    await fsp.mkdir(path.join(jobsRoot, 'bg-a'), { recursive: true })
    await fsp.writeFile(path.join(jobsRoot, 'bg-a', 'job.json'), JSON.stringify({
      id: 'bg-a', name: 'a', workdir, jobDir: jobsRoot + '\\bg-a',
      logPath: jobsRoot + '\\bg-a\\stdout.log',
      exitcodePath: jobsRoot + '\\bg-a\\exitcode.txt',
      jsonPath: jobsRoot + '\\bg-a\\job.json',
      taskName: 'dsh-bgj-a', command: 'echo a', status: 'running', createdAt: 1000,
    }), 'utf8')
    await fsp.mkdir(path.join(jobsRoot, 'bg-b'), { recursive: true })
    await fsp.writeFile(path.join(jobsRoot, 'bg-b', 'job.json'), JSON.stringify({
      id: 'bg-b', name: 'b', workdir, jobDir: jobsRoot + '\\bg-b',
      logPath: jobsRoot + '\\bg-b\\stdout.log',
      exitcodePath: jobsRoot + '\\bg-b\\exitcode.txt',
      jsonPath: jobsRoot + '\\bg-b\\job.json',
      taskName: 'dsh-bgj-b', command: 'echo b', status: 'running', createdAt: 2000,
    }), 'utf8')
    // 非任务目录：无 job.json，应跳过
    await fsp.mkdir(path.join(jobsRoot, 'not-a-job'), { recursive: true })
    const idx = await rebuildBgjobsIndex([workdir], home)
    assert.equal(idx.jobs.length, 2)
    assert.equal(idx.jobs[0].id, 'bg-a')
    assert.equal(idx.jobs[0].jobDir, jobsRoot + '\\bg-a')
    // 落盘可读
    const fromDisk = await readBgjobsIndex(home)
    assert.equal(fromDisk.jobs.length, 2)
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('索引: submitJob 成功写入索引；完成不删条目', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const { ctx, tools, intervals, services } = makeCtx({
      services: { workspaceRegistry: { list: () => [] } },
    })
    const dispose = apply(ctx)
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    // 提交后索引含该 job（fire-and-forget，等待落盘）
    await waitFor(async () => (await readBgjobsIndex(home)).jobs.length === 1)
    const idx = await readBgjobsIndex(home)
    assert.equal(idx.jobs.length, 1)
    assert.equal(idx.jobs[0].id, res.jobId)
    assert.equal(idx.jobs[0].workdir, workdir)
    // 任务完成后索引条目仍在（地图不删，状态实时读 job.json）
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const after = await readBgjobsIndex(home)
    assert.equal(after.jobs.length, 1, '完成不删索引条目')
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('索引: recover 兼收近期与超期任务（不按时间剪枝）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobsRoot = workdir + '\\.dsh\\bgjobs'
    const writeJob = async (id, status, finishedAt) => {
      await fsp.mkdir(path.join(jobsRoot, id), { recursive: true })
      await fsp.writeFile(path.join(jobsRoot, id, 'job.json'), JSON.stringify({
        id, name: id, workdir, jobDir: jobsRoot + '\\' + id,
        logPath: jobsRoot + '\\' + id + '\\stdout.log',
        exitcodePath: jobsRoot + '\\' + id + '\\exitcode.txt',
        jsonPath: jobsRoot + '\\' + id + '\\job.json',
        taskName: 'dsh-bgj-' + id, command: 'echo x', status,
        exitCode: status === 'done' ? 0 : undefined,
        finishedAt, createdAt: finishedAt - 1000,
      }), 'utf8')
    }
    const now = Date.now()
    await writeJob('bg-fresh', 'done', now - 60 * 60 * 1000) // 1h 前：保留 + 入索引
    await writeJob('bg-old', 'done', now - 25 * 60 * 60 * 1000) // 25h 前：同样保留 + 入索引
    const { ctx, intervals } = makeCtx({
      services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
    })
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick() // recover 挂接；所有任务是磁盘目录都入索引
    await waitFor(async () => (await readBgjobsIndex(home)).jobs.length === 2)
    const idx = await readBgjobsIndex(home)
    assert.equal(idx.jobs.length, 2, '近期与超期任务均入索引（不按时间剪枝）')
    assert.ok(idx.jobs.some((j) => j.id === 'bg-fresh') && idx.jobs.some((j) => j.id === 'bg-old'))
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── bgjob_status 磁盘回退（会话重启后旧 id 不再被追踪的假象修复）──

test('bgjob_status: 内存注册表命中走内存路径（回归）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const status = tools.find((t) => t.name === 'bgjob_status')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const st = await status.execute({ jobId: res.jobId })
    assert.equal(st.error, undefined)
    assert.equal(st.id, res.jobId)
    assert.equal(st.status, 'running')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_status: 磁盘回退（索引）—— 重启后旧 running 任务返回 running 而非 not found', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-old-running'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    const meta = {
      id: jobId, name: 'old-r', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-old-r',
      command: 'ping -n 9 127.0.0.1', status: 'running', createdAt: Date.now(),
    }
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(meta), 'utf8')
    await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'line1\nline2\n', 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'old-r', createdAt: meta.createdAt }] }, home)
    // 不提供 workspaceRegistry：只能走中央索引定位。
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.error, undefined)
    assert.equal(st.id, jobId)
    assert.equal(st.name, 'old-r')
    assert.equal(st.status, 'running')
    assert.equal(st.exitCode, null)
    assert.equal(st.logPath, meta.logPath)
    assert.ok(st.tail.includes('line2'))
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_status: 磁盘回退 —— DSH 离线期间任务结束（exitcode.txt）→ done + 退出码', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-old-done'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    const meta = {
      id: jobId, name: 'old-d', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-old-d',
      command: 'exit 3', status: 'running', createdAt: Date.now(),
    }
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(meta), 'utf8')
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '3', 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'old-d', createdAt: meta.createdAt }] }, home)
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.status, 'done')
    assert.equal(st.exitCode, 3)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_status: 磁盘回退 —— job.json 已落盘 done 终态直接返回', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-final'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'f', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-f',
      command: 'echo done', status: 'done', exitCode: 0, finishedAt: Date.now(), createdAt: Date.now(),
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'f', createdAt: Date.now() }] }, home)
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.status, 'done')
    assert.equal(st.exitCode, 0)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_status: 磁盘回退 —— 索引缺失时按工作区扫描定位', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-scan'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 's', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-s',
      command: 'echo s', status: 'running', createdAt: Date.now(),
    }), 'utf8')
    // 不写中央索引；只提供 workspaceRegistry 兜底扫描。
    const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [{ path: workdir }] } } })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.error, undefined)
    assert.equal(st.status, 'running')
    assert.equal(st.name, 's')
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_status: 磁盘回退只读，不触发任何 schtasks（不终止任务）', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-nokill'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'k', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-k',
      command: 'ping -n 9 127.0.0.1', status: 'running', createdAt: Date.now(),
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'k', createdAt: Date.now() }] }, home)
    const calls = []
    setSchtasksRunner(makeFakeRunner(calls))
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.status, 'running', 'running 任务被如实返回，不受查询影响')
    assert.deepEqual(calls, [], '状态查询不得调用 schtasks（/End//Delete 等终止逻辑）')
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_status: 磁盘回退 —— 未知 id 仍返回 job not found', async () => {
  const home = await makeDshHome()
  try {
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId: 'bg-nonexistent' })
    assert.ok(st.error && st.error.includes('not found'))
    dispose()
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 沙箱联动（v0.1.29）──

/** 写 full access 开关（false 时受限会话宽请求须审批 / 无服务须拒绝）。 */
async function setFullAccessEnabled(enabled) {
  await fsp.mkdir(path.join(process.env.DSH_HOME, 'bgjobs'), { recursive: true })
  await fsp.writeFile(
    path.join(process.env.DSH_HOME, 'bgjobs', 'fullaccess.json'),
    JSON.stringify({ enabled }), 'utf8',
  )
}

/** pwsh 引擎可用的 mock 集合：shell + runner 可换，restricted session 策略 + approval。 */
function restrictedPolicy(workdir) {
  return { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workdir }) } }
}
function fullPolicy(workdir) {
  return { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workdir }) } }
}

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
function agentHandle(sid, status) {
  const calls = { followup: [], inject: [] }
  return {
    id: sid,
    status,
    followup: (m) => { calls.followup.push(m) },
    inject: (m) => { calls.inject.push(m) },
    calls,
  }
}

/** 提交并让任务完成：写 exitcode 后跑一次 tick，返回 job 目录。 */
async function submitAndFinish(tool, args, exec, workdir, exitCode, tick) {
  const res = await tool.execute(args, exec)
  assert.equal(res.ok, true)
  const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
  await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), String(exitCode), 'utf8')
  await tick()
  return jobDir
}

test('shouldNotifyForExit: off/on-completion/on-fail/on-exit 矩阵', () => {
  assert.equal(shouldNotifyForExit(undefined, 0), false)
  assert.equal(shouldNotifyForExit('off', 0), false)
  assert.equal(shouldNotifyForExit('off', 5), false)
  assert.equal(shouldNotifyForExit('on-completion', 0), true)
  assert.equal(shouldNotifyForExit('on-completion', 5), false)
  assert.equal(shouldNotifyForExit('on-completion', null), false)
  assert.equal(shouldNotifyForExit('on-fail', 0), false)
  assert.equal(shouldNotifyForExit('on-fail', 5), true)
  assert.equal(shouldNotifyForExit('on-exit', 0), true)
  assert.equal(shouldNotifyForExit('on-exit', 5), true)
  assert.equal(shouldNotifyForExit('on-exit', null), false)
})

test('tools schema: bgjob_submit/bgjob_submit_pwsh 含 notify/notify_mode 枚举，缺省 off/wakeup', () => {
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  for (const name of ['bgjob_submit', 'bgjob_submit_pwsh']) {
    const tool = tools.find((t) => t.name === name)
    const props = tool.parameters.properties
    assert.deepEqual(props.notify.enum, ['off', 'on-completion', 'on-fail', 'on-exit'])
    assert.equal(props.notify.default, 'off')
    assert.deepEqual(props.notify_mode.enum, ['wakeup', 'quiet', 'always'])
    assert.equal(props.notify_mode.default, 'wakeup')
    assert.deepEqual(tool.parameters.required, ['name', 'command', 'workdir'])
  }
  dispose()
})

test('notify 缺省 off：任务完成不注入会话、job.json 无 notify/notifiedAt', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    const jobDir = await submitAndFinish(submit, { name: 't', command: 'echo x', workdir }, exec, workdir, 0, tick)
    assert.equal(handle.calls.followup.length, 0)
    assert.equal(handle.calls.inject.length, 0)
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.notify, undefined)
    assert.equal(meta.notifiedAt, undefined)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('notify=on-exit + wakeup + 空闲 → followup 唤醒，消息含任务名与退出码，notifiedAt 落盘', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    const jobDir = await submitAndFinish(submit, { name: 't', command: 'echo x', workdir, notify: 'on-exit' }, exec, workdir, 3, tick)
    assert.equal(handle.calls.followup.length, 1)
    assert.equal(handle.calls.inject.length, 0)
    const msg = handle.calls.followup[0]
    assert.equal(msg.role, 'user')
    assert.equal(msg.source.kind, 'plugin')
    assert.equal(msg.source.plugin, 'bgjobs')
    assert.ok(msg.content[0].text.includes('后台任务「t」已结束（exit code 3）'))
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.notify, 'on-exit')
    assert.equal(meta.notifiedAt !== undefined, true, '通知后应落盘 notifiedAt')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('notify=on-exit + wakeup + 忙碌 → inject 排入收件箱（不唤醒）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'running')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    await submitAndFinish(submit, { name: 't', command: 'Write-Output ok', workdir, notify: 'on-exit' }, exec, workdir, 0, tick)
    assert.equal(handle.calls.followup.length, 0, '忙碌会话不得唤醒')
    assert.equal(handle.calls.inject.length, 1)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('notify_mode=quiet + 空闲 → 仅 inject，不唤醒', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    await submitAndFinish(submit, { name: 't', command: 'echo x', workdir, notify: 'on-exit', notify_mode: 'quiet' }, exec, workdir, 0, tick)
    assert.equal(handle.calls.followup.length, 0)
    assert.equal(handle.calls.inject.length, 1)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('notify_mode=always + 空闲 → 无视预算恒 followup', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    for (let i = 0; i < 4; i++) {
      await submitAndFinish(submit, { name: 'n' + i, command: 'echo x', workdir, notify: 'on-exit', notify_mode: 'always' }, exec, workdir, 0, tick)
    }
    assert.equal(handle.calls.followup.length, 4)
    assert.equal(handle.calls.inject.length, 0)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('wakeup 预算：连续 2 次唤醒后降级 inject；用户领走消息后重置', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, onCallbacks } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    const finish = (name) => submitAndFinish(submit, { name, command: 'echo x', workdir, notify: 'on-exit' }, exec, workdir, 0, tick)
    await finish('a')
    await finish('b')
    assert.equal(handle.calls.followup.length, 2, '预算内应唤醒')
    assert.equal(handle.calls.inject.length, 0)
    await finish('c')
    assert.equal(handle.calls.followup.length, 2, '超预算应停止唤醒')
    assert.equal(handle.calls.inject.length, 1)
    // 用户领走收件箱消息 → 重置预算
    const claimed = onCallbacks.find((c) => c.event === 'agent/inbox/claimed')
    assert.ok(claimed, 'apply 应注册 agent/inbox/claimed 监听')
    claimed.fn({ agent: { id: 's1' }, message: { source: { kind: 'user' } } })
    await finish('d')
    assert.equal(handle.calls.followup.length, 3, '用户消息后应恢复唤醒')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('notify=on-completion + 非零退出 → 不通知；on-fail + 非零 → 通知', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    await submitAndFinish(submit, { name: 'ok', command: 'echo x', workdir, notify: 'on-completion' }, exec, workdir, 5, tick)
    assert.equal(handle.calls.followup.length, 0, 'on-completion + exit≠0 不通知')
    await submitAndFinish(submit, { name: 'fail', command: 'echo x', workdir, notify: 'on-fail' }, exec, workdir, 5, tick)
    assert.equal(handle.calls.followup.length, 1, 'on-fail + exit≠0 通知')
    assert.ok(handle.calls.followup[0].content[0].text.includes('已结束（exit code 5）'))
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('notify: 无 agents 服务 → 静默不抛错（toast 兜底）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: {} }) // 无 agents
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    const jobDir = await submitAndFinish(submit, { name: 't', command: 'echo x', workdir, notify: 'on-exit' }, exec, workdir, 0, tick)
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done', '通知尽力而为，不得破坏完成迁移')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('notify: 重启恢复已通知（notifiedAt）的 done 任务 → 不重复通知', async () => {
  const home = await makeDshHome()
  try {
    setSchtasksRunner(makeFakeRunner([]))
    const handle = agentHandle('s1', 'idle')
    const workdir = await makeWorkdir()
    const jobId = 'bg-notified'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    const notifiedAt = Date.now()
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'n', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-n', command: 'echo x',
      status: 'done', exitCode: 0, finishedAt: notifiedAt, notifiedAt, createdAt: notifiedAt - 1000,
      notify: 'on-exit', createdBySession: 's1',
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'n', createdAt: notifiedAt - 1000 }] }, home)
    const { ctx, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    assert.equal(handle.calls.followup.length, 0, '已通知任务重启后不得重复通知')
    assert.equal(handle.calls.inject.length, 0)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── bgjob_wait（v0.1.51）：等任务结束立即返回 ──

test('bgjob_wait: 已 done 的任务立即返回（waitedMs 0，不再轮询）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    const w = await wait.execute({ jobId: res.jobId })
    assert.equal(w.ok, true)
    assert.equal(w.timedOut, false)
    assert.equal(w.waitedMs, 0)
    assert.equal(w.status, 'done')
    assert.equal(w.exitCode, 0)
    assert.equal(w.error, undefined)
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done', 'wait 首查应顺带完成幂等收尾（job.json 落盘 done）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_wait: 未知 id 立即报 not found（不空等）', async () => {
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  const wait = tools.find((t) => t.name === 'bgjob_wait')
  const started = Date.now()
  const w = await wait.execute({ jobId: 'bg-nonexistent' })
  assert.equal(w.ok, false)
  assert.ok(w.error && w.error.includes('not found'))
  assert.ok(Date.now() - started < 1000, '未知 id 应立即返回，不进入轮询')
  dispose()
})

test('bgjob_wait: 超时返回 timedOut 快照（任务仍在 running）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const w = await wait.execute({ jobId: res.jobId, timeoutSeconds: 1 })
    assert.equal(w.ok, true)
    assert.equal(w.timedOut, true)
    assert.equal(w.status, 'running')
    assert.ok(w.waitedMs >= 950, '应等待约 timeoutSeconds')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_wait: 等待期间任务完成 → 立即返回 done + 退出码（无需 sleep 轮询）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    setTimeout(() => {
      fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '7', 'utf8').catch(() => {})
    }, 150)
    const w = await wait.execute({ jobId: res.jobId, timeoutSeconds: 5 })
    assert.equal(w.ok, true)
    assert.equal(w.timedOut, false)
    assert.equal(w.status, 'done')
    assert.equal(w.exitCode, 7)
    assert.ok(w.waitedMs >= 100 && w.waitedMs < 5000, '完成后应尽快返回（waitedMs=' + w.waitedMs + '）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── submit 可选 wait（v0.1.52）：提交成功后自动等待 ──

/** 轮询扫描 jobsRoot：任务目录出现 delayMs 后写 exitcode（模拟真实任务收尾）。返回 stop()，可读是否已写入。 */
function scheduleExitWrite(jobsRoot, code, delayMs) {
  const started = Date.now()
  let wrote = false
  const timer = setInterval(() => {
    fsp.readdir(jobsRoot)
      .then(async (names) => {
        if (wrote) return
        const dir = names.find((n) => n.startsWith('bg-'))
        if (!dir) return
        const ec = path.join(jobsRoot, dir, 'exitcode.txt')
        const exists = await fsp.access(ec).then(() => true).catch(() => false)
        if (!exists && Date.now() - started >= delayMs) {
          wrote = true
          await fsp.writeFile(ec, String(code), 'utf8')
        }
      })
      .catch(() => {})
  }, 20)
  return { stop: () => clearInterval(timer), get wrote() { return wrote } }
}

test('bgjob_submit wait=1：提交后自动等待，任务结束立即返回 done + 退出码', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  const writer = scheduleExitWrite(workdir + '\\.dsh\\bgjobs', 5, 150)
  try {
    const r = await submit.execute({ name: 't', command: 'echo x', workdir, wait: 1 }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.timedOut, false)
    assert.equal(r.status, 'done')
    assert.equal(r.exitCode, 5)
    assert.ok(r.jobId)
    assert.ok(r.waitedMs > 0, '提交+等待应消耗等待时间')
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', r.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done', '等待结束 job.json 已落盘 done')
    assert.equal(writer.wrote, true)
  } finally {
    writer.stop()
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_submit wait 缺省/0：立即返回（不等待、无 timedOut）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const started = Date.now()
    const r = await submit.execute({ name: 't', command: 'echo x', workdir, wait: 0 }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.timedOut, undefined)
    assert.ok(r.jobId)
    assert.ok(Date.now() - started < 3000, 'wait:0 应立即返回不阻塞')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_submit wait=1：任务未结束则超时返回 timedOut 快照', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const r = await submit.execute({ name: 't', command: 'echo x', workdir, wait: 1 }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.timedOut, true)
    assert.equal(r.status, 'running')
    assert.ok(r.waitedMs >= 950, '超时应等待约 wait 秒')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_submit_pwsh wait=1：提交后自动等待 done', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
  const writer = scheduleExitWrite(workdir + '\\.dsh\\bgjobs', 0, 150)
  try {
    const r = await submit.execute({ name: 't', command: 'Write-Output ok', workdir, wait: 1 }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.timedOut, false)
    assert.equal(r.status, 'done')
    assert.equal(r.exitCode, 0)
    assert.ok(r.waitedMs > 0)
    assert.equal(writer.wrote, true)
  } finally {
    writer.stop()
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

