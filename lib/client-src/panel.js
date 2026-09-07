// bgjobs client — background jobs monitor panel (v0.1.61)
const React = require('react')
const h = React.createElement
const { makeT } = require('./i18n.js')
const { stateColor, stateLabel, normalizePath, readActiveCwd, DONE_AGE_MS, PANEL_Z, TOAST_Z, GRIP_H, ToastComponent, iconEl, IconTrash, IconClock, IconClose, IconChevronDown, IconChevronRight, IconFolderOpen, IconFolderClose, SelfToast, CtrlBtn, MiniBtn, Toggle, portalBody, clampToViewport } = require('./ui.js')

    function Panel({ sessions: sessionsProp, getSessions, t }) {
      // t 兜底：locale seat 注入或 apply 传入；双重保险防未注入时白屏。
      if (typeof t !== 'function') t = makeT('zh')
      // sessions 服务可能晚于本插件激活（inject 未声明其依赖）：首次拿到后如仍是
      // undefined，则靠 getSessions 惰性再解析并重订阅——「仅当前会话」才能跟随 active 会话。
      const [liveSessions, setLiveSessions] = React.useState(sessionsProp)
      const sessionsRef = React.useRef(liveSessions)
      sessionsRef.current = liveSessions
      // getSessions 每次 apply 传入的函数都指向宿主 ctx（同一注册表），可反复重取；
      // 放 ref 里让 setInterval 创建的首个 poll 闭包也能读到最新实现。
      const getSessionsRef = React.useRef(getSessions)
      getSessionsRef.current = getSessions
      const sessions = liveSessions
      const [jobs, setJobs] = React.useState([])
      const [fullAccess, setFullAccess] = React.useState(false) // 面板"full access"开关（宿主持久化）
      const [open, setOpen] = React.useState(true)
      const [minimized, setMinimized] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [follow, setFollow] = React.useState(true)
      const [pos, setPos] = React.useState(null) // 拖拽/最小化后的 left/top；null = 初始右下角
      const [size, setSize] = React.useState(null) // 面板宽高；null = 默认自适应
      const [onlyActive, setOnlyActive] = React.useState(true) // 仅显示当前会话工作区任务
      const [activeCwd, setActiveCwd] = React.useState(() => readActiveCwd(sessionsProp)) // 当前 active 会话工作区
      const [collapsed, setCollapsed] = React.useState(() => new Set()) // 已折叠的工作区组
      const [trashOpen, setTrashOpen] = React.useState(false) // 🧹 删除模式：开启时底部显示垃圾篓
      const [toasts, setToasts] = React.useState([]) // [{ id, text }]
      // done 任务展开且快照无输出时的 lazy 日志：{ [jobId]: { loading, text } }。
      const [logExtra, setLogExtra] = React.useState({})
      const logFetchingRef = React.useRef(new Set()) // 防同一 job 重复 fetch
      const prevDoneRef = React.useRef(null) // null = 首次轮询（只记录不弹）；之后为 Set<jobId>
      const dragRef = React.useRef(null)
      const draggedRef = React.useRef(false) // 本次指针会话是否真的发生了拖动（位移阈值）
      const resizeRef = React.useRef(null) // 面板大小调节拖拽起点
      const panelRef = React.useRef(null)
      const ballRef = React.useRef(null)
      const foldAnchorRef = React.useRef(null) // 折叠锚点：折叠按钮右上角屏幕坐标
      const logRef = React.useRef(null)
      const followRef = React.useRef(true)
      followRef.current = follow
      const dismissToast = (id) => { setToasts((prev) => prev.filter((t) => t.id !== id)) }
      // 轮询：每秒拉 /bgjobs/state；pollNow 供删除/清理成功后立即刷新。
      const stopRef = React.useRef(false)
      const poll = () => fetch('/bgjobs/state')
        .then((r) => r.json())
        .then((d) => {
          if (stopRef.current) return
          const jobs = Array.isArray(d && d.jobs) ? d.jobs : []
          setJobs(jobs)
          if (d && typeof d.fullAccess === 'boolean') setFullAccess(d.fullAccess)
          // 跟随网页 active 会话切换：「仅当前会话」过滤随 active 工作区走。
          // sessions 服务可能晚于本模块激活——每轮轮询先经 getSessions 惰性重解析：
          // 实例变化即更新 liveSessions（触发下方 [sessions] 重订阅 effect）；随后用
          // 当前实例快照兜底刷新 active 工作区（部分会话切换不触发 list 订阅事件）。
          try {
            const probe = getSessionsRef.current
            if (probe) {
              const fresh = probe()
              if (fresh !== sessionsRef.current) {
                sessionsRef.current = fresh
                setLiveSessions(fresh)
              }
            }
          } catch (e) { /* 服务不可用：维持现状 */ }
          const svc = sessionsRef.current
          if (svc) {
            const cwdNow = readActiveCwd(svc)
            setActiveCwd((prev) => (cwdNow === prev ? prev : cwdNow))
          }
          // 检测新 done 任务 → 弹 toast（幂等：用上一轮 done id 集合对比）。
          const prev = prevDoneRef.current
          const next = new Set()
          for (const j of jobs) if (j.status === 'done') next.add(j.id)
          if (prev !== null) {
            for (const j of jobs) {
              if (j.status !== 'done' || prev.has(j.id)) continue
              const exitCode = j.exitCode === 0 ? t('toast.done', { name: j.name }) : t('toast.exit', { name: j.name, code: String(j.exitCode) })
              setToasts((cur) => [...cur, { id: 'toast-' + j.id + '-' + Date.now(), text: exitCode }])
            }
          }
          prevDoneRef.current = next
        })
        .catch(() => {})
      const pollNow = () => { poll() }
      // 删除/清理调用 host 路由；成功后刷新列表。
      const callHost = async (url) => {
        try {
          const r = await fetch(url, { method: 'POST' })
          return await r.json()
        } catch (e) { return { ok: false, error: String(e) } }
      }
      const deleteJob = async (id) => {
        const r = await callHost('/bgjobs/delete?id=' + encodeURIComponent(id))
        if (r && r.ok) { setSelected((s) => (s === id ? null : s)) ; pollNow() }
        return r
      }
      // done 任务展开且快照无输出时，按需从 host 读日志（只读路由，不写内存快照）。
      // 每 job 至多 fetch 一次：logExtra 缓存 + in-flight 防重入；空日志取回后仍显示「无输出」。
      const ensureLog = (job) => {
        if (!job || job.status !== 'done' || job.tail) return
        const id = job.id
        if (logExtra[id] || logFetchingRef.current.has(id)) return
        logFetchingRef.current.add(id)
        setLogExtra((prev) => ({ ...prev, [id]: { loading: true, text: '' } }))
        fetch('/bgjobs/log?id=' + encodeURIComponent(id))
          .then((r) => r.json())
          .then((d) => setLogExtra((prev) => ({ ...prev, [id]: { loading: false, text: d && d.ok ? String(d.text || '') : '' } })))
          .catch(() => setLogExtra((prev) => ({ ...prev, [id]: { loading: false, text: '' } })))
          .finally(() => logFetchingRef.current.delete(id))
      }
      const toggleSelect = (job) => {
        const next = selected === job.id ? null : job.id
        setSelected(next)
        if (next) ensureLog(job)
      }
      // 清理：与"仅当前会话工作区（含子目录）"过滤一致——只清理当前视图中的已完成任务，
      // 不会误删被过滤掉的其他工作区任务。逐条走 /bgjobs/delete（与拖拽删除同路由）。
      // olderOnly=true 时仅清理完成超过 24h 的任务（finishedAt 缺失视为不算超期）。
      const cleanupVisible = async (olderOnly) => {
        const cutoff = Date.now() - DONE_AGE_MS
        const done = visibleJobs.filter((j) =>
          j.status === 'done' && (!olderOnly || (j.finishedAt !== null && j.finishedAt !== undefined && j.finishedAt <= cutoff)))
        if (done.length === 0) { pollNow(); return { ok: true, removed: [] } }
        const removed = []
        for (const j of done) {
          const r = await callHost('/bgjobs/delete?id=' + encodeURIComponent(j.id))
          if (r && r.ok) removed.push(j.id)
        }
        setSelected((s) => (done.some((j) => j.id === s) ? null : s))
        pollNow()
        return { ok: true, removed }
      }
      // full access 开关（宿主持久化）：ON = 用户预批准全权限后台任务（原模式）。
      // 受限会话里宽请求不再逐次弹审批；未挂载 dsh 沙箱服务时也必须 ON 才能提交。
      const toggleFullAccess = async (enabled) => {
        try {
          const r = await fetch('/bgjobs/fullaccess?enabled=' + (enabled ? 1 : 0), { method: 'POST' })
          const d = await r.json()
          if (d && typeof d.enabled === 'boolean') setFullAccess(d.enabled)
        } catch (e) { /* 失败保持现状（下轮 poll 回显真实值） */ }
      }

      // 拖拽到垃圾篓：仅删除模式（🧹 已开启）下的 done 任务可拖；pointer 命中 trash
      // 区域高亮，松开删除。普通点击任务行（未开删除模式）不再触发拖拽/垃圾篓。
      const dragJobRef = React.useRef(null)
      const [trashHot, setTrashHot] = React.useState(false)
      const trashRef = React.useRef(null)
      const deletable = (job) => trashOpen && job.status === 'done'
      const onJobDown = (e, job) => {
        if (e.button !== 0 || !deletable(job)) return
        dragJobRef.current = job
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const onJobMove = (e) => {
        if (!dragJobRef.current) return
        const trash = trashRef.current
        if (!trash) return
        const r = trash.getBoundingClientRect()
        setTrashHot(e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
      }
      const onJobUp = async (e) => {
        const job = dragJobRef.current
        dragJobRef.current = null
        if (!job) return
        const trash = trashRef.current
        let hit = false
        if (trash) {
          const r = trash.getBoundingClientRect()
          hit = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
        }
        setTrashHot(false)
        if (hit) await deleteJob(job.id)
      }
      React.useEffect(() => {
        stopRef.current = false
        poll()
        const iv = setInterval(poll, 1000)
        return () => { stopRef.current = true; clearInterval(iv) }
      }, [])
      // 跟随 active 会话切换：订阅 sessions 服务；服务迟到时随 liveSessions 变化重订阅。
      React.useEffect(() => {
        if (!sessions) return
        let alive = true
        let unsubscribe
        try {
          unsubscribe = sessions.list.subscribe(() => { if (alive) setActiveCwd(readActiveCwd(sessions)) })
        } catch (e) { /* 服务不可用 */ }
        return () => { alive = false; if (typeof unsubscribe === 'function') unsubscribe() }
      }, [sessions])
      React.useEffect(() => {
        if (logRef.current && followRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [jobs])
      // lazy 日志缓存清理：任务被删除/清理后剔除已不在列表里的条目（无变化则不重设，避免循环渲染）。
      React.useEffect(() => {
        const keys = Object.keys(logExtra)
        if (keys.length === 0) return
        const ids = new Set(jobs.map((j) => j.id))
        let changed = false
        const next = {}
        for (const k of keys) {
          if (ids.has(k)) next[k] = logExtra[k]
          else changed = true
        }
        if (changed) setLogExtra(next)
      }, [jobs, logExtra])

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

      // 从悬浮球/折叠态恢复面板：球或折叠条的位置可能让完整面板超出视口，渲染后拉回。
      React.useEffect(() => {
        if (minimized || !open || !panelRef.current) return
        setPos((prev) => {
          if (!prev) return prev
          const r = panelRef.current.getBoundingClientRect()
          const c = clampToViewport(prev.x, prev.y, r.width, r.height)
          return c.x === prev.x && c.y === prev.y ? prev : c
        })
      }, [minimized, open])

      // 折叠落点：折叠后把（自适应宽度的）折叠列表锚定到"折叠按钮"所在位置，
      // 右缘对齐按钮右侧 +4px、顶缘对齐按钮顶部；渲染后量取实际宽高再 clamp 回视口。
      React.useEffect(() => {
        if (open || minimized) { foldAnchorRef.current = null; return }
        const anchor = foldAnchorRef.current
        const el = panelRef.current
        if (!anchor || !el) return
        const r = el.getBoundingClientRect()
        const c = clampToViewport(anchor.x - r.width, anchor.y, r.width, r.height)
        setPos(c)
        foldAnchorRef.current = null
      }, [open, minimized])

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
        draggedRef.current = false
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: r.left, origY: r.top, w: r.width, h: r.height }
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const moveDrag = (e) => {
        const d = dragRef.current
        if (!d) return
        if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 4) draggedRef.current = true
        const c = clampToViewport(d.origX + e.clientX - d.startX, d.origY + e.clientY - d.startY, d.w, d.h)
        setPos(c)
      }
      const endDrag = () => { dragRef.current = null }
      // 最小化到悬浮球：球的中心对准"最小化按钮"原来的屏幕位置（右上角标题栏处）。
      const minimizeToBall = (btnEl) => {
        try {
          const r = btnEl.getBoundingClientRect()
          const x = r.left + r.width / 2 - 24 // 球 48×48
          const y = r.top + r.height / 2 - 24
          setPos({ x, y })
        } catch (e) { /* 取不到 rect：悬浮球回退原默认位 */ }
        setMinimized(true)
      }

      // 面板大小调节：右下角手柄拖拽改宽高（clamp 到合理范围与视口内）。
      const clampSize = (w, h) => ({
        w: Math.min(Math.max(w, 300), Math.min(900, window.innerWidth - 32)),
        h: Math.min(Math.max(h, 260), Math.min(720, window.innerHeight - 32)),
      })
      const onResizeStart = (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const r = panelRef.current.getBoundingClientRect()
        resizeRef.current = { startX: e.clientX, startY: e.clientY, w: r.width, h: r.height }
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const onResizeMove = (e) => {
        const d = resizeRef.current
        if (!d) return
        setSize(clampSize(d.w + e.clientX - d.startX, d.h + e.clientY - d.startY))
      }
      const onResizeEnd = () => { resizeRef.current = null }

      const sel = jobs.find((j) => j.id === selected) || null
      const running = jobs.filter((j) => j.status === 'running').length
      const rootStyle = {
        position: 'fixed',
        zIndex: PANEL_Z,
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
        return portalBody(h(React.Fragment, null,
          renderToasts,
          h('div', {
            ref: ballRef,
            style: ballStyle,
            title: t('ball.title', { total: String(jobs.length), running: String(running) }),
            onPointerDown: startDrag,
            onPointerMove: moveDrag,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            // 拖动悬浮球后不自动展开（拖动也会派发 click，用位移阈值区分）。
            onClick: () => { if (!draggedRef.current) setMinimized(false) },
          },
            h('span', { style: { fontWeight: 700, fontSize: 15, color: running > 0 ? 'var(--dsw-alias-state-business-primary)' : undefined } }, '⏱' + (jobs.length || '')),
            running > 0
              ? h('span', { style: { position: 'absolute', top: 2, right: 2, width: 9, height: 9, borderRadius: '50%', background: 'var(--dsw-alias-state-business-primary)' } })
              : null,
          )
        ))
      }

      // ── 完整面板 ────────────────────────────────────────────────────
      // 仅显示当前会话工作区（activeCwd 不可用时退化为全部）：等于 active 工作区，
      // 或位于其子目录（带路径边界，`dev` 不误匹配 `dev2`）。
      const activeNorm = activeCwd ? normalizePath(activeCwd) : ''
      const isUnderActive = (workdir) => {
        const w = normalizePath(workdir)
        return w === activeNorm || (activeNorm !== '' && w.startsWith(activeNorm + '\\'))
      }
      const visibleJobs = onlyActive && activeNorm ? jobs.filter((j) => isUnderActive(j.workdir)) : jobs
      // 按工作区分组（保持任务原有相对顺序）。
      const groups = []
      const groupMap = new Map()
      for (const job of visibleJobs) {
        const wd = job.workdir || t('wd.unknown')
        let g = groupMap.get(wd)
        if (!g) { g = []; groupMap.set(wd, g); groups.push({ wd, jobs: g }) }
        g.push(job)
      }
      const toggleGroup = (wd) => setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(wd)) next.delete(wd); else next.add(wd)
        return next
      })
      const panelW = size ? size.w : 440
      const panelH = size ? size.h : Math.min(460, Math.max(190, 120 + visibleJobs.length * 44))
      // 折叠态高度：按任务行自适应（每行 30px），上限 310 内部滚动；无任务时退回把手高。
      const foldedH = visibleJobs.length === 0 ? GRIP_H : Math.min(10 + visibleJobs.length * 30, 310)
      // 折叠态宽度自适应内容（fit-content），封顶 420、下限 140；展开态用用户尺寸。
      const foldedW = Math.max(140, Math.min(panelW, 420))
      const panelStyle = open
        ? placed(Object.assign({}, rootStyle, {
            width: panelW,
            maxWidth: '92vw',
            height: panelH,
            borderRadius: 10,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }))
        : placed(Object.assign({}, rootStyle, {
            width: 'fit-content',
            minWidth: 140,
            maxWidth: foldedW,
            height: foldedH,
            borderRadius: 10,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }))
      return portalBody(h(React.Fragment, null,
        renderToasts,
        h('div', { ref: panelRef, style: panelStyle },
          open
            // ── 标题栏（展开态）：标题 + dsh 图标按钮 ──
            ? h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px 6px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'grab', touchAction: 'none', userSelect: 'none' }, onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, title: t('drag.move') },
                h('div', { style: { fontWeight: 700, fontSize: 13 } }, t('panel.title') + (jobs.length ? ' (' + jobs.length + ')' : '')),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 2 } },
                  h(CtrlBtn, { title: t('cleanup.menuTitle'), active: trashOpen, onClick: () => setTrashOpen(!trashOpen) },
                    iconEl(IconTrash, '🧹', 14)),
                  h(CtrlBtn, { title: t('collapse.btn.title'), onClick: (e) => {
                    setTrashOpen(false)
                    try {
                      const r = e.currentTarget.getBoundingClientRect()
                      foldAnchorRef.current = { x: r.right + 4, y: r.top }
                    } catch (err) { /* 取不到 rect：折叠后停在原位 */ }
                    setOpen(false)
                  } },
                    iconEl(IconChevronDown, '▾', 14)),
                  h(CtrlBtn, { title: t('minimize.btn.title'), onClick: (e) => minimizeToBall(e.currentTarget) },
                    iconEl(IconClose, '×', 16))
                )
              )
            // ── 折叠态：只显示任务行（无标题栏/勾选菜单/分组路径），
            //    点击任一任务行或右侧箭头展开完整面板；行区可拖拽移动 ──
            : visibleJobs.length === 0
              ? h('div', { title: t('fold.grip.title'), onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onClick: () => { if (!draggedRef.current) setOpen(true) }, style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab', touchAction: 'none', userSelect: 'none' } },
                  h('div', { style: { display: 'flex', gap: 3 } },
                    h('span', { style: { width: 4, height: 4, borderRadius: '50%', background: 'var(--dsw-alias-border-l2)' } }),
                    h('span', { style: { width: 4, height: 4, borderRadius: '50%', background: 'var(--dsw-alias-border-l2)' } }),
                    h('span', { style: { width: 4, height: 4, borderRadius: '50%', background: 'var(--dsw-alias-border-l2)' } })
                  )
                )
              : h('div', { onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onClick: () => { if (!draggedRef.current) setOpen(true) }, style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0', cursor: 'grab', touchAction: 'none', userSelect: 'none' } },
                  visibleJobs.map((job) => h('div', { key: 'f-' + job.id, title: t('row.expand.title'), style: { display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 28px 0 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                    h('span', { style: { width: 7, height: 7, borderRadius: '50%', flex: 'none', background: stateColor(job) } }),
                    // 名称按内容自适应（basis auto），仅当整条宽度触顶 420 时才收缩省略。
                    h('span', { style: { flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } }, job.name),
                    h('span', { style: { color: stateColor(job), flex: 'none', fontSize: 11, fontWeight: 600 } }, stateLabel(job, t))
                  )),
                  // 右侧显式展开入口（无标题栏时唯一常显箭头）。
                  h('div', { 'data-bgjobs-ctrl': true, title: t('btn.expand.title'), onClick: (e) => { e.stopPropagation(); setOpen(true) }, style: { position: 'absolute', right: 2, top: 2, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)' } },
                    iconEl(IconChevronDown, '▸', 14))
                ),
          open ? h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
            // 工具栏：仅当前会话过滤 + full access 两个 toggle（文字精简，细节进 tooltip）。
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '4px 12px 6px', fontSize: 11, opacity: 0.85 } },
              h(Toggle, { checked: onlyActive, onChange: setOnlyActive, title: t('only.session.title'), label: t('only.session') }),
              onlyActive && activeCwd ? h('span', { title: activeCwd, style: { opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 } }, activeCwd) : null,
              h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center' } },
                h(Toggle, { checked: fullAccess, onChange: toggleFullAccess, title: t('full.access.title'), label: t('full.access'), onColor: 'var(--dsw-alias-state-warn-primary)' })
              )
            ),
            // 列表区：可滚动；按工作区分组，组头吸顶、可点击折叠。
            h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 4px' } },
              visibleJobs.length === 0 ? h('div', { style: { opacity: 0.6, padding: 8 } }, (jobs.length === 0 ? t('list.empty') : t('list.empty.scope')))
              : h('div', null,
                groups.map((g) => h('div', { key: 'g-' + g.wd },
                  h('div', { onClick: () => toggleGroup(g.wd), title: collapsed.has(g.wd) ? t('grp.expand') : t('grp.collapse'), style: { position: 'sticky', top: 0, zIndex: 1, background: 'var(--dsw-alias-bg-layer-3)', padding: '4px 8px', fontSize: 11, fontWeight: 600, opacity: 0.65, borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center' } },
                    h('span', { style: { display: 'inline-flex', alignItems: 'center', width: 14, flex: 'none' } }, collapsed.has(g.wd) ? iconEl(IconChevronRight, '▸', 12) : iconEl(IconChevronDown, '▾', 12)),
                    h('span', { style: { display: 'inline-flex', alignItems: 'center', marginRight: 4, flex: 'none' } }, collapsed.has(g.wd) ? iconEl(IconFolderClose, '📁', 12) : iconEl(IconFolderOpen, '📁', 12)),
                    t('grp.count', { wd: g.wd, count: g.jobs.length })
                  ),
                  collapsed.has(g.wd) ? null : g.jobs.map((job) => h('div', { key: job.id,
                    style: { opacity: trashOpen && job.status !== 'done' ? 0.55 : 1, cursor: deletable(job) ? 'grab' : 'default', touchAction: 'none' },
                    onPointerDown: (e) => onJobDown(e, job),
                    onPointerMove: onJobMove,
                    onPointerUp: onJobUp,
                    onPointerCancel: onJobUp,
                    title: deletable(job) ? t('job.trashHint') : undefined,
                  },
                    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: sel && sel.id === job.id ? 'var(--dsw-specific-selector)' : 'transparent' }, onClick: () => toggleSelect(job) },
                      h('div', null, h('div', { style: { fontWeight: 600 } }, job.name), h('div', { style: { opacity: 0.55, fontSize: 11, marginTop: 2 } }, job.workdir)),
                      h('span', { style: { color: stateColor(job), fontWeight: 600 } }, stateLabel(job, t))
                    ),
                    sel && sel.id === job.id ? h('div', { style: { padding: '4px 8px 8px' } },
                      h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 4, gap: 8, fontSize: 11, opacity: 0.75 } },
                        h('span', { title: job.notified ? t('notify.done.title') : t('notify.pending.title'), style: { display: 'inline-flex', alignItems: 'center', gap: 3, marginRight: 'auto', color: job.notified ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)' } },
                          (job.notified ? t('notify.done') : t('notify.pending'))),
                        h('label', null, h('input', { type: 'checkbox', checked: follow, onChange: (e) => setFollow(e.target.checked), style: { marginRight: 4 } }), t('follow.scroll'))
                      ),
                      h('pre', { ref: logRef, style: { margin: 0, padding: 8, background: 'var(--dsw-specific-input-major)', borderRadius: 6, maxHeight: 280, overflowY: 'auto', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)' } }, (job.tail || (job.status === 'done'
                        ? (logExtra[job.id] ? (logExtra[job.id].loading ? t('log.loading') : (logExtra[job.id].text || t('log.none'))) : t('log.none'))
                        : t('log.waiting'))))
                    ) : null
                  ))
                ))
              )
            ),
            // 垃圾篓：仅删除模式（🧹 已开启）时出现；可拖拽已结束任务到此删除，
            // 右侧小按钮批量清理（超 24h / 全部，作用于当前视图）。
            trashOpen ? h('div', {
              ref: trashRef,
              style: { margin: '6px 8px', padding: '3px 6px', borderRadius: 6, border: '1px dashed ' + (trashHot ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l2)'), background: trashHot ? 'var(--dsw-alias-state-error-primary)' : 'transparent', color: trashHot ? 'var(--dsw-alias-label-primary-inverted)' : 'var(--dsw-alias-label-secondary)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, userSelect: 'none' },
            },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', flex: 'none' } }, iconEl(IconTrash, '🗑', 12)),
              h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, t('trash.bar')),
              h('span', { style: { display: 'inline-flex', gap: 4, flex: 'none' } },
                h(MiniBtn, { title: t('trash.older.title'), onClick: () => { setTrashOpen(false); cleanupVisible(true) } },
                  iconEl(IconClock, '🕐', 12), t('trash.older')),
                h(MiniBtn, { title: t('trash.all.title'), onClick: () => { setTrashOpen(false); cleanupVisible(false) } },
                  iconEl(IconTrash, '🗑', 12), t('trash.all'))))
              : null
          ) : null,
          // 右下角大小调节手柄（折叠态隐藏）。
          open ? h('div', { style: { position: 'absolute', right: 0, bottom: 0, width: 18, height: 18, cursor: 'nwse-resize', touchAction: 'none', background: 'linear-gradient(135deg, transparent 50%, var(--dsw-alias-border-l2) 50%)' }, onPointerDown: onResizeStart, onPointerMove: onResizeMove, onPointerUp: onResizeEnd, onPointerCancel: onResizeEnd, title: t('resize.handle') }) : null
        )
      ))
    }
module.exports = { Panel }
