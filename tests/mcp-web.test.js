// bgjobs tests —— MCP 网页端点（/bgjobs/mcpprefs、/bgjobs/mcpservers、/bgjobs/dsh-mcp）。
// 全部使用仓库自带本地 demo server；不触网。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, setSchtasksRunner, setPrewarmFactory, createMcpPrewarm, parseServerImport } from '../lib/index.js'
import { makeCtx, makeWorkdir, makeFakeRunner, attachWebServer, waitFor, installSuiteHooks } from './helpers/common.js'

installSuiteHooks()

const DEMO = fileURLToPath(new URL('./fixtures/demo-mcp-server.mjs', import.meta.url))
const bgjobsFile = (name) => path.join(process.env.DSH_HOME, 'bgjobs', name)
const readJson = async (p) => JSON.parse(await fsp.readFile(p, 'utf8'))

/** 挂 webServer 后拿路由 handler，并给一个 query/JSON-body 两用的调用器。 */
function makeClient(ctx, injectCallbacks) {
  const handler = attachWebServer(ctx, injectCallbacks)().handler
  return async (url, method = 'GET', body) => {
    let out = ''
    const req = { url, method }
    if (body !== undefined) {
      req.on = (ev, cb) => {
        if (ev === 'data') cb(Buffer.from(JSON.stringify(body), 'utf8'))
        if (ev === 'end') cb()
      }
      req.destroy = () => {}
    }
    const res = { writeHead: () => {}, end: (b) => { out = b } }
    await handler(req, res)
    return JSON.parse(out)
  }
}

const demoConfig = () => ({ transport: 'stdio', command: process.execPath, args: [DEMO] })

/** 打开 MCP 总开关（默认关闭；测试直接写 prefs 文件，等价于设置页 POST /bgjobs/mcpprefs）。 */
const enableMcp = async () => {
  await fsp.mkdir(path.dirname(bgjobsFile('mcp-prefs.json')), { recursive: true })
  await fsp.writeFile(bgjobsFile('mcp-prefs.json'), JSON.stringify({ enabled: true }), 'utf8')
}
const dshPatch = [
  "- insert:",
  "    - name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: matlab",
  "        transport: stdio",
  "        command: npx",
  "- insert:",
  "    - name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: metaso",
  "        transport: streamable-http",
  "        url: https://example.invalid/mcp",
  "        headers:",
  '          Authorization: !!js \'"Bearer " + process.env.K\'',
  "",
].join('\n')

/** 铺一个单 profile（r4）的假 DSH 配置，使活动 profile 判定落到 r4。 */
async function seedDshProfile() {
  const dir = path.join(process.env.DSH_HOME, 'profiles', 'r4')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'cordis.yml'), 'plugins: {}\n', 'utf8')
  await fsp.writeFile(path.join(dir, 'cordis.patch.yml'), dshPatch, 'utf8')
  await fsp.writeFile(path.join(process.env.DSH_HOME, 'cordis.patch.yml'), "- insert:\n    - name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: global-srv\n        transport: stdio\n        command: node\n", 'utf8')
}

// ── 总开关端点 ──────────────────────────────────────────────────────────

test('web: /bgjobs/mcpprefs 默认关闭、可切换并持久化；联动预热（开启预连、关闭断开）', async () => {
  await fsp.mkdir(path.dirname(bgjobsFile('mcp-servers.json')), { recursive: true })
  await fsp.writeFile(bgjobsFile('mcp-servers.json'), JSON.stringify({ servers: { demo: { ...demoConfig(), prewarm: true } } }), 'utf8')
  setSchtasksRunner(makeFakeRunner([]))
  let captured = null
  setPrewarmFactory((deps) => { captured = createMcpPrewarm(deps); return captured })
  const { ctx, injectCallbacks } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const call = makeClient(ctx, injectCallbacks)
    assert.equal((await call('/bgjobs/mcpprefs')).enabled, false, '缺省关闭')
    assert.equal((await call('/bgjobs/mcpprefs?enabled=1', 'POST')).enabled, true)
    assert.equal((await readJson(bgjobsFile('mcp-prefs.json'))).enabled, true, '开关应持久化')
    // 开启 → 对已登记且 prewarm 的 server 预连
    await waitFor(async () => captured !== null && captured.api.status().some((s) => s.name === 'demo' && s.warm), 5000)
    assert.equal((await call('/bgjobs/mcpservers')).servers[0].warm, true)
    // 关闭 → 全部断开
    assert.equal((await call('/bgjobs/mcpprefs?enabled=0', 'POST')).enabled, false)
    await waitFor(async () => captured.api.status().length === 0, 5000)
    assert.equal((await call('/bgjobs/mcpservers')).servers[0].warm, false)
    // 参数缺失 → 400
    await assert.rejects(async () => { const r = await call('/bgjobs/mcpprefs', 'POST'); if (!r.ok) throw new Error(r.error) }, /missing enabled/)
  } finally {
    setPrewarmFactory((deps) => createMcpPrewarm(deps))
    dispose()
  }
})

// ── server 登记端点 ─────────────────────────────────────────────────────

test('web: /bgjobs/mcpservers 增删改查（列表不回传 env/headers 值）+ probe 不受总开关限制', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const { ctx, injectCallbacks } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const call = makeClient(ctx, injectCallbacks)
    assert.deepEqual((await call('/bgjobs/mcpservers')).servers, [], '初始为空')

    // 新增（JSON body；env/headers 只留键名）
    const created = await call('/bgjobs/mcpservers', 'POST', {
      name: 'demo',
      config: { ...demoConfig(), env: { FOO: 'secret-value' } },
    })
    assert.equal(created.ok, true)
    assert.equal(created.name, 'demo')
    const saved = await readJson(bgjobsFile('mcp-servers.json'))
    assert.equal(saved.servers.demo.env.FOO, 'secret-value', '完整配置落盘')
    let list = (await call('/bgjobs/mcpservers')).servers
    assert.equal(list.length, 1)
    assert.equal(list[0].transport, 'stdio')
    assert.ok(list[0].target.includes('demo-mcp-server.mjs'))
    assert.deepEqual(list[0].envKeys, ['FOO'])
    assert.equal(JSON.stringify(list[0]).includes('secret-value'), false, '列表不得回传 env 值')

    // http 目标字段 + headers 键名
    await call('/bgjobs/mcpservers', 'POST', {
      name: 'remote',
      config: { transport: 'streamable-http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer xx' } },
    })
    list = (await call('/bgjobs/mcpservers')).servers
    const remote = list.find((s) => s.name === 'remote')
    assert.equal(remote.transport, 'streamable-http')
    assert.equal(remote.target, 'https://example.invalid/mcp')
    assert.deepEqual(remote.headerKeys, ['Authorization'])

    // 配置非法 → ok:false（fail loud，不写坏数据）
    const bad = await call('/bgjobs/mcpservers', 'POST', { name: 'broken', config: { transport: 'stdio' } })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /requires a non-empty "command"/)
    assert.equal(list.some((s) => s.name === 'broken'), false)

    // 「列出工具」：用户显式操作 → 总开关仍关闭（默认）也能探测
    assert.equal((await call('/bgjobs/mcpprefs')).enabled, false)
    const probed = await call('/bgjobs/mcpservers?name=demo&probe=1', 'POST')
    assert.equal(probed.ok, true)
    assert.deepEqual(probed.tools.map((t) => t.name).sort(), ['echo', 'fail', 'sleep'])
    const probedUnknown = await call('/bgjobs/mcpservers?name=nope&probe=1', 'POST')
    assert.equal(probedUnknown.ok, false)
    assert.match(probedUnknown.error, /not registered/)
    // 探测结果进缓存 → 列表显示 toolCount/toolSource
    list = (await call('/bgjobs/mcpservers')).servers
    assert.equal(list.find((s) => s.name === 'demo').toolCount, 3)
    assert.equal(list.find((s) => s.name === 'demo').toolSource, 'cache')

    // 预热开关 + 删除
    const pre = await call('/bgjobs/mcpservers?name=demo&prewarm=1', 'POST')
    assert.equal(pre.prewarm, true)
    assert.equal((await readJson(bgjobsFile('mcp-servers.json'))).servers.demo.prewarm, true)
    assert.equal((await call('/bgjobs/mcpservers?name=nope&prewarm=1', 'POST')).ok, false, '未登记 server 不能开预热')
    const del = await call('/bgjobs/mcpservers?name=demo&delete=1', 'POST')
    assert.equal(del.ok, true)
    assert.equal((await call('/bgjobs/mcpservers')).servers.some((s) => s.name === 'demo'), false)
  } finally {
    dispose()
  }
})

// ── DSH 导入端点 ────────────────────────────────────────────────────────

test('web: /bgjobs/dsh-mcp 只读列示 + 导入（同名跳过 / !!js 默认拒导 / force 才导 / 全局 scope）', async () => {
  await seedDshProfile()
  setSchtasksRunner(makeFakeRunner([]))
  const { ctx, injectCallbacks } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const call = makeClient(ctx, injectCallbacks)
    const info = await call('/bgjobs/dsh-mcp')
    assert.equal(info.ok, true)
    assert.equal(info.activeProfile, 'r4')
    assert.deepEqual(info.existing, [])
    const active = info.scopes.find((s) => s.scope === 'r4')
    assert.deepEqual(active.servers.map((s) => s.serverName), ['matlab', 'metaso'])
    assert.equal(active.servers.find((s) => s.serverName === 'metaso').needsAttention, true)

    // 导入单条（literal stdio）
    const one = await call('/bgjobs/dsh-mcp?action=import&scope=active&name=matlab', 'POST')
    assert.deepEqual(one.imported, ['matlab'])
    assert.equal((await readJson(bgjobsFile('mcp-servers.json'))).servers.matlab.command, 'npx')

    // 同名再导 → skipped（不覆盖）
    const again = await call('/bgjobs/dsh-mcp?action=import&scope=active&name=matlab', 'POST')
    assert.deepEqual(again.skipped.map((s) => s.name), ['matlab'])
    assert.deepEqual(again.imported, [])

    // !!js 条目默认拒导；force=1 才导
    const rejected = await call('/bgjobs/dsh-mcp?action=import&scope=active&name=metaso', 'POST')
    assert.deepEqual(rejected.rejected.map((s) => s.name), ['metaso'])
    assert.match(rejected.rejected[0].reason, /!!js/)
    const forced = await call('/bgjobs/dsh-mcp?action=import&scope=active&name=metaso&force=1', 'POST')
    assert.deepEqual(forced.imported, ['metaso'])
    const after = await call('/bgjobs/dsh-mcp')
    assert.deepEqual(after.existing.sort(), ['matlab', 'metaso'])

    // 全局 scope
    const glob = await call('/bgjobs/dsh-mcp?action=import&scope=global&name=*', 'POST')
    assert.deepEqual(glob.imported, ['global-srv'])

    // 具体 profile scope（profile:r4）
    await call('/bgjobs/mcpservers?name=matlab&delete=1', 'POST')
    const byProfile = await call('/bgjobs/dsh-mcp?action=import&scope=profile:r4&name=matlab', 'POST')
    assert.deepEqual(byProfile.imported, ['matlab'])

    // 未知 action / 不存在的 scope → 明确报错，不静默
    const badAction = await call('/bgjobs/dsh-mcp?action=nope', 'POST')
    assert.equal(badAction.ok, false)
    const badScope = await call('/bgjobs/dsh-mcp?action=import&scope=profile:ghost&name=*', 'POST')
    assert.equal(badScope.ok, false)
    assert.match(badScope.error, /no DSH MCP config/)
  } finally {
    dispose()
  }
})

// ── 展示与清理（引擎标签 / 通道 / pid 回收） ────────────────────────────

test('web: mcp 任务 done 后 state 带 engine/channel；删除时回收 stdio server pid', async () => {
  await enableMcp()
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const res = await tools.find((t) => t.name === 'bgjob_submit_mcp').execute(
      { name: 't', workdir, tool: 'echo', server_config: demoConfig(), arguments: { text: 'x' } },
      { agent: { session: { id: 's1' } } },
    )
    assert.equal(res.ok, true)
    const jobDir = path.join(workdir, '.dsh', 'bgjobs', res.jobId)
    await fsp.writeFile(path.join(jobDir, 'result.json'), JSON.stringify({ ok: true, channel: 'prewarm' }), 'utf8')
    await fsp.writeFile(path.join(jobDir, 'mcp-server.pid'), '4242', 'utf8')
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    await intervals.find((i) => i.ms === 1000).fn() // 触发完成检测（tick）

    const call = makeClient(ctx, injectCallbacks)
    const job = (await call('/bgjobs/state')).jobs.find((j) => j.id === res.jobId)
    assert.equal(job.status, 'done')
    assert.equal(job.engine, 'mcp', 'state 视图应带引擎标签')
    assert.equal(job.channel, 'prewarm', 'state 视图应带执行通道')
    assert.equal((await readJson(path.join(jobDir, 'job.json'))).mcpChannel, 'prewarm', '通道落盘供离线只读展示')

    const del = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(del.ok, true)
    assert.ok(calls.some((argv) => String(argv[0]).includes('taskkill') && argv.includes('4242')), '删除 mcp 任务应回收 server pid')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 编辑 / 导出 / 导入 ──────────────────────────────────────────────────

test('web: 单条明细含值（编辑用）、列表不回值；导出 DSH 兼容 YAML 可被自身解析回原样', async () => {
  await fsp.mkdir(path.dirname(bgjobsFile('mcp-servers.json')), { recursive: true })
  await fsp.writeFile(bgjobsFile('mcp-servers.json'), JSON.stringify({
    servers: {
      keysrv: {
        transport: 'streamable-http', url: 'http://127.0.0.1:3001/mcp',
        headers: { Authorization: 'Bearer test-key-123' }, prewarm: true, timeoutMs: 30000,
      },
      demo2: { ...demoConfig(), env: { FOO: 'bar' } },
    },
  }), 'utf8')
  const { ctx, injectCallbacks } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const call = makeClient(ctx, injectCallbacks)
    // 列表：只回键名
    const list = (await call('/bgjobs/mcpservers')).servers
    assert.equal(JSON.stringify(list).includes('test-key-123'), false)
    assert.deepEqual(list.find((s) => s.name === 'keysrv').headerKeys, ['Authorization'])
    // 明细：编辑用，含值
    const detail = await call('/bgjobs/mcpservers?name=keysrv')
    assert.equal(detail.ok, true)
    assert.equal(detail.config.headers.Authorization, 'Bearer test-key-123')
    assert.equal(detail.config.prewarm, true)
    assert.equal((await call('/bgjobs/mcpservers?name=nope')).ok, false)

    // 导出 YAML：DSH 兼容（@deepseek-ai/dsh-mcp-client + 每条一个 insert）
    const yamlOut = await call('/bgjobs/mcpservers?export=yaml')
    assert.equal(yamlOut.format, 'yaml')
    assert.deepEqual(yamlOut.names.sort(), ['demo2', 'keysrv'])
    assert.ok(yamlOut.text.includes("name: '@deepseek-ai/dsh-mcp-client'") || yamlOut.text.includes('name: "@deepseek-ai/dsh-mcp-client"'), '导出应带 DSH 插件名')
    assert.ok(yamlOut.text.includes('toolCallTimeoutMs: 30000'), 'timeoutMs 应映射为 toolCallTimeoutMs')
    assert.ok(yamlOut.text.includes('含明文密钥'), '应提示明文密钥')
    // 回环：导出的 YAML 能被导入解析器原样读回
    const round = parseServerImport(yamlOut.text)
    assert.equal(round.error, undefined)
    assert.deepEqual(round.servers.map((s) => s.name).sort(), ['demo2', 'keysrv'])
    const back = round.servers.find((s) => s.name === 'keysrv').config
    assert.equal(back.transport, 'streamable-http')
    assert.equal(back.url, 'http://127.0.0.1:3001/mcp')
    assert.equal(back.headers.Authorization, 'Bearer test-key-123')
    assert.equal(back.timeoutMs, 30000)
    // 导出 JSON = bgjobs 原生形态（可直接被导入吃回）
    const jsonOut = await call('/bgjobs/mcpservers?export=json')
    const parsedJson = JSON.parse(jsonOut.text)
    assert.deepEqual(Object.keys(parsedJson.servers).sort(), ['demo2', 'keysrv'])
    assert.equal(parseServerImport(jsonOut.text).servers.length, 2)
  } finally {
    dispose()
  }
})

test('web: 导入文本（bgjobs JSON / DSH patch / 单个配置；同名跳过 / overwrite / !!js 拒导）', async () => {
  const { ctx, injectCallbacks } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  try {
    const call = makeClient(ctx, injectCallbacks)
    // ① bgjobs 原生 JSON（含 prewarm，应原样还原）
    const native = JSON.stringify({ servers: { a1: { transport: 'stdio', command: process.execPath, args: [DEMO], prewarm: true } } })
    const r1 = await call('/bgjobs/mcpservers?import=1', 'POST', { text: native })
    assert.equal(r1.ok, true)
    assert.equal(r1.source, 'bgjobs-servers')
    assert.deepEqual(r1.imported, ['a1'])
    assert.equal((await call('/bgjobs/mcpservers?name=a1')).config.prewarm, true, 'prewarm 应随导出/导入还原')
    // 同名再导 → skip；overwrite → 覆盖
    const r2 = await call('/bgjobs/mcpservers?import=1', 'POST', { text: native })
    assert.deepEqual(r2.skipped.map((s) => s.name), ['a1'])
    const overwrite = JSON.stringify({ servers: { a1: { transport: 'stdio', command: process.execPath, args: [DEMO], timeoutMs: 5000 } } })
    const r3 = await call('/bgjobs/mcpservers?import=1', 'POST', { text: overwrite, mode: 'overwrite' })
    assert.deepEqual(r3.imported, ['a1'])
    assert.equal((await call('/bgjobs/mcpservers?name=a1')).config.timeoutMs, 5000)

    // ② DSH patch 片段（引号 !!js）→ 默认拒导、force=1 才导
    const patch = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: dsh1',
      '        transport: streamable-http',
      '        url: https://example.invalid/mcp',
      '        headers:',
      '          Authorization: !!js \'"Bearer " + process.env.K\'',
      '',
    ].join('\n')
    const r4 = await call('/bgjobs/mcpservers?import=1', 'POST', { text: patch })
    assert.equal(r4.source, 'dsh-patch')
    assert.deepEqual(r4.rejected.map((s) => s.name), ['dsh1'])
    assert.equal(typeof r4.rejected[0].reason, 'string')
    const r5 = await call('/bgjobs/mcpservers?import=1', 'POST', { text: patch, force: true })
    assert.deepEqual(r5.imported, ['dsh1'])

    // ②b 无引号 !!js（`Authorization: !!js process.env.K`）→ 同样按需人工处理（默认拒导）；
    //     旧写法会把它当普通字符串静默导入，这条用例锁住回归。
    const barePatch = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: dsh-bare',
      '        transport: streamable-http',
      '        url: https://example.invalid/mcp',
      '        headers:',
      '          Authorization: !!js process.env.BARE_KEY',
      '',
    ].join('\n')
    const r4b = await call('/bgjobs/mcpservers?import=1', 'POST', { text: barePatch })
    assert.equal(r4b.source, 'dsh-patch')
    assert.equal(r4b.hasJsTag, true)
    assert.deepEqual(r4b.rejected.map((s) => s.name), ['dsh-bare'], '无引号 !!js 也必须默认拒导')
    assert.match(r4b.rejected[0].reason, /!!js/)
    const r5b = await call('/bgjobs/mcpservers?import=1', 'POST', { text: barePatch, force: true })
    assert.deepEqual(r5b.imported, ['dsh-bare'])
    assert.doesNotMatch(String((await call('/bgjobs/mcpservers?name=dsh-bare')).config.headers.Authorization),
      /process\.env\.BARE_KEY/, '表达式不得被当普通字符串导入（应只留占位符）')

    // ③ 单个配置对象（无名字 → 报错提示）
    const single = await call('/bgjobs/mcpservers?import=1', 'POST', { text: JSON.stringify({ transport: 'stdio', command: 'node', serverName: 'solo' }) })
    assert.deepEqual(single.imported, ['solo'])
    const noName = await call('/bgjobs/mcpservers?import=1', 'POST', { text: JSON.stringify({ transport: 'stdio', command: 'node' }) })
    assert.equal(noName.ok, false, '缺名必须报错（要求 serverName）')
    assert.match(noName.error, /serverName/)
    // ④ 垃圾输入 / 空输入
    assert.equal((await call('/bgjobs/mcpservers?import=1', 'POST', { text: 'just some text' })).ok, false)
    assert.equal((await call('/bgjobs/mcpservers?import=1', 'POST', { text: '' })).ok, false)
    // ⑤ 非法配置（stdio 缺 command）→ rejected 透出原因
    const bad = await call('/bgjobs/mcpservers?import=1', 'POST', { text: JSON.stringify({ servers: { broken: { transport: 'stdio' } } }) })
    assert.deepEqual(bad.rejected.map((s) => s.name), ['broken'])
    assert.match(bad.rejected[0].reason, /command/)
  } finally {
    dispose()
  }
})

test('client bundle: 加载不报错并注册两个 settings.section（后台任务 + MCP 任务），两页均可渲染', async () => {
  const code = await fsp.readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  const React = {
    createElement: () => null,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useMemo: (fn) => fn(),
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id) // primitives 缺失 → 组件退化为自绘，不影响注册
  }
  let factory = null
  const win = { __ModuleLoader__: { load: (m) => { factory = m.factory } } }
  new Function('window', code)(win)
  assert.ok(factory !== null, 'bundle 应通过 ModuleLoader 注册')
  const mod = factory(requireStub)
  const registrations = []
  const slots = {
    register(entry, render) { registrations.push({ entry, render }); return () => {} },
    inject(_seat, cb) { cb() },
  }
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: () => () => {},
    on: () => () => {},
  }
  mod.apply(ctx)
  const sections = registrations.filter((r) => r.entry.name === 'settings.section')
  assert.deepEqual(sections.map((r) => r.entry.id), ['bgjobs', 'bgjobs-mcp'], '应注册「后台任务」与「MCP 任务」两个设置页')
  for (const r of sections) {
    assert.equal(typeof r.entry.label, 'function')
    assert.equal(typeof r.render, 'function')
    const label = r.entry.label()
    assert.equal(typeof label, 'string')
    assert.ok(label.length > 0)
    // 渲染一次：用桩 React 跑组件体，捕获语法/引用错误（fetch 由 useEffect 发起，桩里不执行）
    assert.doesNotThrow(() => r.render({}))
  }
})

// ── 设置页产物（构建期自检） ────────────────────────────────────────────

test('client bundle: 含 MCP 区块文案与端点（构建产物与源码同步）', async () => {
  const bundle = await fsp.readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  for (const needle of [
    '/bgjobs/mcpprefs', '/bgjobs/mcpservers', '/bgjobs/dsh-mcp', 'MCP 服务器', 'DSH 已有 MCP',
    'bgjobs-mcp', 'settings.mcp.nav', 'settings.mcp.prewarmHint', 'settings.mcp.exportTitle', 'settings.mcp.importTitle',
  ]) {
    assert.ok(bundle.includes(needle), 'bundle 缺少：' + needle)
  }
  // 独立页：MCP 文案不应再出现在「后台任务」页组件（settings-section.js）里
  const settingsSrc = await fsp.readFile(fileURLToPath(new URL('../lib/client-src/settings-section.js', import.meta.url)), 'utf8')
  assert.equal(settingsSrc.includes('McpSettings'), false, 'MCP 区块应已从「后台任务」页拆出')
})
