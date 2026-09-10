// bgjobs —— MCP 预热（MCP 引擎 §7）：host 侧常驻连接 + 127.0.0.1 回环代理。
// 定位：**只做加速**。任务 runner 先试代理（省 spawn + initialize），失败一律回退冷启动；
// host 退出/预热关闭/连接 down 都不影响任务正确性（「schtasks 托管、可脱 DSH」不破）。
// 形态对齐第一方 mcp-client 的 supervisor：onclose 触发 + 有界指数退避 + 空闲 TTL 回收，
// 不做 ping/健康检查（存活探测完全依赖 onclose）。
// 安全：代理只绑 127.0.0.1，鉴权 = 每次 apply 生成的随机 token（随任务 mcp.json 下发）。

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { openClient, listTools as listToolsOf, projectResult } from './mcp-connect.js'

const RECONNECT_INITIAL_MS = 500
const RECONNECT_MAX_MS = 30000
const RECONNECT_MAX_ATTEMPTS = 10
const IDLE_TTL_MS = 10 * 60 * 1000
const IDLE_SWEEP_MS = 60 * 1000
const PROXY_BODY_LIMIT = 1024 * 1024

const errMsg = (e) => (e && e.message ? String(e.message) : String(e))

/**
 * 创建预热域。deps:
 *   - resolveConfig: async (serverName) => config | null   （从 store 读登记配置）
 *   - version: () => string                                 （clientInfo 版本）
 * 返回 { api, dispose }，api = { warm, unwarm, unwarmAll, status, endpoint, call }。
 */
export function createMcpPrewarm(deps) {
  const resolveConfig = deps && typeof deps.resolveConfig === 'function' ? deps.resolveConfig : async () => null
  const versionOf = deps && typeof deps.version === 'function' ? deps.version : () => '0.0.0'
  /** name → { status:'warm'|'connecting'|'down', client, retries, timer, lastUsedAt, lastError, stopped } */
  const records = new Map()
  /** name → Promise（同一 server 的调用串行化，避免 stdio 并发压力） */
  const queues = new Map()
  const token = randomUUID()
  let httpServer = null
  let port = 0
  let sweepTimer = null
  let disposed = false

  const recordOf = (name) => records.get(String(name))

  async function connect(name) {
    const key = String(name)
    let rec = records.get(key)
    if (rec === undefined) {
      rec = { status: 'connecting', client: undefined, retries: 0, timer: undefined, pending: undefined, lastUsedAt: Date.now(), lastError: undefined, stopped: false }
      records.set(key, rec)
    }
    if (rec.stopped || disposed) return rec
    // 幂等：同一 server 的并发 warm/调用共享同一次连接尝试。否则并发会重复 spawn 同一
    // stdio server，只有最后一次被记录，其余子进程成为孤儿（实测：测试进程退出被拖住）。
    if (rec.pending !== undefined) return rec.pending
    const pending = doConnect(key, rec)
    rec.pending = pending
    try { return await pending } finally { if (rec.pending === pending) rec.pending = undefined }
  }

  /** 一次实际连接尝试（由 connect 去重后调用）。 */
  async function doConnect(key, rec) {
    const config = await resolveConfig(key)
    if (!config) {
      rec.status = 'down'
      rec.lastError = 'server not registered: ' + key
      return rec
    }
    rec.status = 'connecting'
    try {
      const conn = await openClient(config, { name: 'bgjobs-mcp-prewarm', version: String(versionOf()) })
      // 连接期间被 unwarm/dispose（记录已移除）→ 立即关掉，避免留下孤儿 server 进程。
      if (rec.stopped || disposed || records.get(key) !== rec) {
        try { await conn.client.close() } catch { /* noop */ }
        return rec
      }
      rec.client = conn.client
      rec.status = 'warm'
      rec.lastError = undefined
      rec.lastUsedAt = Date.now()
      // onclose：SDK transport 关闭即触发（crash/被强杀/网络断）
      const transport = conn.transport
      if (transport && typeof transport.onclose === 'function') {
        const previous = transport.onclose
        transport.onclose = () => {
          try { if (typeof previous === 'function') previous() } catch { /* noop */ }
          handleClosed(key)
        }
      }
      return rec
    } catch (e) {
      rec.status = 'down'
      rec.client = undefined
      rec.lastError = errMsg(e)
      scheduleReconnect(key)
      return rec
    }
  }

  function handleClosed(name) {
    const rec = records.get(name)
    if (rec === undefined || rec.stopped || disposed) return
    rec.client = undefined
    rec.status = 'down'
    if (rec.lastError === undefined) rec.lastError = 'connection closed'
    scheduleReconnect(name)
  }

  function scheduleReconnect(name) {
    const rec = records.get(name)
    if (rec === undefined || rec.stopped || disposed) return
    if (rec.timer !== undefined) return
    if (rec.retries >= RECONNECT_MAX_ATTEMPTS) {
      rec.status = 'down'
      rec.lastError = (rec.lastError ? rec.lastError + '; ' : '') + 'giving up after ' + String(RECONNECT_MAX_ATTEMPTS) + ' attempts'
      return
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * 2 ** rec.retries)
    rec.timer = setTimeout(() => {
      rec.timer = undefined
      if (rec.stopped || disposed) return
      rec.retries += 1
      connect(name)
    }, delay)
    if (typeof rec.timer.unref === 'function') rec.timer.unref()
  }

  /** 建立/复用常驻连接（幂等）。 */
  async function warm(name) {
    const key = String(name)
    const rec = records.get(key)
    if (rec && rec.status === 'warm' && rec.client !== undefined) return rec
    if (rec && rec.stopped) { rec.stopped = false; rec.retries = 0 }
    return connect(key)
  }

  /** 主动断开并停止重连（用户关预热 / MCP 总开关关闭）。 */
  async function unwarm(name) {
    const key = String(name)
    const rec = records.get(key)
    if (rec === undefined) return { ok: true }
    rec.stopped = true
    if (rec.timer !== undefined) { clearTimeout(rec.timer); rec.timer = undefined }
    const client = rec.client
    records.delete(key)
    if (client) { try { await client.close() } catch { /* noop */ } }
    return { ok: true }
  }

  async function unwarmAll() {
    for (const name of Array.from(records.keys())) await unwarm(name)
  }

  /** 预热状态快照（设置页 warm 字段）。 */
  function status() {
    return Array.from(records.entries()).map(([name, rec]) => ({
      name,
      status: rec.status,
      warm: rec.status === 'warm' && rec.client !== undefined,
      lastUsedAt: rec.lastUsedAt,
      ...(rec.lastError !== undefined ? { lastError: rec.lastError } : {}),
    }))
  }

  /** 当前代理端点（仅预热可用时返回；写进任务 mcp.json）。 */
  function endpoint() {
    if (disposed || httpServer === null || port === 0) return null
    return { url: 'http://127.0.0.1:' + String(port) + '/call', token }
  }

  /** 该 server 若已有可用常驻连接 → 返回代理端点（写进任务 mcp.json）；否则 null。 */
  function endpointFor(name) {
    const rec = records.get(String(name))
    if (rec === undefined || rec.status !== 'warm' || rec.client === undefined) return null
    return endpoint()
  }

  /**
   * 走常驻连接列工具（设置页「列出工具」/bgjob_mcp_tools 的预热通道，零 spawn）。
   * 未预热 → 抛错（调用方回退冷启动探测）。
   */
  async function listTools(server) {
    return withQueue(server, async () => {
      const rec = await warm(server)
      if (rec.status !== 'warm' || rec.client === undefined) {
        throw new Error('server is not warm: ' + String(server) + (rec.lastError ? ' (' + rec.lastError + ')' : ''))
      }
      try {
        const tools = await listToolsOf(rec.client)
        rec.lastUsedAt = Date.now()
        return tools
      } catch (e) {
        rec.lastUsedAt = Date.now()
        throw e
      }
    })
  }

  /** 同一 server 的调用串行化。 */
  function withQueue(name, fn) {
    const key = String(name)
    const previous = queues.get(key) || Promise.resolve()
    const next = previous.then(fn, fn)
    queues.set(key, next.catch(() => {}))
    return next
  }

  /** 代理侧调用：确保预热 → 调用 → 项目化结果（形状与 runner 的冷启动一致）。 */
  async function call(server, tool, args, timeoutMs) {
    return withQueue(server, async () => {
      const rec = await warm(server)
      if (rec.status !== 'warm' || rec.client === undefined) {
        throw new Error('server is not warm: ' + String(server) + (rec.lastError ? ' (' + rec.lastError + ')' : ''))
      }
      rec.lastUsedAt = Date.now()
      try {
        const raw = await rec.client.callTool(
          { name: String(tool), arguments: args && typeof args === 'object' ? args : {} },
          undefined,
          timeoutMs ? { timeout: Number(timeoutMs) } : undefined,
        )
        rec.lastUsedAt = Date.now()
        return projectResult(raw)
      } catch (e) {
        // 调用失败不改连接状态（可能是工具自身错误/超时）；连接断开由 onclose 处理
        rec.lastUsedAt = Date.now()
        throw e
      }
    })
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > PROXY_BODY_LIMIT) { reject(new Error('request body too large')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function startProxy() {
    httpServer = http.createServer(async (req, res) => {
      const respond = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      try {
        if (req.method !== 'POST') { respond(404, { ok: false, error: 'not found' }); return }
        const pathname = String(req.url || '')
        if (pathname !== '/call' && pathname !== '/tools') { respond(404, { ok: false, error: 'not found' }); return }
        if (String(req.headers['x-bgjobs-token'] || '') !== token) { respond(401, { ok: false, error: 'unauthorized' }); return }
        const text = await readBody(req)
        let body
        try { body = JSON.parse(text) } catch (e) { respond(400, { ok: false, error: 'invalid json' }); return }
        const server = body && body.server !== undefined ? String(body.server) : ''
        if (server.length === 0) { respond(400, { ok: false, error: 'missing server' }); return }
        if (pathname === '/tools') {
          respond(200, { ok: true, tools: await listTools(server) })
          return
        }
        const result = await call(server, body.tool, body.arguments, body.timeoutMs)
        respond(200, { ok: true, result })
      } catch (e) {
        respond(200, { ok: false, error: errMsg(e) })
      }
    })
    return new Promise((resolve) => {
      httpServer.on('error', () => resolve(false))
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address()
        port = addr && typeof addr === 'object' ? addr.port : 0
        // unref：代理只是加速通道，不因它单独存活而拖住宿主进程退出（DSH 自然常驻）。
        if (typeof httpServer.unref === 'function') httpServer.unref()
        resolve(port !== 0)
      })
    })
  }

  async function init() {
    const ok = await startProxy()
    if (!ok) { port = 0; return { ok: false, error: 'prewarm proxy failed to listen on 127.0.0.1' } }
    sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [name, rec] of Array.from(records.entries())) {
        if (rec.status !== 'warm') continue
        if (now - rec.lastUsedAt <= IDLE_TTL_MS) continue
        unwarm(name)
      }
    }, IDLE_SWEEP_MS)
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
    return { ok: true, port }
  }

  async function dispose() {
    disposed = true
    if (sweepTimer !== null) { clearInterval(sweepTimer); sweepTimer = null }
    await unwarmAll()
    if (httpServer !== null) {
      const s = httpServer
      httpServer = null
      await new Promise((resolve) => { try { s.close(() => resolve()) } catch { resolve() } })
    }
  }

  return {
    api: { init, warm, unwarm, unwarmAll, status, endpoint, endpointFor, call, listTools },
    dispose: [dispose],
  }
}

/**
 * 测试替身 seam（与 runners.js 的 set*Runner 同形）：默认即真实实现。
 * 测试可替换工厂以捕获本 apply 实例的预热域（驱动 warm/endpoint 断言）。
 */
export function setPrewarmFactory(fn) { prewarmFactory = fn }
let prewarmFactory = (deps) => createMcpPrewarm(deps)

/** 按当前工厂创建预热域（apply 用）。 */
export function newPrewarm(deps) { return prewarmFactory(deps) }
