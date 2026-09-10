// bgjobs client — DSH 设置页 UI 偏好 store（v0.1.65；v0.1.70 起含任务字段显示位置）
// 与宿主 $DSH_HOME/bgjobs/ui-prefs.json 同步：
//   1) 「左侧显隐按钮」开关（缺省 false）——供 settings.section 与 sidebar.footer.action 共享，
//      设置页拨开关 → 左栏入口即时消失/出现（list occupant 保留、空渲染）；
//   2) 「任务字段显示位置」（display：每字段 list/detail/hidden）——供设置页与监控面板共享，
//      改动即时生效并持久化。
const React = require('react')

// 与 host store.js 的 DEFAULT_DISPLAY 一致（host 会下发权威值，此处仅作初始兜底）。
const DEFAULT_DISPLAY = {
  id: 'hidden', name: 'list', status: 'list', exitCode: 'hidden',
  workdir: 'list', command: 'hidden', createdAt: 'hidden', finishedAt: 'hidden',
}
const DISPLAY_VALUES = ['list', 'detail', 'hidden']
// 界面元素显隐（布尔，缺省全显示）。与 host store.js 的 DEFAULT_ELEMENTS 一致。
const DEFAULT_ELEMENTS = { settingsButton: true, onlySession: true, fullAccess: true, groupHeader: true, notify: true }

function createGuiPrefsStore(initialEnabled = false) {
  let enabled = !!initialEnabled
  let display = { ...DEFAULT_DISPLAY }
  let elements = { ...DEFAULT_ELEMENTS }
  let defaultDisplay = { ...DEFAULT_DISPLAY }
  let defaultElements = { ...DEFAULT_ELEMENTS }
  const listeners = new Set()
  const emit = () => { for (const fn of [...listeners]) { try { fn() } catch (e) { /* 忽略订阅者异常 */ } } }

  // ── 左侧显隐开关 ─────────────────────────────────────────────────────────
  const set = (value, persist) => {
    const next = !!value
    if (next !== enabled) { enabled = next; emit() }
    if (!persist) return
    fetch('/bgjobs/uiprefs?sidebarEntry=' + (next ? 1 : 0), { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        // 宿主回显与本地不一致（并发/落盘失败）→ 以回显为准。
        if (d && typeof d.sidebarEntry === 'boolean' && d.sidebarEntry !== enabled) { enabled = d.sidebarEntry; emit() }
      })
      .catch(() => { /* 失败保持本地值；下轮 loadGuiPrefs 回显 */ })
  }

  // ── 任务字段显示位置 ─────────────────────────────────────────────────────
  // 只接受已知字段的合法取值；引用变化才 emit（useSyncExternalStore 要求快照稳定）。
  const applyDisplay = (obj) => {
    if (!obj || typeof obj !== 'object') return
    const next = { ...display }
    let changed = false
    for (const k of Object.keys(DEFAULT_DISPLAY)) {
      if (DISPLAY_VALUES.includes(obj[k]) && obj[k] !== next[k]) { next[k] = obj[k]; changed = true }
    }
    display = next
    if (changed) emit()
  }
  const applyDefaults = (obj) => {
    if (!obj || typeof obj !== 'object') return
    const next = { ...defaultDisplay }
    for (const k of Object.keys(DEFAULT_DISPLAY)) if (DISPLAY_VALUES.includes(obj[k])) next[k] = obj[k]
    defaultDisplay = next
  }
  // 界面元素显隐：apply/get/set（引用变化才 emit）。
  const applyElements = (obj) => {
    if (!obj || typeof obj !== 'object') return
    const next = { ...elements }
    let changed = false
    for (const k of Object.keys(DEFAULT_ELEMENTS)) {
      if (typeof obj[k] === 'boolean' && obj[k] !== next[k]) { next[k] = obj[k]; changed = true }
    }
    elements = next
    if (changed) emit()
  }
  const applyDefaultElements = (obj) => {
    if (!obj || typeof obj !== 'object') return
    const next = { ...defaultElements }
    for (const k of Object.keys(DEFAULT_ELEMENTS)) if (typeof obj[k] === 'boolean') next[k] = obj[k]
    defaultElements = next
  }
  const applyHostPrefs = (d) => {
    if (!d) return
    if (d.display) applyDisplay(d.display)
    if (d.elements) applyElements(d.elements)
    if (d.defaultDisplay) applyDefaults(d.defaultDisplay)
    if (d.defaultElements) applyDefaultElements(d.defaultElements)
  }
  const persistDisplay = (next) => fetch('/bgjobs/uiprefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display: next }),
  })
    .then((r) => r.json())
    .then(applyHostPrefs)
    .catch(() => { /* 失败保持本地值；下轮 loadGuiPrefs 回显 */ })
  const setDisplayField = (key, value) => {
    if (!(key in DEFAULT_DISPLAY) || !DISPLAY_VALUES.includes(value)) return
    const next = { ...display, [key]: value }
    applyDisplay(next)          // 本地即时生效
    persistDisplay(next)        // 异步落盘
  }
  const setElement = (key, visible) => {
    if (!(key in DEFAULT_ELEMENTS)) return
    const next = { ...elements, [key]: !!visible }
    applyElements(next)         // 本地即时生效
    fetch('/bgjobs/uiprefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: next }),
    })
      .then((r) => r.json())
      .then(applyHostPrefs)
      .catch(() => { /* 失败保持本地值 */ })
  }
  const resetDisplay = () => {
    const next = { ...defaultDisplay }
    const nextEl = { ...defaultElements }
    applyDisplay(next)
    applyElements(nextEl)
    fetch('/bgjobs/uiprefs?action=resetDisplay', { method: 'POST' })
      .then((r) => r.json())
      .then(applyHostPrefs)
      .catch(() => { /* 失败保持本地（已恢复默认） */ })
  }

  return {
    getEnabled: () => enabled,
    setEnabled: (next) => set(next, true),
    apply: (next) => set(next, false),
    getDisplay: () => display,
    applyDisplay,
    getDefaultDisplay: () => defaultDisplay,
    applyDefaults,
    getElements: () => elements,
    applyElements,
    getDefaultElements: () => defaultElements,
    applyDefaultElements,
    setDisplayField,
    setElement,
    resetDisplay,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

// 启动时从宿主读一次当前偏好（缺省值兜底）；失败保持 initial。
function loadGuiPrefs(store) {
  fetch('/bgjobs/uiprefs')
    .then((r) => r.json())
    .then((d) => {
      if (!d) return
      if (typeof d.sidebarEntry === 'boolean') store.apply(d.sidebarEntry)
      if (d.display) store.applyDisplay(d.display)
      if (d.elements) store.applyElements(d.elements)
      if (d.defaultDisplay) store.applyDefaults(d.defaultDisplay)
      if (d.defaultElements) store.applyDefaultElements(d.defaultElements)
    })
    .catch(() => { /* 服务不可用：维持缺省 */ })
}

// React hook：订阅左侧显隐开关。store 缺位时恒 false（与宿主缺省一致）。
function useGuiPrefsEnabled(store) {
  const subscribe = React.useCallback((cb) => (store ? store.subscribe(cb) : () => {}), [store])
  const getSnapshot = React.useCallback(() => (store ? store.getEnabled() : false), [store])
  return React.useSyncExternalStore(subscribe, getSnapshot)
}

// React hook：订阅任务字段显示配置。store 缺位时返回 null（调用方回落默认）。
function useGuiPrefsDisplay(store) {
  const subscribe = React.useCallback((cb) => (store ? store.subscribe(cb) : () => {}), [store])
  const getSnapshot = React.useCallback(() => (store ? store.getDisplay() : null), [store])
  return React.useSyncExternalStore(subscribe, getSnapshot)
}

// React hook：订阅界面元素显隐。store 缺位时返回 null（调用方回落默认）。
function useGuiPrefsElements(store) {
  const subscribe = React.useCallback((cb) => (store ? store.subscribe(cb) : () => {}), [store])
  const getSnapshot = React.useCallback(() => (store ? store.getElements() : null), [store])
  return React.useSyncExternalStore(subscribe, getSnapshot)
}

module.exports = { createGuiPrefsStore, loadGuiPrefs, useGuiPrefsEnabled, useGuiPrefsDisplay, useGuiPrefsElements, DEFAULT_DISPLAY, DEFAULT_ELEMENTS }
