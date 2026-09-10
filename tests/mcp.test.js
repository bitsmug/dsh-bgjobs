// bgjobs tests —— MCP 引擎（开关 / 提交层 / server 登记 / runner 端到端 / 工具列表 / 预热 /
// profile 判定与 DSH 导入）。全部使用仓库自带本地 demo server，不触网、不依赖付费 MCP。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  apply, setSchtasksRunner, setPrewarmFactory, createMcpPrewarm,
  detectActiveProfile, listProfiles, readMcpConfigs, describeDshMcp, extractMcpServers,
} from '../lib/index.js'
import { createStore } from '../lib/core/store.js'
import { createJobs } from '../lib/core/jobs.js'
import {
  makeCtx, makeWorkdir, makeFakeRunner, setFullAccessEnabled, installSuiteHooks,
} from './helpers/common.js'

installSuiteHooks()

const RUNNER = fileURLToPath(new URL('../lib/mcp-runner.mjs', import.meta.url))
const DEMO = fileURLToPath(new URL('./fixtures/demo-mcp-server.mjs', import.meta.url))
const REPO_ROOT = path.dirname(path.dirname(RUNNER))

/** demo server 的内联配置（零依赖、纯 stdio、完全离线）。 */
const demoConfig = () => ({ transport: 'stdio', command: process.execPath, args: [DEMO] })

const bgjobsFile = (name) => path.join(process.env.DSH_HOME, 'bgjobs', name)

const enableMcp = async () => {
  await fsp.mkdir(path.dirname(bgjobsFile('mcp-prefs.json')), { recursive: true })
  await fsp.writeFile(bgjobsFile('mcp-prefs.json'), JSON.stringify({ enabled: true }), 'utf8')
}

const registerServer = async (name, config) => {
  await fsp.mkdir(path.dirname(bgjobsFile('mcp-servers.json')), { recursive: true })
  await fsp.writeFile(bgjobsFile('mcp-servers.json'), JSON.stringify({ servers: { [name]: config } }), 'utf8')
}

const readJson = async (p) => JSON.parse(await fsp.readFile(p, 'utf8'))
const execWithSession = () => ({ agent: { session: { id: 's1' } }, callId: 'call-1' })
const jobsRootOf = (workdir) => path.join(workdir, '.dsh', 'bgjobs')

/** 直接跑一次任务执行体（等价于任务脚本里 node lib/mcp-runner.mjs <jobDir>\mcp.json）。 */
function runRunner(specPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, specPath], { cwd: REPO_ROOT, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c.toString('utf8') })
    child.stderr.on('data', (c) => { stderr += c.toString('utf8') })
    child.on('error', (e) => resolve({ code: null, stdout, stderr: String(e && e.message) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** 写一个 mcp.json 并跑执行体，返回 { code, stdout, stderr, result }。 */
async function runSpec(dirName, spec) {
  const dir = path.join(dirName)
  await fsp.mkdir(dir, { recursive: true })
  const specPath = path.join(dir, 'mcp.json')
  await fsp.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8')
  const r = await runRunner(specPath)
  const result = await readJson(path.join(dir, 'result.json')).catch(() => null)
  return { ...r, result }
}

// ── 1. 总开关（双层拦截） ────────────────────────────────────────────────

test('mcp: 总开关默认关闭 → 工具拒绝且不建 jobDir；job 提交层同样拒绝（双层校验）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_mcp')
    const res = await submit.execute({ name: 't', workdir, tool: 'echo', server_config: demoConfig(), arguments: { text: 'hi' } }, execWithSession())
    assert.equal(res.ok, false)
    assert.match(res.error, /MCP jobs are disabled/)
    const mcpTools = tools.find((t) => t.name === 'bgjob_mcp_tools')
    assert.match((await mcpTools.execute({ server_config: demoConfig() })).error, /MCP jobs are disabled/)
    assert.deepEqual(calls, [], '开关关闭时不得有任何 schtasks 调用')
    assert.equal(await fsp.readdir(jobsRootOf(workdir)).catch(() => []).then((n) => n.length), 0, '开关关闭时不得创建 jobDir')

    // 第②层：绕过工具层直调 submitJob 同样被拒（防程序直调）。
    const store = createStore()
    const jobs = createJobs({ get: () => undefined }, store, {
      watch: { startWatch() {}, closeWatch() {} },
      registry: { indexUpsert() {}, indexRemove() {} },
      prewarm: null,
    })
    const direct = await jobs.api.submitJob('t', 'mcp: demo → echo', workdir, '', 'mcp', 'off', 'off', 'wakeup', {
      mcpSpec: { ...demoConfig(), server: 'demo', tool: 'echo', arguments: {}, timeoutMs: 5000 },
    })
    assert.equal(direct.ok, false)
    assert.match(direct.error, /MCP jobs are disabled/)
    assert.equal(await fsp.readdir(jobsRootOf(workdir)).catch(() => []).then((n) => n.length), 0)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 2. 提交层（bat 管线落盘） ────────────────────────────────────────────

test('mcp: 内联 server_config 提交 → bat 管线落盘 + meta/mcp.json 正确', async () => {
  await enableMcp()
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_mcp')
    const res = await submit.execute({
      name: 'demo echo', workdir, tool: 'echo', server_config: demoConfig(),
      arguments: { text: 'hi' }, timeout_seconds: 30,
    }, execWithSession())
    assert.equal(res.ok, true)
    assert.equal(res.engine, 'mcp')
    assert.equal(res.tool, 'echo')

    const jobDir = path.join(jobsRootOf(workdir), res.jobId)
    const meta = await readJson(path.join(jobDir, 'job.json'))
    assert.equal(meta.engine, 'mcp')
    assert.equal(meta.sandbox, 'off', 'MCP 任务恒 off')
    assert.equal(meta.nodeExe, process.execPath)
    assert.equal(meta.mcpRunnerPath, RUNNER)
    assert.equal(meta.mcpSpecPath, path.join(jobDir, 'mcp.json'))
    assert.deepEqual(meta.mcp, { server: 'inline', tool: 'echo', transport: 'stdio', prewarm: false })
    assert.match(meta.command, /mcp: inline → echo/)

    const spec = await readJson(path.join(jobDir, 'mcp.json'))
    assert.equal(spec.command, process.execPath)
    assert.deepEqual(spec.args, [DEMO])
    assert.deepEqual(spec.arguments, { text: 'hi' })
    assert.equal(spec.timeoutMs, 30000)
    assert.equal(spec.prewarm, undefined, '未预热时不写 prewarm 端点')

    const cmd = await fsp.readFile(path.join(jobDir, 'cmd.bat'), 'utf8')
    assert.ok(cmd.includes(process.execPath), 'cmd.bat 调 Node 解释器')
    assert.ok(cmd.includes(RUNNER), 'cmd.bat 调 runner')
    assert.ok(cmd.includes('mcp.json'), 'cmd.bat 传 mcp.json 路径')
    const run = await fsp.readFile(path.join(jobDir, 'run.bat'), 'utf8')
    assert.ok(run.includes('call "') && run.includes('exitcode.txt'), 'run.bat 仍是 bat 管线（整体重定向 + 写 exitcode）')
    assert.ok((await fsp.readFile(path.join(jobDir, 'launch.vbs'), 'utf8')).includes('run.bat'), 'launch.vbs 隐藏窗口启动 run.bat')

    const create = calls.find((argv) => argv.includes('/Create'))
    const tr = create[create.indexOf('/TR') + 1]
    assert.ok(tr.includes('wscript.exe'), '/TR 仍只有 wscript（短，规避长度上限）')
    assert.ok(!tr.includes('mcp-runner'), '/TR 不内联长命令')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 3. 参数校验 ─────────────────────────────────────────────────────────

test('mcp: 参数校验（server/server_config 二选一、stdio 缺 command、http 缺 url、未登记名）', async () => {
  await enableMcp()
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  const workdir = await makeWorkdir()
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_mcp')
    const run = (args) => submit.execute({ name: 't', workdir, ...args }, execWithSession())
    assert.match((await run({ tool: 'echo', server: 'x', server_config: demoConfig() })).error, /exactly one/)
    assert.match((await run({ tool: 'echo' })).error, /exactly one/)
    assert.match((await run({ tool: 'echo', server_config: { transport: 'stdio' } })).error, /requires a non-empty "command"/)
    assert.match((await run({ tool: 'echo', server_config: { transport: 'streamable-http' } })).error, /requires a non-empty "url"/)
    assert.match((await run({ tool: 'echo', server: 'nope' })).error, /not registered/)
    assert.equal(await fsp.readdir(jobsRootOf(workdir)).catch(() => []).then((n) => n.length), 0, '校验失败不得创建任务')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 4. server 登记 + tool 名纠错 ─────────────────────────────────────────

test('mcp: 登记 server 名解析；tool 名不存在时附可用清单', async () => {
  await enableMcp()
  await registerServer('demo', { ...demoConfig(), prewarm: false })
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const mcpTools = tools.find((t) => t.name === 'bgjob_mcp_tools')
    const listing = await mcpTools.execute({ server: 'demo' })
    assert.equal(listing.ok, true)
    assert.equal(listing.source, 'probe')
    assert.deepEqual(listing.tools.map((t) => t.name).sort(), ['echo', 'fail', 'sleep'])
    assert.equal(listing.tools.find((t) => t.name === 'echo').inputSchemaSummary, 'required: text')

    const submit = tools.find((t) => t.name === 'bgjob_submit_mcp')
    const bad = await submit.execute({ name: 't', workdir, tool: 'nope', server: 'demo' }, execWithSession())
    assert.equal(bad.ok, false)
    assert.match(bad.error, /available tools: .*echo/)

    const ok = await submit.execute({ name: 't', workdir, tool: 'echo', server: 'demo', arguments: { text: 'hi' } }, execWithSession())
    assert.equal(ok.ok, true)
    assert.equal(ok.server, 'demo')
    const spec = await readJson(path.join(jobsRootOf(workdir), ok.jobId, 'mcp.json'))
    assert.equal(spec.server, 'demo', 'mcp.json 记登记名（预热代理按名路由）')
    const meta = await readJson(path.join(jobsRootOf(workdir), ok.jobId, 'job.json'))
    assert.deepEqual(meta.mcp, { server: 'demo', tool: 'echo', transport: 'stdio', prewarm: false })
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 5. 与 DSH 一致：会话访问模式不限制 MCP ───────────────────────────────

test('mcp: 受限会话（read-only）+ full access 关 → 仍可提交；对照 bat 被拒', async () => {
  await enableMcp()
  await setFullAccessEnabled(false)
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({
    services: { sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: workdir }) } },
  })
  const dispose = apply(ctx)
  try {
    const exec = execWithSession()
    const res = await tools.find((t) => t.name === 'bgjob_submit_mcp')
      .execute({ name: 't', workdir, tool: 'echo', server_config: demoConfig(), arguments: { text: 'x' } }, exec)
    assert.equal(res.ok, true, '受限会话不限制 MCP（与 DSH 一致）')
    const meta = await readJson(path.join(jobsRootOf(workdir), res.jobId, 'job.json'))
    assert.equal(meta.engine, 'mcp')
    assert.equal(meta.sandbox, 'off')
    await assert.rejects(
      tools.find((t) => t.name === 'bgjob_submit').execute({ name: 't2', command: 'echo x', workdir }, exec),
      /full access/,
      '对照：bat 引擎在受限会话 + full access 关时仍被拒',
    )
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 6. runner 端到端（本地 demo server） ─────────────────────────────────

test('mcp runner 端到端：echo=0 / fail=1 / 坏 command=2 / 超时=3', async () => {
  const tmp = await makeWorkdir()
  const base = { server: 'demo', transport: 'stdio', command: process.execPath, args: [DEMO], timeoutMs: 30000 }
  try {
    const echo = await runSpec(path.join(tmp, 'echo'), { ...base, tool: 'echo', arguments: { text: 'hello-mcp' } })
    assert.equal(echo.code, 0)
    assert.match(echo.stdout, /hello-mcp/, 'stdout 投影工具返回文本')
    assert.match(echo.stdout, /\[BGJOB\] channel: cold/)
    assert.equal(echo.result.ok, true)
    assert.equal(echo.result.channel, 'cold')
    assert.equal(echo.result.tool, 'echo')

    const fail = await runSpec(path.join(tmp, 'fail'), { ...base, tool: 'fail', arguments: { message: 'boom' } })
    assert.equal(fail.code, 1, '工具 isError → 退出码 1')
    assert.match(fail.stderr, /boom/)
    assert.equal(fail.result.isError, true)
    assert.equal(fail.result.ok, false)

    const bad = await runSpec(path.join(tmp, 'bad'), { ...base, command: path.join(tmp, 'no-such-server.exe'), tool: 'echo', arguments: {} })
    assert.equal(bad.code, 2, '连接失败 → 退出码 2')
    assert.equal(bad.result.ok, false)

    const slow = await runSpec(path.join(tmp, 'slow'), { ...base, tool: 'sleep', arguments: { seconds: 10 }, timeoutMs: 500 })
    assert.equal(slow.code, 3, '工具超时 → 退出码 3')
    assert.equal(slow.result.ok, false)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 7. 工具列表：registry 优先 / 缓存 / refresh ──────────────────────────

test('mcp 工具列表：live 注册表优先（不 spawn）→ 缓存 TTL → refresh 绕过', async () => {
  await enableMcp()
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: {} })
  ctx.tools.schemas = () => [
    { name: 'mcp__demo__echo', description: '回显', parameters: { type: 'object', required: ['text'] } },
    { name: 'mcp__demo__extra', description: 'x', parameters: { type: 'object' } },
    { name: 'bgjob_submit', description: 'y', parameters: {} },
  ]
  const dispose = apply(ctx)
  try {
    const mcpTools = tools.find((t) => t.name === 'bgjob_mcp_tools')
    // 命中注册表：server_config 指向不存在的 command，若真去 spawn 必然失败 → 证明未 spawn。
    const fromRegistry = await mcpTools.execute({ server_config: { ...demoConfig(), serverName: 'demo', command: 'no-such-command-zzz' } })
    assert.equal(fromRegistry.ok, true)
    assert.equal(fromRegistry.source, 'registry')
    assert.deepEqual(fromRegistry.tools.map((t) => t.name).sort(), ['echo', 'extra'])
    assert.equal(fromRegistry.tools[0].inputSchemaSummary, 'required: text')

    // 缓存：写一份缓存（未过期）→ 无注册表命中时直接读缓存
    await fsp.mkdir(path.dirname(bgjobsFile('mcp-tools-cache.json')), { recursive: true })
    await fsp.writeFile(bgjobsFile('mcp-tools-cache.json'), JSON.stringify({
      cached: { fetchedAt: Date.now(), transport: 'stdio', tools: [{ name: 'from-cache', description: '', inputSchemaSummary: 'no required fields' }] },
    }), 'utf8')
    const fromCache = await mcpTools.execute({ server_config: { ...demoConfig(), serverName: 'cached', command: 'no-such-command-zzz' } })
    assert.equal(fromCache.ok, true)
    assert.equal(fromCache.source, 'cache')
    assert.deepEqual(fromCache.tools.map((t) => t.name), ['from-cache'])

    // refresh 绕过缓存 → 真去 spawn（command 坏 → 失败透出）
    const refreshed = await mcpTools.execute({ server_config: { ...demoConfig(), serverName: 'cached', command: 'no-such-command-zzz' }, refresh: true })
    assert.equal(refreshed.ok, false)
    assert.match(refreshed.error, /./)

    // 真实探测：本地 demo server → 三工具
    const probed = await mcpTools.execute({ server_config: demoConfig(), refresh: true })
    assert.equal(probed.ok, true)
    assert.equal(probed.source, 'probe')
    assert.equal(probed.channel, 'cold')
    assert.deepEqual(probed.tools.map((t) => t.name).sort(), ['echo', 'fail', 'sleep'])
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 8. 预热通道（常驻连接 + 回环代理 + 回退冷启动） ──────────────────────

test('mcp 预热：命中代理 → channel=prewarm；代理不可用/坏 token → 回退冷启动且任务仍成功', async () => {
  await enableMcp()
  await registerServer('demo', { ...demoConfig(), prewarm: true })
  setSchtasksRunner(makeFakeRunner([]))
  let captured = null
  setPrewarmFactory((deps) => { captured = createMcpPrewarm(deps); return captured })
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    // apply 已异步初始化代理：等到端点可用（endpoint 非空即 init 完成）。
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (captured === null || captured.api.endpoint() === null)) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.ok(captured !== null, 'apply 应创建预热域（经 seam 捕获）')
    const endpoint = captured.api.endpoint()
    assert.ok(endpoint && endpoint.url.startsWith('http://127.0.0.1:'), '回环代理应监听 127.0.0.1 随机端口')

    // 连接常驻（模拟设置页开启预热后的状态）→ 提交任务应带上 prewarm 端点
    const rec = await captured.api.warm('demo')
    assert.equal(rec.status, 'warm')
    assert.ok(captured.api.endpointFor('demo') !== null)
    const res = await tools.find((t) => t.name === 'bgjob_submit_mcp')
      .execute({ name: 't', workdir, tool: 'echo', server: 'demo', arguments: { text: 'warm' } }, execWithSession())
    assert.equal(res.ok, true)
    const jobDir = path.join(jobsRootOf(workdir), res.jobId)
    const meta = await readJson(path.join(jobDir, 'job.json'))
    assert.equal(meta.mcp.prewarm, true, '已预热 → meta 记 prewarm')
    const spec = await readJson(path.join(jobDir, 'mcp.json'))
    assert.equal(spec.prewarm.url, endpoint.url)
    assert.equal(typeof spec.prewarm.token, 'string')

    // 跑任务执行体：应命中预热通道（零 spawn）
    const warmRun = await runRunner(path.join(jobDir, 'mcp.json'))
    assert.equal(warmRun.code, 0)
    assert.match(warmRun.stdout, /\[BGJOB\] channel: prewarm/)
    assert.equal((await readJson(path.join(jobDir, 'result.json'))).channel, 'prewarm')

    // 坏 token（模拟代理鉴权失败）→ 回退冷启动，任务仍成功
    const badSpec = { ...spec, prewarm: { ...spec.prewarm, token: 'wrong-token' } }
    const badRun = await runSpec(path.join(workdir, 'bad-token'), badSpec)
    assert.equal(badRun.code, 0)
    assert.equal(badRun.result.channel, 'cold')
    assert.match(badRun.stdout, /prewarm unavailable: .*unauthorized/)

    // 代理不可达（host 不在/端口失效）→ 回退冷启动，任务仍成功（「可脱 DSH」保证）
    const deadSpec = { ...spec, prewarm: { url: 'http://127.0.0.1:1/call', token: 'x' } }
    const dead = await runSpec(path.join(workdir, 'proxy-down'), deadSpec)
    assert.equal(dead.code, 0)
    assert.equal(dead.result.channel, 'cold')
    assert.match(dead.stdout, /falling back to cold start/)

    // 常驻连接被回收（用户关预热）→ 代理按需重建，任务照常成功
    await captured.api.unwarmAll()
    const rewarm = await runSpec(path.join(workdir, 'rewarm'), spec)
    assert.equal(rewarm.code, 0)
  } finally {
    setPrewarmFactory((deps) => createMcpPrewarm(deps))
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 9. profile 判定与 DSH 配置导入 ──────────────────────────────────────

const PATCH_WITH_MCP = [
  "- insert:",
  "    - id: mcp-matlab",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: matlab",
  "        transport: stdio",
  "        command: npx",
  "        args: ['-y', 'x']",
  "        env:",
  "          FOO: bar",
  "        toolCallTimeoutMs: 300000",
  "- insert:",
  "    - id: mcp-metaso",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: metaso",
  "        transport: streamable-http",
  "        url: https://example.invalid/mcp",
  "        headers:",
  '          Authorization: !!js \'"Bearer " + process.env.METASO_API_KEY\'',
  "- insert:",
  "    - name: '@deepseek-ai/dsh-mcp-client'",
  "      disabled: true",
  "      config:",
  "        serverName: off-srv",
  "        transport: stdio",
  "        command: node",
  // 无引号 !!js（r3/res 的真实写法）：同样必须标红——否则 yaml 会把它当普通字符串字面量静默导入。
  "- insert:",
  "    - name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: bare-js",
  "        transport: stdio",
  "        command: node",
  "        env:",
  "          METASO_API_KEY: !!js process.env.METASO_API_KEY",
  "",
].join('\n')

/** 造一个假 DSH home：profiles/r4（含 patch）与 profiles/web。 */
async function makeFakeDshHome() {
  const home = await makeWorkdir()
  await fsp.mkdir(path.join(home, 'profiles', 'r4'), { recursive: true })
  await fsp.mkdir(path.join(home, 'profiles', 'web'), { recursive: true })
  await fsp.writeFile(path.join(home, 'profiles', 'r4', 'cordis.yml'), 'plugins: {}\n', 'utf8')
  await fsp.writeFile(path.join(home, 'profiles', 'web', 'cordis.yml'), 'plugins: {}\n', 'utf8')
  await fsp.writeFile(path.join(home, 'profiles', 'r4', 'cordis.patch.yml'), PATCH_WITH_MCP, 'utf8')
  await fsp.writeFile(path.join(home, 'cordis.patch.yml'), "- insert:\n    - name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: global-srv\n        transport: stdio\n        command: node\n", 'utf8')
  return home
}

test('dsh-profiles: profile 判定（argv / 模块路径 / 单 profile / 无法判定不兜底 web）', async () => {
  const home = await makeFakeDshHome()
  try {
    assert.deepEqual((await listProfiles(home)).map((p) => p.name), ['r4', 'web'])

    // ① argv
    const byArgv = await detectActiveProfile({ home, argv: ['node', 'dsh', '--profile', 'r4'], modulePath: path.join(home, 'nope.js') })
    assert.equal(byArgv.name, 'r4')
    assert.equal(byArgv.detectedBy, 'argv')

    // ② 模块路径（非 link 安装：包根就在 profile 下）
    const pkgLib = path.join(home, 'profiles', 'web', 'node_modules', 'bgjobs', 'lib')
    await fsp.mkdir(pkgLib, { recursive: true })
    await fsp.writeFile(path.join(pkgLib, 'dsh-profiles.js'), '// stub\n', 'utf8')
    const byModule = await detectActiveProfile({ home, argv: ['node'], modulePath: path.join(pkgLib, 'dsh-profiles.js') })
    assert.equal(byModule.name, 'web')
    assert.equal(byModule.detectedBy, 'module-path')

    // ③ link 安装：profiles/r4/node_modules/bgjobs 指向别处（junction）→ 按 realpath 命中 r4
    const src = await makeWorkdir()
    await fsp.mkdir(path.join(src, 'lib'), { recursive: true })
    await fsp.writeFile(path.join(src, 'lib', 'dsh-profiles.js'), '// stub\n', 'utf8')
    let linkOk = true
    try {
      await fsp.mkdir(path.join(home, 'profiles', 'r4', 'node_modules'), { recursive: true })
      await fsp.symlink(src, path.join(home, 'profiles', 'r4', 'node_modules', 'bgjobs'), 'junction')
    } catch (e) { linkOk = false }
    if (linkOk) {
      // web 的实体包先挪开，避免两处都命中同一份源码造成歧义
      await fsp.rename(path.join(home, 'profiles', 'web', 'node_modules', 'bgjobs'), path.join(home, 'profiles', 'web', 'node_modules', 'bgjobs-moved'))
      const byLink = await detectActiveProfile({ home, argv: ['node'], modulePath: path.join(src, 'lib', 'dsh-profiles.js') })
      assert.equal(byLink.name, 'r4', 'link 安装下应经 realpath 命中 r4')
      assert.equal(byLink.detectedBy, 'module-path')
      await fsp.rename(path.join(home, 'profiles', 'web', 'node_modules', 'bgjobs-moved'), path.join(home, 'profiles', 'web', 'node_modules', 'bgjobs'))
    }
    await fsp.rm(src, { recursive: true, force: true }).catch(() => {})

    // ④ 无任何信号且多 profile → name:null（绝不兜底 web）
    const unknown = await detectActiveProfile({ home, argv: ['node'], modulePath: path.join(home, 'nope.js') })
    assert.equal(unknown.name, null)
    assert.equal(unknown.detectedBy, 'unknown')
    assert.deepEqual(unknown.candidates, ['r4', 'web'])
  } finally {
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('dsh-profiles: patch 解析（stdio / http / !!js 不求值标红 / disabled）与 scope 汇总', async () => {
  const home = await makeFakeDshHome()
  try {
    const active = await readMcpConfigs('active', { home, argv: ['node', 'dsh', '--profile', 'r4'], modulePath: path.join(home, 'nope.js') })
    assert.equal(active.exists, true)
    assert.equal(active.hasJsTag, true)
    assert.equal(active.servers.length, 4)
    const matlab = active.servers.find((s) => s.serverName === 'matlab')
    assert.equal(matlab.transport, 'stdio')
    assert.equal(matlab.enabled, true)
    assert.equal(matlab.needsAttention, false)
    assert.equal(matlab.config.command, 'npx')
    assert.deepEqual(matlab.config.args, ['-y', 'x'])
    assert.equal(matlab.config.timeoutMs, 300000)
    const metaso = active.servers.find((s) => s.serverName === 'metaso')
    assert.equal(metaso.transport, 'streamable-http')
    assert.equal(metaso.needsAttention, true, '!!js 表达式必须标红（不 eval）')
    assert.match(metaso.attentionReason, /!!js/)
    assert.equal(metaso.config.url, 'https://example.invalid/mcp')
    const off = active.servers.find((s) => s.serverName === 'off-srv')
    assert.equal(off.enabled, false, 'disabled: true → enabled false')
    // 无引号写法：`METASO_API_KEY: !!js process.env.METASO_API_KEY`
    const bare = active.servers.find((s) => s.serverName === 'bare-js')
    assert.equal(bare.needsAttention, true, '无引号 !!js 也必须标红（不 eval）')
    assert.match(bare.attentionReason, /!!js/)
    assert.match(String(bare.config.env.METASO_API_KEY), /__BGJOBS_JS_EXPRESSION__/,
      '表达式须被替换为占位符，而不是退化成普通字符串字面量（否则会静默错导）')

    const global = await readMcpConfigs('global', { home })
    assert.deepEqual(global.servers.map((s) => s.serverName), ['global-srv'])

    const all = await describeDshMcp({ home, argv: ['node', 'dsh', '--profile', 'r4'], modulePath: path.join(home, 'nope.js') })
    assert.equal(all.activeProfile, 'r4')
    assert.equal(all.detectedBy, 'argv')
    assert.deepEqual(all.scopes.map((s) => s.scope).sort(), ['global', 'r4'])

    // 纯解析：extractMcpServers 不依赖文件
    const rows = extractMcpServers([{ insert: [{ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'x', transport: 'stdio', command: 'node' } }] }])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].serverName, 'x')
  } finally {
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
