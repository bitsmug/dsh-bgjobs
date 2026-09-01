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
    // 复用 harness 共享的 UI Toast（@deepseek-ai/dsh-client-ui-primitives 在
    // PLATFORM_MODULES 共享模块表内，动态 client bundle 可直接 require）。
    let ToastComponent = null
    try { ToastComponent = require('@deepseek-ai/dsh-client-ui-primitives').Toast } catch (e) { /* 打包异常时退化为自绘 */ }

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

    // 自绘 toast 兜底（ToastComponent 不可用时的简易版，同主题 token）。
    function SelfToast({ text, onDone }) {
      React.useEffect(() => {
        const t = setTimeout(onDone, 4000)
        return () => { clearTimeout(t) }
      }, [])
      return h('div', { role: 'alert', style: {
        position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10000,
        background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '8px 16px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.45)', fontFamily: 'var(--dsw-font-family)', fontSize: 13,
      } }, text)
    }

    function Panel() {
      const [jobs, setJobs] = React.useState([])
      const [open, setOpen] = React.useState(true)
      const [minimized, setMinimized] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [follow, setFollow] = React.useState(true)
      const [pos, setPos] = React.useState(null) // 拖拽/最小化后的 left/top；null = 初始右下角
      const [toasts, setToasts] = React.useState([]) // [{ id, text }]
      const prevDoneRef = React.useRef(null) // null = 首次轮询（只记录不弹）；之后为 Set<jobId>
      const dragRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const ballRef = React.useRef(null)
      const logRef = React.useRef(null)
      const followRef = React.useRef(true)
      followRef.current = follow
      const dismissToast = (id) => { setToasts((prev) => prev.filter((t) => t.id !== id)) }
      React.useEffect(() => {
        let stop = false
        const poll = () => fetch('/bgjobs/state')
          .then((r) => r.json())
          .then((d) => {
            if (stop) return
            const jobs = Array.isArray(d && d.jobs) ? d.jobs : []
            setJobs(jobs)
            // 检测新 done 任务 → 弹 toast（幂等：用上一轮 done id 集合对比）。
            const prev = prevDoneRef.current
            const next = new Set()
            for (const j of jobs) if (j.status === 'done') next.add(j.id)
            if (prev !== null) {
              for (const j of jobs) {
                if (j.status !== 'done' || prev.has(j.id)) continue
                const exitText = j.exitCode === 0 ? '已完成' : '已结束（exit=' + String(j.exitCode) + '）'
                setToasts((cur) => [...cur, { id: 'toast-' + j.id + '-' + Date.now(), text: '后台任务「' + j.name + '」' + exitText }])
              }
            }
            prevDoneRef.current = next
          })
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

      // 从悬浮球恢复面板：球的位置可能让完整面板超出视口，渲染后拉回。
      React.useEffect(() => {
        if (minimized || !panelRef.current) return
        setPos((prev) => {
          if (!prev) return prev
          const r = panelRef.current.getBoundingClientRect()
          const c = clampToViewport(prev.x, prev.y, r.width, r.height)
          return c.x === prev.x && c.y === prev.y ? prev : c
        })
      }, [minimized])

      // 通用拖拽：down 记录起点与元素尺寸；move 按位移计算并 clamp 回视口。
      // 折叠/最小化按钮（data-bgjobs-ctrl）不进入拖拽路径：否则 setPointerCapture
      // 会把后续 pointer 事件重定向到标题栏，吞掉按钮的 click。
      const startDrag = (e) => {
        if (e.button !== 0) return
        if (e.target && e.target.closest && e.target.closest('[data-bgjobs-ctrl]')) return
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

      // 完成通知 toast 栈：每条用共享 Toast（hold 后 onDone 自动移除），
      // 不可用时用自绘 SelfToast。渲染为 fragment 的一部分（固定定位，脱离面板流）。
      const renderToasts = toasts.map((t) =>
        ToastComponent
          ? h(ToastComponent, { key: t.id, text: t.text, onDone: () => dismissToast(t.id) })
          : h(SelfToast, { key: t.id, text: t.text, onDone: () => dismissToast(t.id) })
      )

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
        return h(React.Fragment, null,
          renderToasts,
          h('div', {
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
        )
      }

      // ── 完整面板 ────────────────────────────────────────────────────
      const panelStyle = placed(Object.assign({}, rootStyle, {
        width: 440,
        maxWidth: '92vw',
        borderRadius: 10,
      }))
      return h(React.Fragment, null,
        renderToasts,
        h('div', { ref: panelRef, style: panelStyle },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'grab', touchAction: 'none', userSelect: 'none' }, onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, title: '拖拽移动面板' },
            h('div', { style: { fontWeight: 700 } }, '后台任务监控' + (jobs.length ? ' (' + jobs.length + ')' : '')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { 'data-bgjobs-ctrl': true, style: { opacity: 0.7, cursor: 'pointer', padding: '0 2px' }, onClick: (e) => { e.stopPropagation(); setMinimized(true) }, title: '最小化为悬浮球' }, '—'),
              h('span', { 'data-bgjobs-ctrl': true, style: { opacity: 0.7, cursor: 'pointer', padding: '0 2px' }, onClick: (e) => { e.stopPropagation(); setOpen(!open) }, title: open ? '折叠面板' : '展开面板' }, open ? '▾' : '▸')
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
