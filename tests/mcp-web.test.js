// bgjobs tests —— MCP 网页端点（/bgjobs/mcpprefs、/bgjobs/mcpservers、/bgjobs/dsh-mcp）。
// 全部使用仓库自带本地 demo server；不触网。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, setSchtasksRunner, setPrewarmFactory, createMcpPrewarm } from '../lib/index.js'
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

// ── 设置页产物（构建期自检） ────────────────────────────────────────────

test('client bundle: 含 MCP 区块文案与端点（构建产物与源码同步）', async () => {
  const bundle = await fsp.readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  for (const needle of ['/bgjobs/mcpprefs', '/bgjobs/mcpservers', '/bgjobs/dsh-mcp', 'MCP 服务器', 'DSH 已有 MCP']) {
    assert.ok(bundle.includes(needle), 'bundle 缺少：' + needle)
  }
})
