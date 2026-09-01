// bgjobs host 半测试 —— node:test 零依赖，直接 import 源码（ESM）。
// 运行：node --test tests/
// schtasks 通过 setSchtasksRunner 替换为可控 fake；ctx 用轻量 mock。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, strip, buildBat, buildCmdBat, parseExitCode, setSchtasksRunner,
  resolveBgjobsHome, bgjobsIndexPath, readBgjobsIndex, writeBgjobsIndex,
  updateBgjobsIndex, rebuildBgjobsIndex, buildBgjobsGuidance,
} from '../lib/index.js'

// ── 测试工具 ──

/** 建一个临时 DSH home 并设置 DSH_HOME，返回清理函数。 */
async function makeDshHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-home-'))
  process.env.DSH_HOME = dir
  return dir
}

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
  const ctx = {
    get(name) { return services.get(name) },
    interval(fn, ms) {
      const entry = { fn, ms, disposed: false }
      intervals.push(entry)
      return () => { entry.disposed = true }
    },
    inject(names, cb) {
      injectCallbacks.set(names[0], cb)
      return () => {}
    },
    tools: { register(def) { tools.push(def); return () => {} } },
    systemPrompt: { section(def) { sections.push(def); return () => {} } },
  }
  return { ctx, tools, intervals, services, injectCallbacks, sections }
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

// ── 工具注册契约 ──

test('apply: 注册两个工具，output 结构合法', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  assert.equal(tools.length, 2)
  for (const tool of tools) {
    assert.ok(tool.output, `${tool.name} 必须声明 output`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.deepEqual(tools.map((t) => t.name).sort(), ['bgjob_status', 'bgjob_submit'])
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

test('guidance: buildBgjobsGuidance 提及两个工具与关键注意事项', () => {
  const text = buildBgjobsGuidance()
  assert.ok(text.includes('bgjob_submit'))
  assert.ok(text.includes('bgjob_status'))
  assert.ok(text.includes('bat 语法'))
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
  dispose()
})

// ── 提交路径 ──

test('submitJob: 成功路径完整落盘（run.bat+cmd.bat+job.json）+ /Create /Run /Delete 调用', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
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
  assert.ok(calls.some((argv) => argv.includes('/Create')))
  assert.ok(calls.some((argv) => argv.includes('/Run')))
  // /Run 成功后立即 /Delete（防 /ST 整分双跑）
  const runIdx = calls.findIndex((argv) => argv.includes('/Run'))
  const delIdx = calls.findIndex((argv) => argv.includes('/Delete'))
  assert.ok(runIdx >= 0 && delIdx > runIdx, '/Run 成功后应立即 /Delete 任务计划')
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
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
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
  assert.equal(res.ok, false)
  assert.match(res.error, /schtasks create failed/)
  const jobsRoot = workdir + '\\.dsh\\bgjobs'
  const leftovers = await fsp.readdir(jobsRoot).catch(() => [])
  assert.equal(leftovers.length, 0, '失败后 job 目录应被清理')
  assert.ok(!calls.some((argv) => argv.includes('/Run')), '/Create 失败不应 /Run')
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
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
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
  assert.equal(res.ok, false)
  assert.match(res.error, /schtasks run failed/)
  const jobsRoot = workdir + '\\.dsh\\bgjobs'
  const leftovers = await fsp.readdir(jobsRoot).catch(() => [])
  assert.equal(leftovers.length, 0, '失败后 job 目录应被清理')
  assert.ok(calls.some((argv) => argv.includes('/Delete')), '/Run 失败应删除残留任务计划')
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
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
  const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
  await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'hello\nworld\n', 'utf8')
  await tick()
  const getJobs = attachWebServer(ctx, injectCallbacks)
  const req = { url: '/bgjobs/state' }
  let body = ''
  const httpRes = { writeHead: () => {}, end: (b) => { body = b } }
  getJobs().handler(req, httpRes)
  const jobs = JSON.parse(body).jobs
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].status, 'running')
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
})

test('tick: exitcode 出现 → done、落盘、兜底删除任务计划；tail 含最后写入的行', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, dispose, res, tick, injectCallbacks } = await runningPlugin(workdir)
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
  getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
  const jobs = JSON.parse(body).jobs
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].status, 'done')
  assert.ok(jobs[0].tail.includes('final-line'), '完成时 tail 应包含日志最后一行')
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
})

test('完成迁移：不再注入会话消息（v0.1.8 起改 UI toast，host 侧不调 agents）', async () => {
  const calls = []
  let agentsCalled = 0
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const exec = { agent: { session: { id: 'sess-1' } } }
  const { ctx, dispose, res, tick, services } = await runningPlugin(workdir, exec)
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
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
})

test('完成迁移：无 agents 服务时静默不抛错', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, dispose, res, tick, services } = await runningPlugin(workdir) // exec 缺省 → 无 session
  // 不设置 agents 服务：host 侧完全不触碰，完成迁移不受影响。
  const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
  await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
  await assert.doesNotReject(tick())
  const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
  assert.equal(meta.status, 'done')
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
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
  const tick = intervals.find((i) => i.ms === 1000).fn
  await tick()
  const meta = JSON.parse(await fsp.readFile(path.join(jobsRoot, 'bg-running', 'job.json'), 'utf8'))
  assert.equal(meta.status, 'done')
  assert.equal(meta.exitCode, 7)
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
})

test('recover: workspaceRegistry 未就绪时 tick 不抛错（持续重试）', async () => {
  const workdir = await makeWorkdir()
  const { ctx, intervals } = makeCtx({ services: {} }) // 无 workspaceRegistry
  const dispose = apply(ctx)
  const tick = intervals.find((i) => i.ms === 1000).fn
  await assert.doesNotReject(tick())
  dispose()
  await fsp.rm(workdir, { recursive: true, force: true })
})

// ── 剪枝 ──

test('剪枝: 近期 done 保留、超过 24h 的 done 被移除', async () => {
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
  const tick = intervals.find((i) => i.ms === 1000).fn
  await tick()
  const getJobs = attachWebServer(ctx, injectCallbacks)
  let body = ''
  getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
  const jobs = JSON.parse(body).jobs
  assert.equal(jobs.length, 1, '超期 done 应被剪枝，近期 done 保留')
  assert.equal(jobs[0].id, 'bg-fresh')
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
})

// ── webServer 路由 ──

test('webServer: /bgjobs/state 返回 jobs 列表，其他路径 404', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({
    services: { workspaceRegistry: { list: () => [] } },
  })
  const dispose = apply(ctx)
  const getJobs = attachWebServer(ctx, injectCallbacks)
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
  let body = ''
  let status = 0
  getJobs().handler({ url: '/bgjobs/state' }, { writeHead: (code) => { status = code }, end: (b) => { body = b } })
  assert.equal(status, 200)
  const parsed = JSON.parse(body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.jobs.length, 1)
  assert.equal(parsed.jobs[0].id, res.jobId)
  // 其他路径 404
  let status404 = 0
  getJobs().handler({ url: '/other' }, { writeHead: (code) => { status404 = code }, end: () => {} })
  assert.equal(status404, 404)
  await fsp.rm(workdir, { recursive: true, force: true })
  dispose()
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
    await fsp.rm(workdir, { recursive: true, force: true })
    dispose()
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true })
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
    await fsp.rm(workdir, { recursive: true, force: true })
    dispose()
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true })
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
    await fsp.rm(home, { recursive: true, force: true })
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
    await fsp.rm(home, { recursive: true, force: true })
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
    await fsp.rm(home, { recursive: true, force: true })
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
    await fsp.rm(workdir, { recursive: true, force: true })
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true })
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
    await fsp.rm(workdir, { recursive: true, force: true })
    dispose()
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('索引: recover 补入近期任务；剪枝移除超期任务', async () => {
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
    await writeJob('bg-old', 'done', now - 25 * 60 * 60 * 1000) // 25h 前：剪枝 + 移除
    const { ctx, intervals } = makeCtx({
      services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
    })
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick() // recover 挂接；超期任务在同一次 tick 内被剪枝
    await waitFor(async () => (await readBgjobsIndex(home)).jobs.length === 1)
    const idx = await readBgjobsIndex(home)
    assert.equal(idx.jobs.length, 1, '近期任务入索引，超期任务被剪枝移除')
    assert.equal(idx.jobs[0].id, 'bg-fresh')
    await fsp.rm(workdir, { recursive: true, force: true })
    dispose()
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true })
  }
})
