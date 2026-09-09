// bgjobs client — DSH 设置页 UI 偏好 store（v0.1.65）
// 与宿主 $DSH_HOME/bgjobs/ui-prefs.json 同步；当前唯一偏好 = 「左侧显隐按钮」开关
// （缺省 false）。供 settings.section 与 sidebar.footer.action 两 occupant 共享：
// 设置页拨开关 → 左栏入口即时消失/出现（list occupant 保留、空渲染）。
const React = require('react')

function createGuiPrefsStore(initialEnabled = false) {
  let enabled = !!initialEnabled
  const listeners = new Set()
  const emit = () => { for (const fn of [...listeners]) { try { fn() } catch (e) { /* 忽略订阅者异常 */ } } }
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
  return {
    getEnabled: () => enabled,
    setEnabled: (next) => set(next, true),
    apply: (next) => set(next, false),
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

// 启动时从宿主读一次当前偏好（缺省 false）；失败保持 initial。
function loadGuiPrefs(store) {
  fetch('/bgjobs/uiprefs')
    .then((r) => r.json())
    .then((d) => { if (d && typeof d.sidebarEntry === 'boolean') store.apply(d.sidebarEntry) })
    .catch(() => { /* 服务不可用：维持缺省 */ })
}

// React hook：订阅偏好开关。store 缺位时恒 false（与宿主缺省一致）。
function useGuiPrefsEnabled(store) {
  const subscribe = React.useCallback((cb) => (store ? store.subscribe(cb) : () => {}), [store])
  const getSnapshot = React.useCallback(() => (store ? store.getEnabled() : false), [store])
  return React.useSyncExternalStore(subscribe, getSnapshot)
}

module.exports = { createGuiPrefsStore, loadGuiPrefs, useGuiPrefsEnabled }
