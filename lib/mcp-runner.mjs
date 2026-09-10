// bgjobs —— MCP 任务执行体（MCP 引擎）。
// 由任务脚本启动：node lib/mcp-runner.mjs "<jobDir>\mcp.json"
// 两条路径（结果形状与退出码语义完全一致）：
//   1) 预热通道：spec.prewarm = { url, token } 存在时，先 POST 到 host 常驻连接代理（§7），
//      命中则零 spawn；任何失败（拒绝/401/超时/未预热）都写日志并**回退冷启动**。
//   2) 冷启动：自己 spawn/连接 server（stdio 或 streamable-http），调用一次工具。
// 退出码：0 成功；1 工具 isError；2 配置/连接/调用失败；3 超时。
// 产物：stdout 投影文本（→ stdout.log）、jobDir/result.json、jobDir/mcp-server.pid（冷启动）。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { openClient, callTool, normalizeConfig } from './mcp-connect.js'

const EXIT_OK = 0
const EXIT_TOOL_ERROR = 1
const EXIT_CONFIG = 2
const EXIT_TIMEOUT = 3
const PREWARM_PROBE_MS = 3000

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

async function writeResult(patch) {
  const body = {
    server: spec && spec.server !== undefined ? spec.server : null,
    tool: spec && spec.tool !== undefined ? spec.tool : null,
    transport: spec && spec.transport !== undefined ? spec.transport : null,
    durationMs: Date.now() - startedAt,
    ...patch,
  }
  try { await fsp.writeFile(resultPath, JSON.stringify(body, null, 2), 'utf8') } catch { /* 尽力而为 */ }
}

/** 预热通道：把调用交给 host 侧常驻连接（省 spawn + initialize）。 */
async function tryPrewarm() {
  const pw = spec && spec.prewarm
  if (!pw || typeof pw.url !== 'string' || pw.url.length === 0) return null
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), PREWARM_PROBE_MS)
    let res
    try {
      res = await fetch(pw.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bgjobs-token': String(pw.token === undefined ? '' : pw.token) },
        body: JSON.stringify({
          server: spec.server,
          tool: spec.tool,
          arguments: spec.arguments && typeof spec.arguments === 'object' ? spec.arguments : {},
          timeoutMs: Number(spec.timeoutMs) || 60000,
        }),
        signal: ac.signal,
      })
    } finally { clearTimeout(timer) }
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || body.ok !== true || !body.result) {
      return { failed: (body && body.error ? String(body.error) : 'http ' + String(res.status)) }
    }
    return { result: body.result }
  } catch (e) {
    return { failed: errMsg(e) }
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
    return await callTool(conn.client, spec.tool, spec.arguments, Number(spec.timeoutMs) || undefined)
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
  const timedOut = /timed?\s?out|timeout/i.test(text)
  process.stderr.write('[BGJOB] ' + text + '\n')
  await writeResult({ ok: false, isError: false, channel, error: text })
  process.exit(timedOut ? EXIT_TIMEOUT : EXIT_CONFIG)
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
