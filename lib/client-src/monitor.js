// bgjobs client — 面板显隐共享 store（v0.1.64）
// apply 级单例：shell.overlay 面板与左侧栏 footer 动作入口共享同一可见性。
// getSnapshot/subscribe 对齐 React.useSyncExternalStore 契约；monitor 缺位
// （最小宿主 / 未注册入口的旧组合）时可见性恒为 true，行为与旧版一致。
const React = require('react')

function createMonitorStore(initialVisible = true) {
  let visible = !!initialVisible
  const listeners = new Set()
  const emit = () => { for (const fn of [...listeners]) { try { fn() } catch (e) { /* 忽略订阅者异常 */ } } }
  return {
    getVisible: () => visible,
    setVisible: (v) => {
      const next = !!v
      if (next === visible) return
      visible = next
      emit()
    },
    toggle: () => { visible = !visible; emit() },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

// React hook：订阅 store 的可见性。monitor 未提供时恒 true（不白屏、不崩）。
function useMonitorVisible(monitor) {
  const subscribe = React.useCallback((cb) => (monitor ? monitor.subscribe(cb) : () => {}), [monitor])
  const getSnapshot = React.useCallback(() => (monitor ? monitor.getVisible() : true), [monitor])
  return React.useSyncExternalStore(subscribe, getSnapshot)
}

module.exports = { createMonitorStore, useMonitorVisible }
