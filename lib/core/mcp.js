// bgjobs core —— MCP 域（MCP 引擎）：server 解析 + 工具列表（registry 优先 / 探测兜底 / 缓存）。
// 供 bgjob_submit_mcp、bgjob_mcp_tools 与 /bgjobs/mcpservers 端点共用同一实现（单一口径）。
// 工具数/工具名来源优先级：live 工具注册表 ctx.tools.schemas() 的 `mcp__<server>__*`（零
// 启动开销，DSH 已连接则免 spawn）→ 预热常驻连接（零 spawn）→ 冷启动探测（spawn 一次）。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { errorMsg } from '../util.js'
import { resolveBgjobsHome } from '../index-store.js'
import { normalizeConfig, openClient, listTools } from '../mcp-connect.js'

/** 工具列表缓存 TTL（§5b：10 分钟；refresh 绕过）。 */
const CACHE_TTL_MS = 10 * 60 * 1000
/** DSH 侧 MCP 工具的公开名前缀（packages/mcp/mcp-client 的 publicToolName）。 */
const MCP_TOOL_PREFIX = 'mcp__'
const DESCRIPTION_CAP = 200

/** 从 inputSchema 提取"必填字段名"摘要（不整段回传 schema，控制上下文体积）。 */
function summarizeSchema(schema) {
  const s = schema && typeof schema === 'object' ? schema : {}
  const required = Array.isArray(s.required) ? s.required.map(String) : []
  return required.length > 0 ? 'required: ' + required.join(', ') : 'no required fields'
}

function summarizeTool(name, description, schema) {
  const desc = typeof description === 'string' ? description : ''
  return {
    name: String(name),
    description: desc.length > DESCRIPTION_CAP ? desc.slice(0, DESCRIPTION_CAP) + '…' : desc,
    inputSchemaSummary: summarizeSchema(schema),
  }
}

/**
 * 创建 MCP 域。deps：{ prewarm, version }（prewarm = lib/mcp-prewarm.js 的 api，可为 null）。
 * api：{ resolveServer, tools, registryTools, cachePath }
 */
export function createMcp(ctx, store, deps) {
  const prewarm = deps && deps.prewarm ? deps.prewarm : null
  const versionOf = deps && typeof deps.version === 'function' ? deps.version : () => '0.0.0'

  const cachePath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'mcp-tools-cache.json')
  const readCache = async () => {
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath(), 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (e) { return {} }
  }
  const writeCache = async (cache) => {
    try {
      const p = cachePath()
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify(cache, null, 2), 'utf8')
    } catch (e) { /* 尽力而为：缓存写失败不影响探测结果 */ }
  }

  /** live 工具注册表里的 `mcp__<server>__*`（零 spawn）；注册表不可用/无命中 → null。 */
  const registryTools = (serverName) => {
    if (!ctx || !ctx.tools || typeof ctx.tools.schemas !== 'function') return null
    const name = String(serverName)
    if (name.length === 0) return null
    let schemas = []
    try { schemas = ctx.tools.schemas() } catch (e) { return null }
    if (!Array.isArray(schemas)) return null
    const prefix = MCP_TOOL_PREFIX + name + '__'
    const hits = schemas.filter((s) => s && typeof s.name === 'string' && s.name.startsWith(prefix))
    if (hits.length === 0) return null
    return hits.map((s) => summarizeTool(s.name.slice(prefix.length), s.description, s.parameters))
  }

  /** 实际连接探测：预热常驻连接优先（零 spawn、且不新开会话），否则冷启动一次。 */
  const probe = async (target) => {
    if (prewarm && target.name) {
      // 复用常驻连接的条件：该 server 开了预热（listTools 会按需 warm），或当前恰好已有 warm 记录。
      // 这样**不会**在同一 server 上再开第二个会话——对只允许单会话的 stateful server 尤其重要
      // （实测：上游模板把单例 server 连到每个新会话，第二会话会让第一会话的请求挂死）。
      const alreadyWarm = prewarm.status().some((s) => s.name === target.name && s.warm)
      if (target.prewarm === true || alreadyWarm) {
        try {
          const tools = await prewarm.listTools(target.name)
          return { tools: tools.map((t) => summarizeTool(t.name, t.description, t.inputSchema)), channel: 'prewarm' }
        } catch (e) { /* 预热不可用 → 回退冷启动探测（下面） */ }
      }
    }
    const conn = await openClient(target.config, { name: 'bgjobs-mcp-probe', version: String(versionOf()) })
    try {
      const tools = await listTools(conn.client)
      return { tools: tools.map((t) => summarizeTool(t.name, t.description, t.inputSchema)), channel: 'cold' }
    } finally {
      try { await conn.client.close() } catch (e) { /* 已断开 */ }
    }
  }

  /**
   * 解析 server 目标：`server`（登记名）与 `server_config`（内联）必须且只能给一个。
   * 返回 { name, config, prewarm, timeoutMs }；name 为 '' 表示匿名内联（不参与预热/缓存）。
   * @throws 参数非法 / server 未登记 / 配置不合法（fail loud，由工具层转成 { ok:false, error }）。
   */
  const resolveServer = async (input) => {
    const src = input && typeof input === 'object' ? input : {}
    const hasName = typeof src.server === 'string' && src.server.trim().length > 0
    const hasInline = src.server_config !== undefined && src.server_config !== null && typeof src.server_config === 'object'
    if (hasName === hasInline) {
      throw new Error('give exactly one of "server" (registered name) or "server_config" (inline server config)')
    }
    if (hasInline) {
      const config = normalizeConfig(src.server_config)
      const inlineName = typeof src.server_config.serverName === 'string' ? src.server_config.serverName.trim() : ''
      return {
        name: inlineName,
        config,
        prewarm: src.server_config.prewarm === true,
        timeoutMs: typeof src.server_config.timeoutMs === 'number' && src.server_config.timeoutMs > 0 ? Math.floor(src.server_config.timeoutMs) : undefined,
      }
    }
    const name = src.server.trim()
    const { servers } = await store.readMcpServers()
    const raw = servers[name]
    if (raw === undefined || raw === null) {
      throw new Error('MCP server not registered: ' + name + '; register it in the bgjobs settings page or pass "server_config" inline')
    }
    return {
      name,
      config: normalizeConfig(raw),
      prewarm: raw.prewarm === true,
      timeoutMs: typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? Math.floor(raw.timeoutMs) : undefined,
    }
  }

  /**
   * 工具列表。顺序：live 注册表（registry，零 spawn）→ 10 分钟缓存 → 预热连接/冷启动探测。
   * refresh=true 跳过缓存（注册表仍优先，它是"健康"来源而非缓存）。
   * 返回 { ok, server, transport, source: 'registry'|'cache'|'probe', channel?, tools, fetchedAt }。
   */
  const tools = async (target, options = {}) => {
    const refresh = options.refresh === true
    if (target.name) {
      const fromRegistry = registryTools(target.name)
      if (fromRegistry !== null) {
        return { ok: true, server: target.name, transport: target.config.transport, source: 'registry', tools: fromRegistry, fetchedAt: Date.now() }
      }
    }
    const cache = await readCache()
    const hit = target.name ? cache[target.name] : undefined
    if (!refresh && hit && typeof hit.fetchedAt === 'number' && Date.now() - hit.fetchedAt <= CACHE_TTL_MS && Array.isArray(hit.tools)) {
      return { ok: true, server: target.name, transport: hit.transport || target.config.transport, source: 'cache', tools: hit.tools, fetchedAt: hit.fetchedAt }
    }
    let probed
    try {
      probed = await probe(target)
    } catch (e) {
      // 探测失败也要让调用方拿到 info（设置页要展示原因）。
      return { ok: false, server: target.name, transport: target.config.transport, error: errorMsg(e) }
    }
    if (target.name) {
      cache[target.name] = { fetchedAt: Date.now(), transport: target.config.transport, tools: probed.tools }
      await writeCache(cache)
    }
    return {
      ok: true, server: target.name, transport: target.config.transport,
      source: 'probe', channel: probed.channel, tools: probed.tools, fetchedAt: Date.now(),
    }
  }

  return { api: { resolveServer, tools, registryTools, readCache, cachePath }, dispose: [] }
}
