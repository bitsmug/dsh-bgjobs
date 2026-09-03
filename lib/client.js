// bgjobs client bundle —— 网页「后台任务监控」浮动面板
// 由 client-modules 经 package.json 的 dsh.client 声明加载；
// 数据通过 fetch 轮询宿主侧 webServer 前缀路由 /bgjobs/state。
// 样式跟随 dsh 主题：颜色全部用 --dsw-* token（ui-theme design-platform.css
// 定义的全局变量，随明暗主题自动切换）。
// 交互：面板可拖拽移动（标题栏/把手条 pointer 拖拽，拖拽中与窗口 resize 时自动
// clamp 回可见区域）；可折叠（收成极简把手条，点击展开）；可最小化为悬浮球（按钮，
// 点击恢复，悬浮球同样可拖拽）。标题栏按钮用 dsh 网页同款 SVG Icon（ui-primitives）。
window.__ModuleLoader__.load({
  id: 'bgjobs',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    // ── i18n：跟随 dsh 主界面语言（ctx.locale 的 zh/en；locale 缺失时回退中文）──
    const NS = 'bgjobs'
    const ZH = {
      'panel.title': '后台任务监控',
      'ball.title': 'bgjobs 后台任务（{total} 个，运行中 {running} 个）——点击展开',
      'drag.move': '拖拽移动面板',
      'state.running': '● 运行中',
      'state.done': '✓ 已结束',
      'state.exit': '✗ 退出 {code}',
      'toast.done': '后台任务「{name}」已完成',
      'toast.exit': '后台任务「{name}」已结束（exit={code}）',
      'wd.unknown': '（未知工作区）',
      'grp.count': '{wd}（{count}）',
      'grp.expand': '展开该工作区的任务',
      'grp.collapse': '折叠该工作区的任务',
      'cleanup.menuTitle': '清理已完成任务：点击选择「仅超过 24h」或「全部」（与视图过滤一致）',
      'cleanup.scopeTitle': '清理已完成任务（范围与当前视图过滤一致{scope}）',
      'cleanup.scopeActive': '：当前会话工作区',
      'cleanup.24h': '仅清理超过 24h 的已完成任务',
      'cleanup.24h.title': '仅删除完成超过 24h 的任务（24h 内默认保留）',
      'cleanup.all': '清理全部已完成任务',
      'cleanup.all.title': '删除当前视图中所有已完成任务（含 24h 内）',
      'cleanup.cancel': '取消',
      'collapse.btn.title': '折叠为仅任务列表（隐藏标题栏/筛选/分组路径，点击列表展开）',
      'minimize.btn.title': '最小化为悬浮球（球会出现在按钮位置）',
      'only.session': '仅当前会话',
      'only.session.title': '只显示当前 active 会话工作区（含其子目录）下的任务',
      'full.access': '全权限',
      'full.access.title': '预批准全权限后台任务（原模式）。开启后受限会话里的宽权限请求不再逐次弹审批；未挂载 dsh 沙箱策略服务的部署也必须开启才能提交任务。',
      'list.empty': '暂无后台任务（agent 用 bgjob_submit 提交）',
      'list.empty.scope': '当前会话工作区暂无任务（关闭筛选可查看全部）',
      'job.trashHint': '拖到下方垃圾篓可删除',
      'follow.scroll': '自动滚动',
      'log.waiting': '（等待输出…）',
      'trash.bar': '垃圾篓（拖到这里删除）',
      'resize.handle': '拖动调节面板大小',
      'fold.grip.title': '点击展开面板',
      'row.expand.title': '点击展开完整面板',
      'btn.expand.title': '展开完整面板',
    }
    const EN = {
      'panel.title': 'Background Jobs',
      'ball.title': 'bgjobs: {total} job(s), {running} running — click to expand',
      'drag.move': 'Drag to move',
      'state.running': '● running',
      'state.done': '✓ done',
      'state.exit': '✗ exit {code}',
      'toast.done': 'Background job "{name}" completed',
      'toast.exit': 'Background job "{name}" ended (exit={code})',
      'wd.unknown': '(unknown workspace)',
      'grp.count': '{wd} ({count})',
      'grp.expand': 'Expand jobs in this workspace',
      'grp.collapse': 'Collapse jobs in this workspace',
      'cleanup.menuTitle': 'Clean up finished jobs: choose "older than 24h" or "all" (follows the view filter)',
      'cleanup.scopeTitle': 'Clean up finished jobs (scope follows the view filter{scope})',
      'cleanup.scopeActive': ': current session workspace',
      'cleanup.24h': 'Only jobs finished >24h ago',
      'cleanup.24h.title': 'Delete only jobs finished over 24h ago (default keeps the last 24h)',
      'cleanup.all': 'All finished jobs',
      'cleanup.all.title': 'Delete every finished job in the current view (incl. <24h)',
      'cleanup.cancel': 'Cancel',
      'collapse.btn.title': 'Collapse to a compact job list (hides header/filters/group paths; click a row to expand)',
      'minimize.btn.title': 'Minimize to a floating ball (it appears where the button was)',
      'only.session': 'This session',
      'only.session.title': 'Show only jobs under the active session workspace (incl. subdirectories)',
      'full.access': 'Full access',
      'full.access.title': 'Pre-approve full-access background jobs. When on, wider-than-session permission requests no longer prompt each time; deployments without the dsh sandbox policy service must also enable this to submit.',
      'list.empty': 'No background jobs yet (an agent submits them via bgjob_submit)',
      'list.empty.scope': 'No jobs under the current session workspace (turn off the filter to see all)',
      'job.trashHint': 'Drag to the trash below to delete',
      'follow.scroll': 'Auto-scroll',
      'log.waiting': '(waiting for output…)',
      'trash.bar': 'Trash — drop here to delete',
      'resize.handle': 'Drag to resize',
      'fold.grip.title': 'Click to expand',
      'row.expand.title': 'Click to expand full panel',
      'btn.expand.title': 'Expand full panel',
    }
    const fmt = (tpl, params) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m))
    // 缺 key 时按 zh→en→key 链回退；zh 为源，en 全键（编辑器难保证时兜底再回 key）。
    const lookup = (dict, key) => (dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined)
    const makeT = (active) => (key, params) => {
      const lang = active === 'zh' ? ZH : EN
      const other = active === 'zh' ? EN : ZH
      return fmt(lookup(lang, key) ?? lookup(other, key) ?? key, params)
    }

    // 复用 harness 共享 UI 原子（@deepseek-ai/dsh-client-ui-primitives 在
    // PLATFORM_MODULES 共享模块表内，动态 client bundle 可直接 require）：
    // Toast + 标题栏/列表按钮用的 dsh 网页同款 SVG Icon。任一缺失退化自绘/文本符号。
    let primitives = null
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch (e) { /* 打包异常 */ }
    const ToastComponent = primitives ? primitives.Toast : null
    const IconTrash = primitives ? primitives.IconTrashOutline16 : null
    const IconClock = primitives ? primitives.IconClockOutline16 : null
    const IconClose = primitives ? primitives.IconCloseOutline16 : null
    const IconChevronDown = primitives ? primitives.IconChevronDownOutline14 : null
    const IconChevronRight = primitives ? primitives.IconChevronRightOutline14 : null
    const IconFolderOpen = primitives ? primitives.IconFolderOpen16 : null
    const IconFolderClose = primitives ? primitives.IconFolderClose16 : null
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch (e) { /* 无 react-dom 时退化就地渲染 */ }

    // 状态徽章：running → 品牌色，成功 → success，失败 → error（主题 token）。
    const stateColor = (job) => {
      if (job.status === 'running') return 'var(--dsw-alias-state-business-primary)'
      if (job.status === 'done' && job.exitCode === 0) return 'var(--dsw-alias-state-success-primary)'
      return 'var(--dsw-alias-state-error-primary)'
    }
    const stateLabel = (job, t) => {
      if (job.status === 'running') return t('state.running')
      if (job.status === 'done' && job.exitCode === 0) return t('state.done')
      return t('state.exit', { code: String(job.exitCode) })
    }

    // 归一化工作区路径用于比较：斜杠统一为 \、去尾部斜杠、小写（容忍大小写/尾斜杠差异）。
    const normalizePath = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

    // 读当前 active 会话的工作区路径（sessions 服务不可用/无 cwd 时返回 undefined）。
    const readActiveCwd = (sessions) => {
      if (!sessions) return undefined
      try {
        const st = sessions.list.getSnapshot()
        if (!st || st.current === undefined) return undefined
        const cur = st.byId && st.byId[st.current]
        return cur && cur.cwd ? String(cur.cwd) : undefined
      } catch (e) { return undefined }
    }

    // 面板/通知层级：提到接近 z-index 上限，避免被侧边栏等插件（res profile）遮挡。
    const PANEL_Z = 2147483000
    const TOAST_Z = PANEL_Z + 1
    // "清理 24h 前已完成"的年龄阈值（ms）；24h 内完成的默认保留。
    const DONE_AGE_MS = 24 * 60 * 60 * 1000
    // 折叠把手条高度（px）：折叠 = 收成一条可点/可拖的细把手，标题与按钮全收起。
    const GRIP_H = 26
    // 传送门挂载到 document.body：bgjobs 面板的 PANEL_Z 若在 shell.overlay（z-index 20 的
    // 层叠上下文）内渲染会被困住——根级排序只按 20 参与，被 BODY 级 z-25 的侧边栏插件浮层
    // 压住（浏览器实测）。传送后面板参与根级层叠，PANEL_Z > 25 恒在最上层。
    const portalBody = (node) => (
      ReactDOM && typeof document !== 'undefined' && document.body
        ? ReactDOM.createPortal(node, document.body)
        : node
    )

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
        position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: TOAST_Z,
        background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '8px 16px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.45)', fontFamily: 'var(--dsw-font-family)', fontSize: 13,
      } }, text)
    }

    // 图标按钮（dsh 网页观感）：24px 点击区、圆角、hover 高亮、currentColor。
    // data-bgjobs-ctrl 让标题栏拖拽守卫忽略这些控件（防 setPointerCapture 吞 click）。
    function CtrlBtn({ title, onClick, active, children }) {
      const [hover, setHover] = React.useState(false)
      return h('div', {
        'data-bgjobs-ctrl': true,
        title,
        onClick: (e) => { e.stopPropagation(); onClick(e) },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          width: 24, height: 24, flex: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 6, cursor: 'pointer',
          background: hover ? 'var(--dsw-specific-selector)' : 'transparent',
          color: active || hover ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        },
      }, children)
    }
    // 图标/回退文本二选一：Icon 组件缺失时退化文本符号（不因图标加载失败白屏）。
    const iconEl = (Icon, fallback, size) => (
      Icon
        ? h(Icon, { size: size || 14, style: { display: 'block' } })
        : h('span', { style: { fontSize: size || 14, lineHeight: 1 } }, fallback)
    )

    // Toggle 开关（比原生 checkbox 更美观）：隐藏原生控件 + 轨道/滑块，随主题 token。
    // onColor = 开启态轨道色；默认 business 蓝，"全权限"用审批面板同款警示橙红。
    function Toggle({ checked, onChange, title, label, onColor }) {
      return h('label', { title, style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' } },
        h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked), style: { position: 'absolute', opacity: 0, pointerEvents: 'none' } }),
        h('span', { 'aria-hidden': true, style: { width: 30, height: 18, borderRadius: 9, flex: 'none', position: 'relative', background: checked ? (onColor || 'var(--dsw-alias-state-business-primary)') : 'var(--dsw-alias-border-l2)', transition: 'background 0.15s ease' } },
          h('span', { style: { position: 'absolute', top: 2, left: checked ? 14 : 2, width: 14, height: 14, borderRadius: '50%', background: 'var(--dsw-alias-bg-layer-3)', boxShadow: '0 1px 2px rgba(0,0,0,0.4)', transition: 'left 0.15s ease' } })
        ),
        h('span', { style: { fontSize: 11 } }, label)
      )
    }

    function Panel({ sessions, t }) {
      // t 兜底：locale seat 注入或 apply 传入；双重保险防未注入时白屏。
      if (typeof t !== 'function') t = makeT('zh')
      const [jobs, setJobs] = React.useState([])
      const [fullAccess, setFullAccess] = React.useState(false) // 面板"full access"开关（宿主持久化）
      const [open, setOpen] = React.useState(true)
      const [minimized, setMinimized] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [follow, setFollow] = React.useState(true)
      const [pos, setPos] = React.useState(null) // 拖拽/最小化后的 left/top；null = 初始右下角
      const [size, setSize] = React.useState(null) // 面板宽高；null = 默认自适应
      const [onlyActive, setOnlyActive] = React.useState(true) // 仅显示当前会话工作区任务
      const [activeCwd, setActiveCwd] = React.useState(() => readActiveCwd(sessions)) // 当前 active 会话工作区
      const [collapsed, setCollapsed] = React.useState(() => new Set()) // 已折叠的工作区组
      const [cleanupMenu, setCleanupMenu] = React.useState(false) // 🧹 展开"清理范围"菜单
      const [toasts, setToasts] = React.useState([]) // [{ id, text }]
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

      // 拖拽到垃圾篓：仅 done/异常退出任务可拖；pointer 命中 trash 区域高亮，松开删除。
      const dragJobRef = React.useRef(null)
      const [trashHot, setTrashHot] = React.useState(false)
      const [dragging, setDragging] = React.useState(false) // 拖拽中 → 显示垃圾篓
      const trashRef = React.useRef(null)
      const draggable = (job) => job.status === 'done'
      const onJobDown = (e, job) => {
        if (e.button !== 0 || !draggable(job)) return
        dragJobRef.current = job
        setDragging(true)
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
        setDragging(false)
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
      // 跟随 active 会话切换：订阅 sessions 服务，工作区变化即刷新过滤。
      React.useEffect(() => {
        if (!sessions) return
        let alive = true
        let unsubscribe
        try {
          unsubscribe = sessions.list.subscribe(() => { if (alive) setActiveCwd(readActiveCwd(sessions)) })
        } catch (e) { /* 服务不可用 */ }
        return () => { alive = false; if (typeof unsubscribe === 'function') unsubscribe() }
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
                  h(CtrlBtn, { title: t('cleanup.menuTitle'), active: cleanupMenu, onClick: () => setCleanupMenu(!cleanupMenu) },
                    iconEl(IconTrash, '🧹', 14)),
                  h(CtrlBtn, { title: t('collapse.btn.title'), onClick: (e) => {
                    setCleanupMenu(false)
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
          cleanupMenu && open ? h('div', { style: { borderBottom: '1px solid var(--dsw-alias-border-l1)', padding: '6px 10px 4px', display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 } },
            h('div', { style: { opacity: 0.6, padding: '0 4px 2px' } }, t('cleanup.scopeTitle', { scope: onlyActive && activeCwd ? t('cleanup.scopeActive') : '' })),
            h('div', { onClick: () => { setCleanupMenu(false); cleanupVisible(true) }, title: t('cleanup.24h.title'), style: { padding: '3px 4px', cursor: 'pointer', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 6 } },
              iconEl(IconClock, '🧹', 12), t('cleanup.24h')),
            h('div', { onClick: () => { setCleanupMenu(false); cleanupVisible(false) }, title: t('cleanup.all.title'), style: { padding: '3px 4px', cursor: 'pointer', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 6 } },
              iconEl(IconTrash, '🗑', 12), t('cleanup.all')),
            h('div', { onClick: () => setCleanupMenu(false), style: { padding: '3px 4px', cursor: 'pointer', borderRadius: 4, opacity: 0.6, display: 'flex', alignItems: 'center', gap: 6 } },
              iconEl(IconClose, '✕', 12), t('cleanup.cancel'))
          ) : null,
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
                    style: { opacity: draggable(job) ? 1 : 0.55, cursor: draggable(job) ? 'grab' : 'default', touchAction: 'none' },
                    onPointerDown: (e) => onJobDown(e, job),
                    onPointerMove: onJobMove,
                    onPointerUp: onJobUp,
                    onPointerCancel: onJobUp,
                    title: draggable(job) ? t('job.trashHint') : undefined,
                  },
                    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: sel && sel.id === job.id ? 'var(--dsw-specific-selector)' : 'transparent' }, onClick: () => setSelected(sel && sel.id === job.id ? null : job.id) },
                      h('div', null, h('div', { style: { fontWeight: 600 } }, job.name), h('div', { style: { opacity: 0.55, fontSize: 11, marginTop: 2 } }, job.workdir)),
                      h('span', { style: { color: stateColor(job), fontWeight: 600 } }, stateLabel(job, t))
                    ),
                    sel && sel.id === job.id ? h('div', { style: { padding: '4px 8px 8px' } },
                      h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 4, gap: 8, fontSize: 11, opacity: 0.75 } },
                        h('label', null, h('input', { type: 'checkbox', checked: follow, onChange: (e) => setFollow(e.target.checked), style: { marginRight: 4 } }), t('follow.scroll'))
                      ),
                      h('pre', { ref: logRef, style: { margin: 0, padding: 8, background: 'var(--dsw-specific-input-major)', borderRadius: 6, maxHeight: 280, overflowY: 'auto', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)' } }, (job.tail || t('log.waiting')))
                    ) : null
                  ))
                ))
              )
            ),
            // 垃圾篓：默认隐藏，拖拽 done 任务时才出现。
            dragging ? h('div', {
              ref: trashRef,
              style: { margin: '6px 8px', padding: '6px 8px', borderRadius: 6, border: '1px dashed ' + (trashHot ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l2)'), background: trashHot ? 'var(--dsw-alias-state-error-primary)' : 'transparent', color: trashHot ? 'var(--dsw-alias-label-primary-inverted)' : 'var(--dsw-alias-label-secondary)', textAlign: 'center', fontSize: 12, userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
            }, iconEl(IconTrash, '🗑', 12), t('trash.bar')) : null
          ) : null,
          // 右下角大小调节手柄（折叠态隐藏）。
          open ? h('div', { style: { position: 'absolute', right: 0, bottom: 0, width: 18, height: 18, cursor: 'nwse-resize', touchAction: 'none', background: 'linear-gradient(135deg, transparent 50%, var(--dsw-alias-border-l2) 50%)' }, onPointerDown: onResizeStart, onPointerMove: onResizeMove, onPointerUp: onResizeEnd, onPointerCancel: onResizeEnd, title: t('resize.handle') }) : null
        )
      ))
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 客户端 sessions 服务：暴露 active 会话（SessionSummary.cwd 即工作区路径），
      // 供"仅显示当前会话工作区"过滤与自动切换；不可用时 Panel 退化为显示全部。
      let sessions = undefined
      try { sessions = ctx.get('sessions') } catch (e) { /* 服务不可用 */ }
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
        sessions,
        t: (props && props.t) || makeT('zh'),
      })))
    }

    const plugin = { name: 'bgjobs-client', inject: ['slots'], apply }
    exports.name = plugin.name
    exports.inject = plugin.inject
    exports.apply = plugin.apply
    return module.exports
  },
})
