// bgjobs core —— 每 apply 一份的可变状态（v0.1.61 结构重构）。
// 规则：凡「每插件实例一份」的可变状态（任务注册表、full access 缓存）都集中在此，
// 严禁放模块级（多 apply/测试间会互相污染）。纯函数模块见 ../*.js。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { resolveBgjobsHome } from '../index-store.js'

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

  return { registry, readFullAccess, setFullAccess, readUiPrefs, setUiPrefs, setDisplay, resetDisplay, DEFAULT_DISPLAY, DEFAULT_ELEMENTS }
}
