// bgjobs —— DSH profile 定位与 MCP 配置导入（MCP 引擎 §6b）。
// 目的：把用户已在 DSH 里配好的 `@deepseek-ai/dsh-mcp-client` 条目一键导入成 bgjobs 的
// server 登记，并且**在任意 profile 下都指向当前运行的那个 profile**——参考插件
// @xxxyz/dsh-mcp-manager 2.2.7 的探测是「先 web 再 headless 再任意」，在 r4 下会展示
// 错 profile（用户实测），本模块不复制该缺陷。
// 安全：只读 DSH 配置、不 eval 任何表达式（`!!js` 等非标准 tag 记为 needsAttention）。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { resolveBgjobsHome } from './index-store.js'

/** DSH 侧 MCP 客户端插件名（配置文件里 name 字段）。 */
export const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'
/** `!!js` 表达式占位符：解析前替换掉，避免 eval，也避免 yaml 库因未知 tag 抛错。 */
const JS_TAG_PLACEHOLDER = '__BGJOBS_JS_EXPRESSION__'
const PROFILE_PATCH_FILE = 'cordis.patch.yml'
const GLOBAL_PATCH_FILE = 'cordis.patch.yml'

/** 本插件名（用于 realpath 比对判定活动 profile）。 */
const SELF_PLUGIN_NAME = 'bgjobs'

const errMsg = (e) => (e && e.message ? String(e.message) : String(e))

async function safeRealpath(p) {
  try { return await fsp.realpath(p) } catch { return null }
}

async function exists(p) {
  try { await fsp.stat(p); return true } catch { return false }
}

/** 从命令行参数解析 `--profile <name>` / `--profile=<name>`。 */
export function profileFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : []
  for (let i = 0; i < list.length; i++) {
    const item = String(list[i])
    if (item === '--profile') {
      const next = list[i + 1]
      if (next !== undefined && String(next).length > 0 && !String(next).startsWith('--')) return String(next)
      continue
    }
    const m = /^--profile=(.+)$/.exec(item)
    if (m) return m[1]
  }
  return null
}

/** 列出 $DSH_HOME/profiles 下的 profile 目录（以存在 cordis.yml 或 package.json 的 dsh.profile 为准）。 */
export async function listProfiles(home = resolveBgjobsHome()) {
  const root = path.join(home, 'profiles')
  let entries = []
  try { entries = await fsp.readdir(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (name === 'node_modules' || name.startsWith('.') || name.startsWith('dsh-update-checker')) continue
    const dir = path.join(root, name)
    if (await exists(path.join(dir, 'cordis.yml'))) { out.push({ name, dir }); continue }
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
      if (pkg && pkg.dsh && pkg.dsh.profile) out.push({ name, dir })
    } catch { /* 非 profile 目录 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 判定当前运行实例所属 profile。三级判定 + 结果带 detectedBy（设置页要显示依据）：
 *   1. argv 的 `--profile <name>`（dsh --profile r4 启动的常态路径）
 *   2. realpath 比对：plugins 包根（modulePath 为 <root>/lib/<本文件> → 上溯两级）的
 *      realpath == `profiles/<n>/node_modules/<本插件>` 的 realpath。兼容 `link:` 安装
 *      （此时模块 realpath 落在源码目录）与 pnpm 软链安装（候选路径 realpath 落在 .pnpm 目录）。
 *   3. 只有一个 profile 目录 → 用它
 *   4. 仍无法确定 → { name: null, candidates, reason }（**绝不安置为 web**）
 */
export async function detectActiveProfile(options = {}) {
  const home = options.home !== undefined ? options.home : resolveBgjobsHome()
  const argv = options.argv !== undefined ? options.argv : process.argv
  const modulePath = options.modulePath !== undefined ? options.modulePath : fileURLToPath(import.meta.url)
  const pluginName = options.pluginName !== undefined ? options.pluginName : SELF_PLUGIN_NAME
  const profiles = await listProfiles(home)

  const fromArgv = profileFromArgv(argv)
  if (fromArgv !== null) {
    const hit = profiles.find((p) => p.name === fromArgv)
    if (hit !== undefined) return { name: hit.name, dir: hit.dir, detectedBy: 'argv', profiles }
    // argv 指定但目录不存在（例如 profile 尚未创建）→ 继续用其它信号，但记录原因
  }

  const selfFile = await safeRealpath(modulePath)
  // 本插件包根：<root>/lib/<file> → 上溯两级（候选路径是包根目录，须与包根比对，不是文件）。
  const selfRoot = selfFile === null ? null : await safeRealpath(path.dirname(path.dirname(selfFile)))
  if (selfRoot !== null) {
    const matched = []
    for (const p of profiles) {
      const candidate = await safeRealpath(path.join(p.dir, 'node_modules', pluginName))
      if (candidate !== null && candidate === selfRoot) matched.push(p)
    }
    if (matched.length === 1) return { name: matched[0].name, dir: matched[0].dir, detectedBy: 'module-path', profiles }
    if (matched.length > 1) {
      return { name: null, dir: null, detectedBy: 'ambiguous', candidates: matched.map((p) => p.name), reason: '多个 profile 都安装了同一份插件（link 安装），无法自动判定', profiles }
    }
  }

  if (profiles.length === 1) return { name: profiles[0].name, dir: profiles[0].dir, detectedBy: 'single-profile', profiles }

  return {
    name: null, dir: null, detectedBy: 'unknown',
    candidates: profiles.map((p) => p.name),
    reason: fromArgv === null ? '命令行未给出 --profile，且无法从模块路径判定' : '命令行指定的 profile 不存在',
    profiles,
  }
}

/** 解析 patch 文本：`!!js` 先替换为占位符（不 eval），未知 tag 不抛错。 */
function parsePatchText(text) {
  const hasJsTag = /!!js\b/.test(text)
  const prepared = hasJsTag ? text.replace(/!!js\s+(?:'([^']*)'|"([^"]*)")/g, "'" + JS_TAG_PLACEHOLDER + "'") : text
  try {
    return { data: YAML.parse(prepared), hasJsTag }
  } catch (e) {
    return { error: errMsg(e), hasJsTag }
  }
}

const containsPlaceholder = (value) => {
  try { return JSON.stringify(value === undefined ? null : value).includes(JS_TAG_PLACEHOLDER) } catch { return false }
}

function toServerRow(row, outer) {
  const config = row && row.config && typeof row.config === 'object' ? row.config : {}
  const transport = config.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const enabled = !(row && row.disabled === true) && !(outer && outer.disabled === true)
  const needsAttention = containsPlaceholder(config)
  const row2 = {
    id: row && row.id !== undefined ? String(row.id) : '',
    serverName: String(config.serverName !== undefined ? config.serverName : (row && row.id !== undefined ? row.id : '')),
    transport,
    enabled,
    needsAttention,
    ...(needsAttention ? { attentionReason: '含 !!js 表达式（不会求值，导入后需在设置页手动填写 env/headers）' } : {}),
    config: {
      transport,
      ...(transport === 'stdio'
        ? {
            ...(config.command !== undefined ? { command: String(config.command) } : {}),
            ...(Array.isArray(config.args) ? { args: config.args.map(String) } : {}),
            ...(config.env !== undefined ? { env: config.env } : {}),
            ...(config.cwd !== undefined ? { cwd: String(config.cwd) } : {}),
          }
        : {
            ...(config.url !== undefined ? { url: String(config.url) } : {}),
            ...(config.headers !== undefined ? { headers: config.headers } : {}),
          }),
      ...(config.toolCallTimeoutMs !== undefined ? { timeoutMs: Number(config.toolCallTimeoutMs) || undefined } : {}),
    },
  }
  if (row2.serverName.length === 0) row2.needsAttention = true
  if (row2.transport === 'stdio' && typeof row2.config.command !== 'string') row2.needsAttention = true
  if (row2.transport === 'streamable-http' && typeof row2.config.url !== 'string') row2.needsAttention = true
  return row2
}

/** 从已解析的 patch 数据里抽出 MCP server 行（支持 `- insert: [...]` 与顶层直接条目两种写法）。 */
export function extractMcpServers(data) {
  const out = []
  const rows = Array.isArray(data) ? data : []
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue
    const nested = Array.isArray(entry.insert) ? entry.insert : []
    let matched = false
    for (const row of nested) {
      if (row && typeof row === 'object' && row.name === MCP_CLIENT_PLUGIN) { out.push(toServerRow(row, entry)); matched = true }
    }
    if (!matched && entry.name === MCP_CLIENT_PLUGIN) out.push(toServerRow(entry, undefined))
  }
  return out
}

/**
 * 读取某个 scope 的 MCP 配置。
 * scope：'active'（活动 profile 的 patch）| 'global'（$DSH_HOME/cordis.patch.yml）| 具体 profile 名。
 * 返回 { scope, path, exists, servers, parseError?, hasJsTag }（文件缺失 → exists:false, servers:[]）。
 */
export async function readMcpConfigs(scope, options = {}) {
  const home = options.home !== undefined ? options.home : resolveBgjobsHome()
  let file = ''
  let label = ''
  if (scope === 'global') {
    file = path.join(home, GLOBAL_PATCH_FILE)
    label = 'global'
  } else if (scope === 'active') {
    const active = options.activeProfile !== undefined ? options.activeProfile : await detectActiveProfile(options)
    if (!active || active.name === null) {
      return { scope: 'active', path: '', exists: false, servers: [], unavailable: active && active.reason ? active.reason : 'active profile unknown' }
    }
    file = path.join(active.dir, PROFILE_PATCH_FILE)
    label = active.name
  } else {
    file = path.join(home, 'profiles', String(scope), PROFILE_PATCH_FILE)
    label = String(scope)
  }
  if (!(await exists(file))) return { scope: label, path: file, exists: false, servers: [] }
  let text = ''
  try { text = await fsp.readFile(file, 'utf8') } catch (e) {
    return { scope: label, path: file, exists: true, servers: [], parseError: errMsg(e) }
  }
  const parsed = parsePatchText(text)
  if (parsed.error !== undefined) return { scope: label, path: file, exists: true, servers: [], parseError: parsed.error, hasJsTag: parsed.hasJsTag === true }
  return { scope: label, path: file, exists: true, servers: extractMcpServers(parsed.data), hasJsTag: parsed.hasJsTag === true }
}

/** 汇总：活动 profile + 全部 profile + 各 scope 的 server（供 GET /bgjobs/dsh-mcp）。 */
export async function describeDshMcp(options = {}) {
  const home = options.home !== undefined ? options.home : resolveBgjobsHome()
  const active = await detectActiveProfile(options)
  const scopes = []
  const globalCfg = await readMcpConfigs('global', { ...options, home })
  scopes.push(globalCfg)
  if (active.name !== null) {
    const activeCfg = await readMcpConfigs('active', { ...options, home, activeProfile: active })
    scopes.push(activeCfg)
  }
  if (options.includeOthers === true) {
    for (const p of active.profiles || []) {
      if (p.name === active.name) continue
      scopes.push(await readMcpConfigs(p.name, { ...options, home }))
    }
  }
  return {
    activeProfile: active.name,
    detectedBy: active.detectedBy,
    ...(active.reason !== undefined ? { reason: active.reason } : {}),
    ...(active.candidates !== undefined ? { candidates: active.candidates } : {}),
    profiles: (active.profiles || []).map((p) => p.name),
    scopes,
  }
}
