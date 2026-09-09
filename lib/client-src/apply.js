// bgjobs client — plugin apply assembly (v0.1.61)
const h = require('react').createElement
const { makeT, NS, ZH, EN } = require('./i18n.js')
const { Panel } = require('./panel.js')
const { BgjobsSidebarAction } = require('./sidebar-action.js')
const { SettingsSection } = require('./settings-section.js')
const { createMonitorStore } = require('./monitor.js')
const { createGuiPrefsStore, loadGuiPrefs } = require('./gui-prefs.js')

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 客户端 sessions 服务：暴露 active 会话（SessionSummary.cwd 即工作区路径），
      // 供"仅显示当前会话工作区"过滤与自动切换；不可用时 Panel 退化为显示全部。
      let sessions = undefined
      try { sessions = ctx.get('sessions') } catch (e) { /* 服务不可用 */ }
      // 惰性重取：sessions 可能晚于本模块激活（cordis 服务 provide 有先后）——apply 时拿到
      // undefined 不代表永不可用。此函数每次经同一宿主 ctx 注册表重取，供 Panel 每轮轮询
      // 重新解析并重订阅（服务一旦注册，后续 get 即可取到运行中实例）。
      const getSessions = () => {
        try { return ctx.get('sessions') } catch (e) { return undefined }
      }
      // 注册命名空间字典（zh/en）。locale 服务缺失（如未组合 dsh-client-locale 的最小宿主）
      // 时跳过注册、也不声明 locale seat——Panel 用内置中文兜底，不白屏。
      let locale = undefined
      try { locale = ctx.get('locale') } catch (e) { /* 服务不可用 */ }
      if (locale && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'bgjobs: dictionaries')
      }
      // 面板显隐共享 store（apply 级单例，跨 occupant 同 scope）：
      // shell.overlay 面板与 sidebar.footer.action 入口共用，点击入口整体隐藏/恢复面板。
      const monitor = createMonitorStore(true)
      const entry = { name: 'shell.overlay', id: 'bgjobs-monitor', order: 50, label: 'bgjobs' }
      // 声明 locale seat：渲染器注入 t prop，且语言切换时（revision 变化）自动重渲染。
      if (locale) entry.locale = NS
      slots.inject('shell.overlay', () => slots.register(entry, (props) => h(Panel, {
        sessions: sessions,
        getSessions,
        t: (props && props.t) || makeT('zh'),
        monitor,
      })))
      // 左侧栏脚部入口（best-effort，ui-cordis 同款）：seat 由 ui-sidebar 声明；
      // 宿主组合没有 ui-sidebar 时该 inject 静默等待、永不注册 → 面板照常、boot 不失败。
      // v0.1.65 起显隐受 DSH 设置偏好控制（ui-prefs，缺省 false → 入口默认隐藏）。
      const guiPrefs = createGuiPrefsStore(false)
      loadGuiPrefs(guiPrefs) // fire-and-forget：异步回读宿主持久化偏好
      const footerEntry = { name: 'sidebar.footer.action', id: 'bgjobs-monitor-toggle', order: 60, label: 'bgjobs' }
      if (locale) footerEntry.locale = NS
      slots.inject('sidebar.footer.action', () => slots.register(footerEntry, (props) => h(BgjobsSidebarAction, {
        wide: !!(props && props.wide),
        monitor,
        prefs: guiPrefs,
        t: (props && props.t) || makeT('zh'),
      })))
      // DSH 设置面板「后台任务」section（best-effort）：seat 由 ui-settings-general 的
      // sidebar.settings occupant 声明；无设置面板的组合静默等待 → 不回归。
      const bindNavT = () => {
        if (locale && typeof locale.bind === 'function') {
          try { return locale.bind(NS) } catch (e) { /* 回退 zh */ }
        }
        return makeT('zh')
      }
      const settingsEntry = { name: 'settings.section', id: 'bgjobs', order: 30, label: () => bindNavT()('settings.nav') }
      if (locale) settingsEntry.locale = NS
      slots.inject('settings.section', () => slots.register(settingsEntry, (props) => h(SettingsSection, {
        guiPrefs,
        t: (props && props.t) || makeT('zh'),
      })))
    }
module.exports = { apply }
