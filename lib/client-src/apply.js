// bgjobs client — plugin apply assembly (v0.1.61)
const h = require('react').createElement
const { makeT, NS, ZH, EN } = require('./i18n.js')
const { Panel } = require('./panel.js')

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
      const entry = { name: 'shell.overlay', id: 'bgjobs-monitor', order: 50, label: 'bgjobs' }
      // 声明 locale seat：渲染器注入 t prop，且语言切换时（revision 变化）自动重渲染。
      if (locale) entry.locale = NS
      slots.inject('shell.overlay', () => slots.register(entry, (props) => h(Panel, {
        sessions: sessions,
        getSessions,
        t: (props && props.t) || makeT('zh'),
      })))
    }
module.exports = { apply }
