// bgjobs —— MCP 连接构造（MCP 引擎；runner 与预热 supervisor 共用）。
// 单一实现点：环境清洗、transport 构造、工具调用/列举、内容投影。
// 说明（实测 SDK 1.30.0，勿凭记忆改）：
//   - SDK 的 StdioClientTransport 用 cross-spawn 启动（Windows 下 npx.cmd 等 PATHEXT
//     解析由 cross-spawn 负责，无需我们自己包 cmd /c），且 spawn 时带 windowsHide:true；
//   - env 语义 = { ...SDK 默认安全变量, ...我们传入的 env }——所以这里传「清洗后的父环境」，
//     用户的 server env 由调用方合并进来；
//   - streamable-http 无 stdio 进程，headers 原样传给请求。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** 敏感环境变量名（与 DSH 的 scrubbedParentEnv 同一口径）。 */
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * 清洗父进程环境：剔除敏感名与 DSH_* 前缀变量，再合并显式 env。
 * 与 packages/subprocess/subprocess 的 scrubbedParentEnv 同规则（本地复刻，不引 harness 依赖）。
 */
export function scrubbedParentEnv(extra) {
  const out = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k.startsWith('DSH_')) continue
    if (SENSITIVE_ENV.test(k)) continue
    out[k] = v
  }
  return Object.assign(out, extra && typeof extra === 'object' ? extra : {})
}

/** 归一化 server 配置（防御：程序直调/导入数据都过这里）。 */
export function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const transport = c.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  if (transport === 'stdio') {
    if (typeof c.command !== 'string' || c.command.trim().length === 0) {
      throw new Error('mcp server config: stdio transport requires a non-empty "command"')
    }
    return {
      transport,
      command: c.command.trim(),
      args: Array.isArray(c.args) ? c.args.map(String) : [],
      env: c.env && typeof c.env === 'object' ? Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, String(v)])) : {},
      ...(typeof c.cwd === 'string' && c.cwd.trim().length > 0 ? { cwd: c.cwd.trim() } : {}),
    }
  }
  if (typeof c.url !== 'string' || c.url.trim().length === 0) {
    throw new Error('mcp server config: streamable-http transport requires a non-empty "url"')
  }
  return {
    transport,
    url: c.url.trim(),
    headers: c.headers && typeof c.headers === 'object' ? Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, String(v)])) : {},
  }
}

/** 构造 SDK transport（stdio 用清洗后的 env；http 用 url+headers）。 */
export function createTransport(config) {
  const c = normalizeConfig(config)
  if (c.transport === 'stdio') {
    return new StdioClientTransport({
      command: c.command,
      args: c.args,
      env: scrubbedParentEnv(c.env),
      ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
      stderr: 'inherit',
    })
  }
  return new StreamableHTTPClientTransport(new URL(c.url), {
    requestInit: { headers: c.headers },
  })
}

/** 建立连接并返回 { client, transport }（调用方负责 close）。 */
export async function openClient(config, identity) {
  const transport = createTransport(config)
  const client = new Client(
    { name: identity && identity.name ? identity.name : 'bgjobs-mcp', version: identity && identity.version ? identity.version : '0.0.0' },
    { capabilities: {} },
  )
  await client.connect(transport)
  return { client, transport }
}

/** tools/list（分页取全）。 */
export async function listTools(client, options) {
  const tools = []
  let cursor
  for (let page = 0; page < 50; page++) {
    const res = await client.listTools(cursor === undefined ? {} : { cursor }, options)
    for (const t of (res && res.tools) || []) tools.push(t)
    cursor = res && res.nextCursor ? res.nextCursor : undefined
    if (cursor === undefined) break
  }
  return tools
}

/**
 * 把 MCP tools/call 结果投影为 { text, isError, content, structuredContent }。
 * text 用于写日志（text 块原文；其它类型 JSON 单行）。
 */
export function projectResult(raw) {
  const content = raw && Array.isArray(raw.content) ? raw.content : []
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else parts.push(JSON.stringify(block))
  }
  return {
    text: parts.join('\n'),
    isError: raw && raw.isError === true,
    content,
    ...(raw && raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
  }
}

/** 调用一个工具（带请求级超时）。 */
export async function callTool(client, tool, args, timeoutMs) {
  const raw = await client.callTool(
    { name: String(tool), arguments: args && typeof args === 'object' ? args : {} },
    undefined,
    timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
  )
  return projectResult(raw)
}
