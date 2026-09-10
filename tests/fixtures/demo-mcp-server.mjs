// bgjobs 测试/自测用 —— 本地 demo MCP server（零依赖、纯 stdio NDJSON、完全离线）。
// 用途：自动化测试（tests/mcp.test.js）与手工验证（登记为 server_config：
//   { transport:'stdio', command:<node 绝对路径>, args:["<repo>/tests/fixtures/demo-mcp-server.mjs"] }）。
// 协议：JSON-RPC over stdin/stdout，一行一条（MCP SDK 的 stdio transport 用换行分隔）。
// 工具：
//   echo  { text }            → 原样回显文本（成功路径 / content 投影）
//   sleep { seconds }         → 延迟后返回（wait 命中、超时、停止、消息让路等"在途"场景）
//   fail  { message? }        → isError:true（退出码 1 路径）
// 参数（env 或 argv 均可）：
//   DEMO_MCP_STALL_MS=0      → 每个请求前额外延迟（模拟慢 server）
//   DEMO_MCP_BROKEN=1        → 不响应 initialize（模拟坏 server；仍保持进程存活）
import readline from 'node:readline'

const PROTOCOL_FALLBACK = '2024-11-05'
const STALL_MS = Number(process.env.DEMO_MCP_STALL_MS || 0) || 0
const BROKEN = process.env.DEMO_MCP_BROKEN === '1'

const TOOLS = [
  {
    name: 'echo',
    description: '回显传入的 text（demo）',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'sleep',
    description: '等待 seconds 秒后返回（demo；上限 30 秒）',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
  },
  {
    name: 'fail',
    description: '总是以 isError 结束（demo）',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  },
]

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function ok(id, result) { send({ jsonrpc: '2.0', id, result }) }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function handleCall(id, params) {
  const name = params && params.name
  const args = (params && params.arguments) || {}
  if (name === 'echo') {
    ok(id, { content: [{ type: 'text', text: String(args.text === undefined ? '' : args.text) }] })
    return
  }
  if (name === 'sleep') {
    const sec = Math.min(Math.max(Number(args.seconds) || 0, 0), 30)
    await sleep(sec * 1000)
    ok(id, { content: [{ type: 'text', text: `slept ${sec}s` }] })
    return
  }
  if (name === 'fail') {
    ok(id, { content: [{ type: 'text', text: String(args.message || 'demo failure') }], isError: true })
    return
  }
  ok(id, { content: [{ type: 'text', text: `unknown tool: ${String(name)}` }], isError: true })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const text = line.trim()
  if (text.length === 0) return
  let msg
  try { msg = JSON.parse(text) } catch (e) { return } // 坏行忽略（真实 server 同理）
  const { id, method, params } = msg
  if (STALL_MS > 0) await sleep(STALL_MS)
  if (method === 'initialize') {
    if (BROKEN) return // 故意不响应
    ok(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_FALLBACK,
      capabilities: { tools: {} },
      serverInfo: { name: 'bgjobs-demo-mcp', version: '1.0.0' },
    })
    return
  }
  if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) return
  if (method === 'ping') { ok(id, {}); return }
  if (method === 'tools/list') { ok(id, { tools: TOOLS }); return }
  if (method === 'tools/call') { await handleCall(id, params); return }
  err(id, -32601, `method not found: ${String(method)}`)
})
