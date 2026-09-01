// bgjobs client bundle —— 网页「后台任务监控」浮动面板
// 由 client-modules 经 package.json 的 dsh.client 声明加载；
// 数据通过 fetch 轮询宿主侧 webServer 前缀路由 /bgjobs/state。
// 样式跟随 dsh 主题：颜色全部用 --dsw-* token（ui-theme design-platform.css
// 定义的全局变量，随明暗主题自动切换）。
// 交互：面板可拖拽移动（标题栏 pointer 拖拽，拖拽中与窗口 resize 时自动
// clamp 回可见区域）；可折叠（▾/▸）；可最小化为悬浮球（— 按钮，点击恢复，
// 悬浮球同样可拖拽）。
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

    // 把 (x, y) 拉回视口内，四周留 PAD 边距（el 用于取宽高）。
    const clampToViewport = (x, y, width, height, pad) => {
      const PAD = pad === undefined ? 8 : pad
      const vw = window.innerWidth
      const vh = window.innerHeight
      return {
        x: Math.min(Math.max(x, PAD), Math.max(PAD, vw - width - PAD)),
        y: Math.min(Math.max(y, PAD), Math.max(PAD, vh - height - PAD)),
      }
    }

    function Panel() {
      const [jobs, setJobs] = React.useState([])
      const [open, setOpen] = React.useState(true)
      const [minimized, setMinimized] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [follow, setFollow] = React.useState(true)
      const [pos, setPos] = React.useState(null) // 拖拽/最小化后的 left/top；null = 初始右下角
      const dragRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const ballRef = React.useRef(null)
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

      // 窗口 resize：固定位置（left/top）可能跑出视口，自动拉回。
      React.useEffect(() => {
        const onResize = () => {
          setPos((prev) => {
            if (!prev) return prev
            const el = minimized ? ballRef.current : panelRef.current
            if (!el) return prev
            const r = el.getBoundingClientRect()
            const c = clampToViewport(prev.x, prev.y, r.width, r.height)
            return c.x === prev.x && c.y === prev.y ? prev : c
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [minimized])

      // 通用拖拽：down 记录起点与元素尺寸；move 按位移计算并 clamp 回视口。
      const startDrag = (e) => {
        if (e.button !== 0) return
        const el = minimized ? ballRef.current : panelRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        setPos({ x: r.left, y: r.top })
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: r.left, origY: r.top, w: r.width, h: r.height }
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const moveDrag = (e) => {
        const d = dragRef.current
        if (!d) return
        const c = clampToViewport(d.origX + e.clientX - d.startX, d.origY + e.clientY - d.startY, d.w, d.h)
        setPos(c)
      }
      const endDrag = () => { dragRef.current = null }

      const sel = jobs.find((j) => j.id === selected) || null
      const running = jobs.filter((j) => j.status === 'running').length
      const rootStyle = {
        position: 'fixed',
        zIndex: 9999,
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
        fontFamily: 'var(--dsw-font-family)',
        fontSize: 13,
      }
      const placed = (el) => {
        if (pos) { el.left = pos.x; el.top = pos.y }
        else { el.right = 16; el.bottom = 16 }
        return el
      }

      // ── 悬浮球（最小化态）──────────────────────────────────────────
      if (minimized) {
        const ballStyle = placed(Object.assign({}, rootStyle, {
          width: 48,
          height: 48,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'grab',
          touchAction: 'none',
          userSelect: 'none',
        }))
        return h('div', {
          ref: ballRef,
          style: ballStyle,
          title: 'bgjobs 后台任务（' + jobs.length + ' 个，运行中 ' + running + ' 个）——点击展开',
          onPointerDown: startDrag,
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onClick: () => setMinimized(false),
        },
          h('span', { style: { fontWeight: 700, fontSize: 15, color: running > 0 ? 'var(--dsw-alias-state-business-primary)' : undefined } }, '⏱' + (jobs.length || '')),
          running > 0
            ? h('span', { style: { position: 'absolute', top: 2, right: 2, width: 9, height: 9, borderRadius: '50%', background: 'var(--dsw-alias-state-business-primary)' } })
            : null,
        )
      }

      // ── 完整面板 ────────────────────────────────────────────────────
      const panelStyle = placed(Object.assign({}, rootStyle, {
        width: 440,
        maxWidth: '92vw',
        borderRadius: 10,
      }))
      return h('div', { ref: panelRef, style: panelStyle },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'grab', touchAction: 'none', userSelect: 'none' }, onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, title: '拖拽移动面板' },
          h('div', { style: { fontWeight: 700 } }, '后台任务监控' + (jobs.length ? ' (' + jobs.length + ')' : '')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { opacity: 0.7, cursor: 'pointer', padding: '0 2px' }, onClick: (e) => { e.stopPropagation(); setMinimized(true) }, title: '最小化为悬浮球' }, '—'),
            h('span', { style: { opacity: 0.7, cursor: 'pointer', padding: '0 2px' }, onClick: (e) => { e.stopPropagation(); setOpen(!open) }, title: open ? '折叠面板' : '展开面板' }, open ? '▾' : '▸')
          )
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
