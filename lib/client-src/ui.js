// bgjobs client — theme & ui atoms & helpers (v0.1.61)
const React = require('react')
const h = React.createElement

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
    const IconSettings = primitives ? primitives.IconSettingsOutline16 : null
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

    // 图标+文字的小按钮（垃圾篓内批量清理用）：hover 高亮，点击不冒泡。
    function MiniBtn({ title, onClick, children }) {
      const [hover, setHover] = React.useState(false)
      return h('span', {
        title,
        onClick: (e) => { e.stopPropagation(); onClick && onClick(e) },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 6px',
          borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
          background: hover ? 'var(--dsw-specific-selector)' : 'transparent',
          color: hover ? 'var(--dsw-alias-label-primary)' : undefined,
        },
      }, children)
    }

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
module.exports = { stateColor, stateLabel, normalizePath, readActiveCwd, PANEL_Z, TOAST_Z, DONE_AGE_MS, GRIP_H, ToastComponent, iconEl, IconTrash, IconClock, IconClose, IconChevronDown, IconChevronRight, IconFolderOpen, IconFolderClose, IconSettings, SelfToast, CtrlBtn, MiniBtn, Toggle, portalBody, clampToViewport }
