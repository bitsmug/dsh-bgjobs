// bgjobs —— MCP 任务执行体（MCP 引擎）。
// 由任务脚本启动：node lib/mcp-runner.mjs "<jobDir>\mcp.json"
// 两条路径（结果形状与退出码语义完全一致）：
//   1) 预热通道：spec.prewarm = { url, token } 存在时，先 POST 到 host 常驻连接代理（§7），
//      命中则零 spawn。**只有"确定没执行"（代理不可达/401/未预热 → attempted 非 true）才回退冷启动**；
//      已经是"请求发出去过但失败/超时"（attempted:true）则直接按退出码收尾，绝不重跑（防重复副作用）。
//   2) 冷启动：自己 spawn/连接 server（stdio 或 streamable-http），调用一次工具。
// 超时：spec.timeoutMs 可任意大；**未传 = 不限时**（不设 SDK 超时、预算取 MAX_TIMER_MS）。
// 退出码：0 成功；1 工具 isError；2 配置/连接/调用失败；3 超时。
// 产物：stdout 投影文本（→ stdout.log）、jobDir/result.json、jobDir/mcp-server.pid（冷启动）。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { openClient, callTool, normalizeConfig, clampTimerMs, MAX_TIMER_MS } from './mcp-connect.js'

const EXIT_OK = 0
const EXIT_TOOL_ERROR = 1
const EXIT_CONFIG = 2
const EXIT_TIMEOUT = 3
// 预热通道的中止预算 = 调用超时 + 宽限（下限 10s），只兜底"host 完全不响应"；
// 绝不能再像早期那样固定 3s——那会把"耗时 >3s 的正常调用"误判为预热不可用，导致工具被执行两遍。
const PREWARM_GRACE_MS = 5000
const PREWARM_MIN_BUDGET_MS = 10000
/** 连接阶段就失败的错误码 = 请求根本没发出去（未执行）。 */
const CONNECT_FAIL_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])
/** undici 在构造请求阶段就失败（如被禁端口 "bad port"、非法 URL）——同样没发出去，且不带错误码。 */
const NEVER_SENT_HINTS = /bad port|invalid url|unsupported protocol|ERR_INVALID_URL/i

const errMsg = (e) => (e && e.message ? String(e.message) : String(e))
const log = (line) => process.stdout.write(String(line) + '\n')

const specPath = process.argv[2]
if (typeof specPath !== 'string' || specPath.length === 0) {
  process.stderr.write('usage: node mcp-runner.mjs <path-to-mcp.json>\n')
  process.exit(EXIT_CONFIG)
}

const resolvedSpecPath = path.resolve(specPath)
const jobDir = path.dirname(resolvedSpecPath)
const resultPath = path.join(jobDir, 'result.json')
const pidPath = path.join(jobDir, 'mcp-server.pid')
const startedAt = Date.now()

let spec = null
try {
  spec = JSON.parse(await fsp.readFile(resolvedSpecPath, 'utf8'))
} catch (e) {
  await writeResult({ ok: false, error: 'read spec failed: ' + errMsg(e) })
  process.exit(EXIT_CONFIG)
}

/** 本次调用的显式超时（ms）：未传/非正数 → null（不限时）。 */
const timeoutOf = () => {
  const n = Number(spec && spec.timeoutMs)
  return Number.isFinite(n) && n > 0 ? clampTimerMs(n) : null
}

/** 预热通道中止预算：见 PREWARM_GRACE_MS 注释；不限时时取 MAX_TIMER_MS（等于不中止）。 */
const prewarmBudgetMs = () => {
  const t = timeoutOf()
  return t === null ? MAX_TIMER_MS : clampTimerMs(Math.max(PREWARM_MIN_BUDGET_MS, t + PREWARM_GRACE_MS))
}

/** 失败分类：超时 → 3；其余（配置/连接/调用）→ 2。 */
const exitForFailure = (text) => (/timed?\s?out|timeout/i.test(String(text)) ? EXIT_TIMEOUT : EXIT_CONFIG)

/**
 * fetch 抛错时判断"请求是否可能已经发出去过"。
 * 只有能确定为"构造/连接阶段失败"的（未执行）才返回 false（可安全回退冷启动）；
 * 其余一律返回 true（保守：宁可让这次任务失败，也不冒重复副作用的风险）。
 */
const wasSent = (e) => {
  if (e && e.name === 'AbortError') return true
  const code = String((e && (e.code || (e.cause && e.cause.code))) || '')
  if (CONNECT_FAIL_CODES.has(code)) return false
  const hint = String((e && e.cause && e.cause.message) || (e && e.message) || '')
  if (NEVER_SENT_HINTS.test(hint)) return false
  return true
}

async function writeResult(patch) {
  const body = {
    server: spec && spec.server !== undefined ? spec.server : null,
    tool: spec && spec.tool !== undefined ? spec.tool : null,
    transport: spec && spec.transport !== undefined ? spec.transport : null,
    // 供调用方对照：超时/失败的收尾要关连接（SDK close 会等进程退出），durationMs 可能比它多 1–2s。
    timeoutMs: spec && Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : null,
    durationMs: Date.now() - startedAt,
    ...patch,
  }
  try { await fsp.writeFile(resultPath, JSON.stringify(body, null, 2), 'utf8') } catch { /* 尽力而为 */ }
}

/**
 * 预热通道：把调用交给 host 侧常驻连接（省 spawn + initialize）。
 * 返回 { result }（命中）或 { failed, attempted }（失败）：
 *   attempted=true  = 请求已送到 host，调用**可能已在 server 侧执行**→ 上层不得回退冷启动（防重复副作用）；
 *   attempted=false = 连接阶段失败/未预热（确定未执行）→ 可安全回退冷启动。
 */
async function tryPrewarm() {
  const pw = spec && spec.prewarm
  if (!pw || typeof pw.url !== 'string' || pw.url.length === 0) return null
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), prewarmBudgetMs())
    let res
    try {
      const t = timeoutOf()
      res = await fetch(pw.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bgjobs-token': String(pw.token === undefined ? '' : pw.token) },
        body: JSON.stringify({
          server: spec.server,
          tool: spec.tool,
          arguments: spec.arguments && typeof spec.arguments === 'object' ? spec.arguments : {},
          // 不限时（未传 timeoutMs）→ 不带该字段，host 也不设 SDK 超时。
          ...(t === null ? {} : { timeoutMs: t }),
        }),
        signal: ac.signal,
      })
    } finally { clearTimeout(timer) }
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || body.ok !== true || !body.result) {
      return {
        failed: (body && body.error ? String(body.error) : 'http ' + String(res.status)),
        attempted: !!(body && body.attempted === true),
      }
    }
    return { result: body.result }
  } catch (e) {
    return { failed: errMsg(e), attempted: wasSent(e) }
  }
}

async function closeQuietly(conn) {
  if (!conn || !conn.client) return
  try { await conn.client.close() } catch { /* 已断开 */ }
}

async function coldCall() {
  const conn = await openClient(spec, { name: 'bgjobs-mcp-runner', version: '1.0.0' })
  const pid = conn.transport && conn.transport.pid
  if (pid !== undefined && pid !== null) {
    try { await fsp.writeFile(pidPath, String(pid), 'utf8') } catch { /* 尽力而为 */ }
  }
  try {
    const t = timeoutOf()
    return await callTool(conn.client, spec.tool, spec.arguments, t === null ? undefined : t)
  } finally {
    await closeQuietly(conn)
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
try { normalizeConfig(spec) } catch (e) {
  await writeResult({ ok: false, error: errMsg(e) })
  process.stderr.write('[BGJOB] ' + errMsg(e) + '\n')
  process.exit(EXIT_CONFIG)
}

log(`[BGJOB] mcp call: server=${String(spec.server)} tool=${String(spec.tool)} transport=${String(spec.transport)}`)

let channel = 'cold'
let outcome = null
let failure = null

const pre = await tryPrewarm()
if (pre && pre.result) {
  channel = 'prewarm'
  outcome = pre.result
} else if (pre && pre.failed && pre.attempted === true) {
  // 调用已经发出去过（可能已在 server 侧执行）→ 不回退冷启动重跑，直接按失败收尾。
  channel = 'prewarm'
  const text = pre.failed
  process.stderr.write('[BGJOB] ' + text + '\n')
  await writeResult({ ok: false, isError: false, channel, error: text })
  process.exit(exitForFailure(text))
} else {
  if (pre && pre.failed) log(`[BGJOB] prewarm unavailable: ${pre.failed}; falling back to cold start`)
  try {
    outcome = await coldCall()
  } catch (e) {
    failure = e
  }
}
log(`[BGJOB] channel: ${channel}`)

if (failure !== null) {
  const text = errMsg(failure)
  process.stderr.write('[BGJOB] ' + text + '\n')
  await writeResult({ ok: false, isError: false, channel, error: text })
  process.exit(exitForFailure(text))
}

if (outcome.isError === true) {
  if (outcome.text) process.stderr.write(outcome.text + '\n')
  await writeResult({ ok: false, isError: true, channel, content: outcome.content, ...(outcome.structuredContent !== undefined ? { structuredContent: outcome.structuredContent } : {}), error: outcome.text || 'tool reported an error' })
  process.exit(EXIT_TOOL_ERROR)
}

if (outcome.text) log(outcome.text)
await writeResult({
  ok: true,
  isError: false,
  channel,
  content: outcome.content,
  ...(outcome.structuredContent !== undefined ? { structuredContent: outcome.structuredContent } : {}),
})
process.exit(EXIT_OK)
