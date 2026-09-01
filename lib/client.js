// bgjobs client bundle —— 网页「后台任务监控」浮动面板
// 由 client-modules 经 package.json 的 dsh.client 声明加载；
// 数据通过 fetch 轮询宿主侧 webServer 前缀路由 /bgjobs/state。
// 样式跟随 dsh 主题：颜色全部用 --dsw-* token（ui-theme design-platform.css
// 定义的全局变量，随明暗主题自动切换）；面板可拖拽移动（标题栏 pointer 拖拽）。
window.__ModuleLoader__.load({
  id: 'bgjobs',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    // 状态徽章：running → 品牌色，成功 → success，失败 → error（主题 token）。
    const stateColor = (job) => {
      if (job.status === 'running') return 'var(--dsw-alias-state-business-primary)'
      if (job.status === 'done' && job.exitCode === 0) return 'var(--dsw-alias-state-success-primary)'
      return 'var(--dsw-alias-state-error-primary)'
    }
    const stateLabel = (job) => {
      if (job.status === 'running') return '● 运行中'
      if (job.status === 'done' && job.exitCode === 0) return '✓ 已结束'
      return '✗ 退出 ' + String(job.exitCode)
    }

    function Panel() {
      const [jobs, setJobs] = React.useState([])
      const [open, setOpen] = React.useState(true)
      const [selected, setSelected] = React.useState(null)
      const [follow, setFollow] = React.useState(true)
      const [pos, setPos] = React.useState(null) // 拖拽后的 left/top；null = 初始右下角
      const dragRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const logRef = React.useRef(null)
      const followRef = React.useRef(true)
      followRef.current = follow
      React.useEffect(() => {
        let stop = false
        const poll = () => fetch('/bgjobs/state')
          .then((r) => r.json())
          .then((d) => { if (!stop) setJobs(Array.isArray(d && d.jobs) ? d.jobs : []) })
          .catch(() => {})
        poll()
        const iv = setInterval(poll, 1000)
        return () => { stop = true; clearInterval(iv) }
      }, [])
      React.useEffect(() => {
        if (logRef.current && followRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [jobs])

      const onHeaderDown = (e) => {
        if (e.button !== 0) return
        const rect = panelRef.current.getBoundingClientRect()
        setPos({ x: rect.left, y: rect.top })
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top }
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const onHeaderMove = (e) => {
        const d = dragRef.current
        if (!d) return
        setPos({
          x: d.origX + e.clientX - d.startX,
          y: d.origY + e.clientY - d.startY,
        })
      }
      const onHeaderUp = () => { dragRef.current = null }

      const sel = jobs.find((j) => j.id === selected) || null
      const panelStyle = {
        position: 'fixed',
        zIndex: 9999,
        width: 440,
        maxWidth: '92vw',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 10,
        boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
        border: '1px solid var(--dsw-alias-border-l2)',
        fontFamily: 'var(--dsw-font-family)',
        fontSize: 13,
      }
      if (pos) { panelStyle.left = pos.x; panelStyle.top = pos.y }
      else { panelStyle.right = 16; panelStyle.bottom = 16 }

      return h('div', { ref: panelRef, style: panelStyle },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'grab', touchAction: 'none', userSelect: 'none' }, onPointerDown: onHeaderDown, onPointerMove: onHeaderMove, onPointerUp: onHeaderUp, onPointerCancel: onHeaderUp, title: '拖拽移动面板' },
          h('div', { style: { fontWeight: 700 } }, '后台任务监控' + (jobs.length ? ' (' + jobs.length + ')' : '')),
          h('span', { style: { opacity: 0.7, cursor: 'pointer', padding: '0 2px' }, onClick: () => setOpen(!open), title: open ? '折叠面板' : '展开面板' }, open ? '▾' : '▸')
        ),
        open ? h('div', { style: { padding: 8 } },
          jobs.length === 0 ? h('div', { style: { opacity: 0.6, padding: 8 } }, '暂无后台任务（agent 用 bgjob_submit 提交）')
          : jobs.map((job) => h('div', { key: job.id },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: sel && sel.id === job.id ? 'var(--dsw-specific-selector)' : 'transparent' }, onClick: () => setSelected(sel && sel.id === job.id ? null : job.id) },
              h('div', null, h('div', { style: { fontWeight: 600 } }, job.name), h('div', { style: { opacity: 0.55, fontSize: 11, marginTop: 2 } }, job.workdir)),
              h('span', { style: { color: stateColor(job), fontWeight: 600 } }, stateLabel(job))
            ),
            sel && sel.id === job.id ? h('div', { style: { padding: '4px 8px 8px' } },
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 4, gap: 8, fontSize: 11, opacity: 0.75 } },
                h('label', null, h('input', { type: 'checkbox', checked: follow, onChange: (e) => setFollow(e.target.checked), style: { marginRight: 4 } }), '自动滚动')
              ),
              h('pre', { ref: logRef, style: { margin: 0, padding: 8, background: 'var(--dsw-specific-input-major)', borderRadius: 6, maxHeight: 280, overflowY: 'auto', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)' } }, (job.tail || '（等待输出…）'))
            ) : null
          ))
        ) : null
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'bgjobs-monitor', order: 50, label: '后台任务监控' },
        () => h(Panel),
      ))
    }

    const plugin = { name: 'bgjobs-client', inject: ['slots'], apply }
    exports.name = plugin.name
    exports.inject = plugin.inject
    exports.apply = plugin.apply
    return module.exports
  },
})
