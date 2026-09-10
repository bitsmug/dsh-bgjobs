// bgjobs core —— 每 apply 一份的可变状态（v0.1.61 结构重构）。
// 规则：凡「每插件实例一份」的可变状态（任务注册表、full access 缓存）都集中在此，
// 严禁放模块级（多 apply/测试间会互相污染）。纯函数模块见 ../*.js。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { resolveBgjobsHome } from '../index-store.js'
import { errorMsg } from '../util.js'
import { normalizeConfig } from '../mcp-connect.js'

/**
 * MCP 任务总开关关闭时的统一文案（工具层 execute 与提交层 submitJob 双层校验共用，
 * 避免两处漂移）。关闭时 `bgjob_submit_mcp` 一律拒绝提交并指引去设置页开启。
 */
export const MCP_DISABLED_ERROR = 'MCP jobs are disabled; turn on the "MCP jobs" switch in the bgjobs settings page'

/**
 * 单个 server 被设为「禁用」时的统一文案（resolveServer 抛错，两个 MCP 工具共用）。
 * 与 MCP_DISABLED_ERROR 区分：后者是总开关关闭，前者只针对这一个 server。
 */
export const mcpServerDisabledError = (name) =>
  'MCP server "' + name + '" is disabled; set it to "Cold start" or "Pre-warm" in the bgjobs MCP settings page'

/** 创建本 apply 实例持有的状态：registry（任务内存注册表）+ full access 持久化开关。 */
export function createStore() {
  const registry = new Map()

  // ── full access 开关（web 面板 toggle；默认关）。ON = 用户预批准"全权限后台任务"，
  //    受限会话里宽请求（含 bat 引擎默认的全权限）不再逐次弹审批。持久化
  //    $DSH_HOME/bgjobs/fullaccess.json；仅 sandboxPolicy 挂载（会话受限）时才有意义。
  const fullAccessPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'fullaccess.json')
  let fullAccessCache = null
  const readFullAccess = async () => {
    if (fullAccessCache !== null) return fullAccessCache
    try {
      fullAccessCache = JSON.parse(await fsp.readFile(fullAccessPath(), 'utf8')).enabled === true
    } catch (e) { fullAccessCache = false }
    return fullAccessCache
  }
  const setFullAccess = async (enabled) => {
    fullAccessCache = !!enabled
    try {
      const p = fullAccessPath()
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify({ enabled: fullAccessCache }, null, 2), 'utf8')
    } catch (e) { /* 尽力而为 */ }
    return { ok: true, enabled: fullAccessCache }
  }

  // ── 网页 UI 偏好（DSH 设置页）：左侧显隐按钮开关 + 任务字段显示位置。持久化
  //    $DSH_HOME/bgjobs/ui-prefs.json；缺省（无文件/旧版升级）为 sidebarEntry=false
  //    与 DEFAULT_DISPLAY。语义与 fullaccess（权限）无关，独立文件避免耦合。
  const uiPrefsPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'ui-prefs.json')
  let uiPrefsCache = null
  // 任务字段显示位置：每个字段三态 list（列表）/ detail（展开详情）/ hidden（隐藏）。
  const DISPLAY_FIELDS = ['id', 'name', 'status', 'exitCode', 'workdir', 'command', 'createdAt', 'finishedAt']
  const DISPLAY_VALUES = ['list', 'detail', 'hidden']
  // 默认 = 保持 v0.1.69 之前的外观：名称/状态/任务路径显示在列表，其余隐藏。
  const DEFAULT_DISPLAY = {
    id: 'hidden', name: 'list', status: 'list', exitCode: 'hidden',
    workdir: 'list', command: 'hidden', createdAt: 'hidden', finishedAt: 'hidden',
  }
  // 界面元素显隐（布尔，缺省全显示，保持升级前外观）：设置入口齿轮、仅当前会话/全权限开关、分组头、待通知。
  const ELEMENT_KEYS = ['settingsButton', 'onlySession', 'fullAccess', 'groupHeader', 'notify']
  const DEFAULT_ELEMENTS = { settingsButton: true, onlySession: true, fullAccess: true, groupHeader: true, notify: true }
  // 只取已知字段；值非法/缺失 → 该字段回落默认（防旧文件/前端脏数据）。
  const normalizeDisplay = (raw) => {
    const src = raw && typeof raw === 'object' ? raw : {}
    const out = {}
    for (const f of DISPLAY_FIELDS) {
      out[f] = DISPLAY_VALUES.includes(src[f]) ? src[f] : DEFAULT_DISPLAY[f]
    }
    return out
  }
  const normalizeElements = (raw) => {
    const src = raw && typeof raw === 'object' ? raw : {}
    const out = {}
    for (const k of ELEMENT_KEYS) out[k] = typeof src[k] === 'boolean' ? src[k] : DEFAULT_ELEMENTS[k]
    return out
  }
  // 局部合并（patch 语义）：只覆盖 patch 提供的合法键，其余保持 base 现值。
  const mergeDisplay = (base, patch) => {
    const out = { ...base }
    const src = patch && typeof patch === 'object' ? patch : {}
    for (const f of DISPLAY_FIELDS) if (DISPLAY_VALUES.includes(src[f])) out[f] = src[f]
    return out
  }
  const mergeElements = (base, patch) => {
    const out = { ...base }
    const src = patch && typeof patch === 'object' ? patch : {}
    for (const k of ELEMENT_KEYS) if (typeof src[k] === 'boolean') out[k] = src[k]
    return out
  }
  const readUiPrefs = async () => {
    if (uiPrefsCache !== null) return uiPrefsCache
    let value = { sidebarEntry: false, display: { ...DEFAULT_DISPLAY }, elements: { ...DEFAULT_ELEMENTS } }
    try {
      const parsed = JSON.parse(await fsp.readFile(uiPrefsPath(), 'utf8'))
      value = {
        sidebarEntry: parsed.sidebarEntry === true,
        display: normalizeDisplay(parsed.display),
        elements: normalizeElements(parsed.elements),
      }
    } catch (e) { /* 缺文件/坏文件 → 缺省 */ }
    uiPrefsCache = value
    return uiPrefsCache
  }
  const persistUiPrefs = async () => {
    try {
      const p = uiPrefsPath()
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify(uiPrefsCache, null, 2), 'utf8')
    } catch (e) { /* 尽力而为 */ }
    return {
      ok: true,
      sidebarEntry: uiPrefsCache.sidebarEntry,
      display: { ...uiPrefsCache.display },
      elements: { ...uiPrefsCache.elements },
      defaultDisplay: { ...DEFAULT_DISPLAY },
      defaultElements: { ...DEFAULT_ELEMENTS },
    }
  }
  // patch 里"提供才覆盖"：sidebarEntry / display / elements 各自独立，未提供保持原值。
  const setUiPrefs = async (patch) => {
    const src = patch && typeof patch === 'object' ? patch : {}
    const current = uiPrefsCache !== null
      ? uiPrefsCache
      : { sidebarEntry: false, display: { ...DEFAULT_DISPLAY }, elements: { ...DEFAULT_ELEMENTS } }
    const next = {
      sidebarEntry: current.sidebarEntry,
      display: { ...current.display },
      elements: { ...current.elements },
    }
    if ('sidebarEntry' in src) next.sidebarEntry = src.sidebarEntry === true
    if ('display' in src) next.display = mergeDisplay(current.display, src.display)
    if ('elements' in src) next.elements = mergeElements(current.elements, src.elements)
    uiPrefsCache = next
    return await persistUiPrefs()
  }
  // 整份替换（一键恢复默认走 setDisplay(DEFAULT_DISPLAY)）。resetDisplay 同时重置字段与元素。
  const setDisplay = async (display) => await setUiPrefs({ display })
  const resetDisplay = async () => await setUiPrefs({ display: { ...DEFAULT_DISPLAY }, elements: { ...DEFAULT_ELEMENTS } })

  // ── MCP 任务总开关（设置页；**默认关闭**）。持久化 $DSH_HOME/bgjobs/mcp-prefs.json。
  //    只控制「提交」（bgjob_submit_mcp / bgjob_mcp_tools），不隐藏 server 登记区，
  //    也不影响已提交/运行中的 MCP 任务；即时生效（工具常驻注册 + 运行时校验）。
  const mcpPrefsPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'mcp-prefs.json')
  let mcpPrefsCache = null
  let mcpPrefsInflight = null
  // 懒读单飞 + 读回填不覆盖期间写入：并发读共享同一次文件读，且若读回填时缓存已被
  // setMcpPrefs 写入（开关可能就在这几个 tick 内被用户点开），保留写入值（否则丢写入）。
  const readMcpPrefs = async () => {
    if (mcpPrefsCache !== null) return mcpPrefsCache
    if (mcpPrefsInflight === null) {
      mcpPrefsInflight = fsp.readFile(mcpPrefsPath(), 'utf8')
        .then((text) => ({ enabled: JSON.parse(text).enabled === true }))
        .catch(() => ({ enabled: false }))
    }
    const loaded = await mcpPrefsInflight
    mcpPrefsInflight = null
    if (mcpPrefsCache === null) mcpPrefsCache = loaded
    return mcpPrefsCache
  }
  const setMcpPrefs = async (patch) => {
    const current = await readMcpPrefs()
    const src = patch && typeof patch === 'object' ? patch : {}
    mcpPrefsCache = { enabled: 'enabled' in src ? src.enabled === true : current.enabled }
    try {
      const p = mcpPrefsPath()
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify(mcpPrefsCache, null, 2), 'utf8')
    } catch (e) { /* 尽力而为 */ }
    return { ok: true, enabled: mcpPrefsCache.enabled }
  }

  // ── MCP server 登记清单（bgjobs 自维护；DSH 侧配置经 dsh-profiles.js 一次性导入）。
  //    持久化 $DSH_HOME/bgjobs/mcp-servers.json = { servers: { <name>: <config> } }；
  //    config = normalizeConfig 结果（stdio: command/args/env/cwd；http: url/headers）
  //    + 可选 timeoutMs + prewarm（每 server 预热开关，缺省 false）
  //    + enabled（每 server 启用/禁用，缺省 true）。
  //    写入时用 normalizeConfig 校验（fail loud，前端能立刻看到原因）。
  const mcpServersPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'mcp-servers.json')
  let mcpServersCache = null
  let mcpServersInflight = null
  const normalizeServerConfig = (raw, fallback) => {
    const base = normalizeConfig(raw)
    const out = { ...base }
    const fb = fallback && typeof fallback === 'object' ? fallback : {}
    if (raw && typeof raw === 'object') {
      if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) out.timeoutMs = Math.floor(raw.timeoutMs)
      if (typeof raw.prewarm === 'boolean') out.prewarm = raw.prewarm
      if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    }
    if (typeof out.prewarm !== 'boolean') out.prewarm = typeof fb.prewarm === 'boolean' ? fb.prewarm : false
    if (typeof out.enabled !== 'boolean') out.enabled = typeof fb.enabled === 'boolean' ? fb.enabled : true
    return out
  }
  const readMcpServers = async () => {
    if (mcpServersCache !== null) return mcpServersCache
    // 同 readMcpPrefs：懒读单飞 + 读回填不覆盖期间写入（登记/删除可能就在读的这几个 tick 内发生）。
    if (mcpServersInflight === null) {
      mcpServersInflight = fsp.readFile(mcpServersPath(), 'utf8')
        .then((text) => {
          const parsed = JSON.parse(text)
          return parsed && parsed.servers && typeof parsed.servers === 'object' ? { servers: parsed.servers } : { servers: {} }
        })
        .catch(() => ({ servers: {} }))
    }
    const loaded = await mcpServersInflight
    mcpServersInflight = null
    if (mcpServersCache === null) mcpServersCache = loaded
    return mcpServersCache
  }
  const persistMcpServers = async () => {
    try {
      const p = mcpServersPath()
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify({ servers: mcpServersCache.servers }, null, 2), 'utf8')
    } catch (e) { /* 尽力而为 */ }
    return { ok: true, servers: mcpServersCache.servers }
  }
  /** 新增/覆盖一个 server（同名覆盖；未显式给 prewarm/enabled 时保留原值）。 */
  const setMcpServer = async (name, config) => {
    const key = String(name === undefined || name === null ? '' : name).trim()
    if (key.length === 0) return { ok: false, error: 'missing server name' }
    const current = await readMcpServers()
    const existing = current.servers[key]
    let normalized
    try {
      normalized = normalizeServerConfig(config, existing ? { prewarm: existing.prewarm, enabled: existing.enabled } : {})
    } catch (e) {
      return { ok: false, error: errorMsg(e) }
    }
    mcpServersCache = { servers: { ...current.servers, [key]: normalized } }
    return await persistMcpServers()
  }
  const deleteMcpServer = async (name) => {
    const key = String(name === undefined || name === null ? '' : name).trim()
    const current = await readMcpServers()
    if (current.servers[key] === undefined) return { ok: false, error: 'server not found: ' + key }
    const servers = { ...current.servers }
    delete servers[key]
    mcpServersCache = { servers }
    return await persistMcpServers()
  }
  /** 切换某 server 的启用/预热状态（只改 patch 里出现的键）；server 未登记 → fail loud。 */
  const setMcpServerState = async (name, patch) => {
    const key = String(name === undefined || name === null ? '' : name).trim()
    const current = await readMcpServers()
    const existing = current.servers[key]
    if (existing === undefined) return { ok: false, error: 'server not found: ' + key }
    const src = patch && typeof patch === 'object' ? patch : {}
    const next = { ...existing }
    if ('prewarm' in src) next.prewarm = src.prewarm === true
    if ('enabled' in src) next.enabled = src.enabled === true
    if (typeof next.prewarm !== 'boolean') next.prewarm = false
    if (typeof next.enabled !== 'boolean') next.enabled = true
    mcpServersCache = { servers: { ...current.servers, [key]: next } }
    return await persistMcpServers()
  }

  return {
    registry, readFullAccess, setFullAccess, readUiPrefs, setUiPrefs, setDisplay, resetDisplay, DEFAULT_DISPLAY, DEFAULT_ELEMENTS,
    readMcpPrefs, setMcpPrefs, readMcpServers, setMcpServer, deleteMcpServer, setMcpServerState,
  }
}
