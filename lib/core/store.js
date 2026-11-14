// bgjobs core —— 每 apply 一份的可变状态（v0.1.61 结构重构）。
// 规则：凡「每插件实例一份」的可变状态（任务注册表、full access 缓存）都集中在此，
// 严禁放模块级（多 apply/测试间会互相污染）。纯函数模块见 ../*.js。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { resolveBgjobsHome } from '../index-store.js'
import { readGlobalConfig, writeGlobalConfig } from './config-file.js'
import { errorMsg } from '../util.js'

/**
 * 沙箱后端选择开关（默认关）关闭时，请求 `sandbox_backend: 'dsh'` 的统一文案
 * （工具层 execute 与提交层 submitJob 双层校验共用，避免两处漂移）。
 * 关闭时该取值一律拒绝，且**零副作用**：不建 jobDir、不建计划任务、不写盘。
 */
export const DSH_BACKEND_DISABLED_ERROR = 'sandbox_backend=dsh is experimental and disabled; turn on the "sandbox backend selection" switch in the bgjobs settings page'

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
      fullAccessCache = JSON.parse(await fsp.readFile(fullAccessPath(), 'utf8')).enabled !== false
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

  // ── 沙箱后端选择开关（实验；默认开）。关 = 与加本开关之前**逐字相同**的老路径
  //    （沙箱任务一律走内置 ACL runner）；开 = 允许 `sandbox_backend: 'dsh'`，即复用会话的
  //    dsh 沙箱 provider（`ctx.sandbox.confine`，**纯 argv 包装、不 spawn**）在提交期把任务
  //    argv 包装好烘进 run.ps1（任务仍由 schtasks 托管 ⇒ 脱离 DSH 独立运行的性质不变）。
  //    持久化 $DSH_HOME/bgjobs/sandbox-backends.json；无文件/读失败 ⇒ true（v0.3.1 起默认开）。
  //    ★ 不做进程内缓存 —— 面板开关与测试都直接写文件，缓存会造成"改完不生效"；
  //      开关**不影响已在运行**的任务（argv 早已落盘）。
  const sandboxBackendsPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'sandbox-backends.json')
  // v0.3.1：门控默认**开**（dsh 已是默认沙箱后端；ACL 档跑不了 .NET 命名管道/python/git 等真程序）。
  // 写 {enabled:false} 可退回 ACL。
  const readSandboxBackends = async () => {
    try {
      return JSON.parse(await fsp.readFile(sandboxBackendsPath(), 'utf8')).enabled !== false
    } catch (e) { return true }
  }
  const setSandboxBackends = async (enabled) => {
    const value = !!enabled
    try {
      const p = sandboxBackendsPath()
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify({ enabled: value }, null, 2), 'utf8')
    } catch (e) { /* 尽力而为 */ }
    return { ok: true, enabled: value }
  }

  // ── 启动策略开关（spec-launch-strategy.md）：隐藏任务的控制台窗口。
  //    默认**关** ⇒ 任务动作与加本特性前逐字相同（direct，L11），尊重"不改进程形态"的用户。
  //    开 = 经包内 launch.vbs（wscript，GUI 子系统）启动，避免 Windows Terminal 委托下的可见窗口。
  //    持久化 $DSH_HOME/bgjobs/launch.json；无文件/读失败/非 true ⇒ false（fail-safe）。
  //    ★ 与 sandbox-backends 同模式：不做进程内缓存；只影响**新提交**的任务（动作已落盘）。
  const launchHiddenPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'launch.json')
  const readLaunchHidden = async () => {
    try {
      return JSON.parse(await fsp.readFile(launchHiddenPath(), 'utf8')).enabled === true
    } catch (e) { return false }
  }
  const setLaunchHidden = async (enabled) => {
    const value = !!enabled
    try {
      const p = launchHiddenPath()
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify({ enabled: value }, null, 2), 'utf8')
    } catch (e) { /* 尽力而为 */ }
    return { ok: true, enabled: value }
  }

  // ── 网页 UI 偏好（DSH 设置页）：左侧显隐按钮开关 + 任务字段显示位置 + 默认等待超时。持久化
  //    $DSH_HOME/bgjobs/ui-prefs.json；缺省（无文件/旧版升级）为 sidebarEntry=false、
  //    DEFAULT_DISPLAY 与 waitTimeoutSeconds=null（= bgjob_wait 不限时）。语义与 fullaccess（权限）无关，独立文件避免耦合。
  const uiPrefsPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'ui-prefs.json')
  let uiPrefsCache = null
  // 任务字段显示位置：每个字段三态 list（列表）/ detail（展开详情）/ hidden（隐藏）。
  const DISPLAY_FIELDS = ['id', 'name', 'status', 'runtime', 'exitCode', 'workdir', 'command', 'createdAt', 'finishedAt']
  const DISPLAY_VALUES = ['list', 'detail', 'hidden']
  // 默认 = 保持 v0.1.69 之前的外观：名称/状态/任务路径显示在列表，其余隐藏（runtime 为 v0.1.85 新增，默认显示在列表）。
  const DEFAULT_DISPLAY = {
    id: 'hidden', name: 'list', status: 'list', runtime: 'list', exitCode: 'hidden',
    workdir: 'list', command: 'hidden', createdAt: 'hidden', finishedAt: 'hidden',
  }
  // bgjob_wait 的 timeoutSeconds 缺省值（秒）；null = 不限时。正有限数才接受、取整（与 timeoutMs 同口径）。
  const DEFAULT_WAIT_TIMEOUT_SECONDS = null
  const normalizeWaitTimeout = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null)
  // 面板作用域（spec-session-scope.md）：session = 当前会话 / workspace = 当前工作区 / all = 全。
  // 与 elements.onlySession 分工：后者只决定**控件是否显示**，scope 是用户选的**持久化作用域值**；
  // 控件隐藏时 client 的生效值恒为 all（不让用户被静默过滤）。
  const SCOPE_VALUES = ['session', 'workspace', 'all']
  const DEFAULT_SCOPE = 'session'
  const normalizeScope = (v) => (SCOPE_VALUES.includes(v) ? v : DEFAULT_SCOPE)
  // 横幅一次性种子已执行到的版本（0 = 未跑；见 watch.js#seedBannerState）。仅 host 内部使用：
  // 保证「把存量 done 任务补标已弹过」只跑一次，之后新完成的任务才能正常弹（v0.1.88）。
  const DEFAULT_BANNER_SEED_VERSION = 0
  const normalizeSeedVersion = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_BANNER_SEED_VERSION)
  // 界面元素显隐（布尔，缺省全显示，保持升级前外观）：设置入口齿轮、仅当前会话/全权限开关、分组头、待通知。
  // v0.1.88 起含两个「完成横幅」开关（语义是行为开关，复用同一条落盘链路）：
  //   bannerEnabled = 是否检测并弹完成横幅（总开关，关 ⇒ 完全不检测不弹）；
  //   bannerMemo    = 是否把「已弹过」写回 job.json（关 ⇒ 照弹但不记，刷新即重弹 = 无记忆模式）。
  // 另含「面板行为」开关：
  //   followScrollDefault = 监控面板打开时「自动滚动」勾选框的**初始**状态（默认 true）。
  //     只决定初值；用户在面板里手动拨动只影响当前会话、不回写本设置。
  const ELEMENT_KEYS = ['settingsButton', 'onlySession', 'fullAccess', 'sandboxBackends', 'launchHidden', 'groupHeader', 'notify', 'bannerEnabled', 'bannerMemo', 'followScrollDefault']
  const DEFAULT_ELEMENTS = { settingsButton: true, onlySession: true, fullAccess: true, sandboxBackends: true, launchHidden: true, groupHeader: true, notify: true, bannerEnabled: true, bannerMemo: true, followScrollDefault: true }
  // 完成横幅两个**行为开关**：不属于「字段显示 / 界面元素」的显隐配置，故「一键恢复默认」不重置它们。
  const BANNER_KEYS = ['bannerEnabled', 'bannerMemo']
  // 所有**行为开关**（不是显隐项）：BANNER_KEYS 是本表的子集（上面两键 + 面板行为开关）。
  // 「一键恢复默认」只重置显隐元素，不动行为开关。
  const BEHAVIOR_KEYS = [...BANNER_KEYS, 'followScrollDefault']
  const RESET_ELEMENT_KEYS = ELEMENT_KEYS.filter((k) => !BEHAVIOR_KEYS.includes(k))
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
  // 3.4（0.3）：把旧 ui-prefs.json 的 waitTimeoutSeconds 一次性迁移进 config.json.ui.waitTimeout。
  //   - 老文件**只读不写**；config.json 里已有 ui.waitTimeout 则不覆盖；进程内只尝试一次。
  let uiWaitMigrated = false
  const migrateUiWaitTimeout = async (legacy) => {
    if (uiWaitMigrated || legacy === null || legacy === undefined) return
    uiWaitMigrated = true
    try {
      const cur = await readGlobalConfig()
      if (!cur.ok) return
      if (cur.value.ui && typeof cur.value.ui.waitTimeout === 'number') return
      await writeGlobalConfig({ ui: { waitTimeout: legacy } })
    } catch { /* 迁移失败不影响任何行为 */ }
  }
  const readUiPrefs = async () => {
    if (uiPrefsCache !== null) return uiPrefsCache
    let value = { sidebarEntry: false, display: { ...DEFAULT_DISPLAY }, elements: { ...DEFAULT_ELEMENTS }, scope: DEFAULT_SCOPE, waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS, bannerSeedVersion: DEFAULT_BANNER_SEED_VERSION }
    try {
      const parsed = JSON.parse(await fsp.readFile(uiPrefsPath(), 'utf8'))
      // 老文件没有 scope：沿用「元素隐藏 = 不过滤」的旧语义（onlySession === false ⇒ all）。
      const legacyScope = parsed.elements && parsed.elements.onlySession === false ? 'all' : DEFAULT_SCOPE
      value = {
        sidebarEntry: parsed.sidebarEntry === true,
        display: normalizeDisplay(parsed.display),
        elements: normalizeElements(parsed.elements),
        scope: SCOPE_VALUES.includes(parsed.scope) ? parsed.scope : legacyScope,
        waitTimeoutSeconds: normalizeWaitTimeout(parsed.waitTimeoutSeconds),
        bannerSeedVersion: normalizeSeedVersion(parsed.bannerSeedVersion),
      }
    } catch (e) { /* 缺文件/坏文件 → 缺省 */ }
    uiPrefsCache = value
    await migrateUiWaitTimeout(value.waitTimeoutSeconds)
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
      scope: uiPrefsCache.scope,
      waitTimeoutSeconds: uiPrefsCache.waitTimeoutSeconds,
      bannerSeedVersion: uiPrefsCache.bannerSeedVersion,
      defaultDisplay: { ...DEFAULT_DISPLAY },
      defaultElements: { ...DEFAULT_ELEMENTS },
      defaultWaitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
    }
  }
  // patch 里"提供才覆盖"：sidebarEntry / display / elements / scope / waitTimeoutSeconds 各自独立，未提供保持原值。
  const setUiPrefs = async (patch) => {
    const src = patch && typeof patch === 'object' ? patch : {}
    const current = uiPrefsCache !== null
      ? uiPrefsCache
      : { sidebarEntry: false, display: { ...DEFAULT_DISPLAY }, elements: { ...DEFAULT_ELEMENTS }, scope: DEFAULT_SCOPE, waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS, bannerSeedVersion: DEFAULT_BANNER_SEED_VERSION }
    const next = {
      sidebarEntry: current.sidebarEntry,
      display: { ...current.display },
      elements: { ...current.elements },
      scope: normalizeScope(current.scope),
      waitTimeoutSeconds: current.waitTimeoutSeconds === undefined ? DEFAULT_WAIT_TIMEOUT_SECONDS : current.waitTimeoutSeconds,
      bannerSeedVersion: current.bannerSeedVersion === undefined ? DEFAULT_BANNER_SEED_VERSION : current.bannerSeedVersion,
    }
    if ('sidebarEntry' in src) next.sidebarEntry = src.sidebarEntry === true
    if ('display' in src) next.display = mergeDisplay(current.display, src.display)
    if ('elements' in src) next.elements = mergeElements(current.elements, src.elements)
    if ('scope' in src && SCOPE_VALUES.includes(src.scope)) next.scope = src.scope
    if ('waitTimeoutSeconds' in src) next.waitTimeoutSeconds = normalizeWaitTimeout(src.waitTimeoutSeconds)
    if ('bannerSeedVersion' in src) next.bannerSeedVersion = normalizeSeedVersion(src.bannerSeedVersion)
    uiPrefsCache = next
    return await persistUiPrefs()
  }
  // 整份替换（一键恢复默认走 setDisplay(DEFAULT_DISPLAY)）。resetDisplay 重置字段与显隐元素
  // （RESET_ELEMENT_KEYS），「提供才覆盖」的 mergeElements 使未提供的**行为开关**保持现值
  // （不动 bannerEnabled/bannerMemo/followScrollDefault；scope 同属行为设置，也不重置）。
  const setDisplay = async (display) => await setUiPrefs({ display })
  const resetDisplay = async () => {
    const elements = {}
    for (const k of RESET_ELEMENT_KEYS) elements[k] = DEFAULT_ELEMENTS[k]
    return await setUiPrefs({ display: { ...DEFAULT_DISPLAY }, elements })
  }

  // ── 启动就绪标志（v0.1.88）：watch 的 recover() 与一次性种子都跑完才置 true，
  //    /bgjobs/state 出参 ready 供 client 首轮跳过横幅判定——否则空列表基线会把
  //    存量 done 任务全判成"新完成"（横幅重复弹出的直接成因）。
  let ready = false
  const setReady = (v) => { ready = v === true }
  const isReady = () => ready

  return {
    registry, readFullAccess, setFullAccess, readSandboxBackends, setSandboxBackends, readLaunchHidden, setLaunchHidden, readUiPrefs, setUiPrefs, setDisplay, resetDisplay, DEFAULT_DISPLAY, DEFAULT_ELEMENTS, DEFAULT_WAIT_TIMEOUT_SECONDS,
    setReady, isReady,
  }
}
