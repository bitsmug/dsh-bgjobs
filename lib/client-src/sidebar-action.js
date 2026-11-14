// bgjobs client — 左侧栏脚部动作行（v0.1.64，v0.1.65 受设置偏好门控）
// 注册进 sidebar.footer.action（root/list seat，ui-cordis 同款）：宽栏态 = 图标 +
// 文字行；rail（56px）态 = 仅图标。点击切换 monitor store 可见性 → shell.overlay
// 的浮动面板整体隐藏/恢复（display:none 保持挂载，几何/折叠/悬浮球状态不丢）。
// 显隐本身受 DSH 设置偏好（guiPrefs.sidebarEntry）控制：偏好关闭 → 本行不渲染。
const React = require('react')
const h = React.createElement
const { makeT } = require('./i18n.js')
const { iconEl, IconClock } = require('./ui.js')
const { useMonitorVisible } = require('./monitor.js')
const { useGuiPrefsEnabled } = require('./gui-prefs.js')

function BgjobsSidebarAction({ wide, monitor, prefs, t }) {
  // t 兜底：locale seat 注入或调用方传入；双重保险防未注入时白屏。
  if (typeof t !== 'function') t = makeT('zh')
  const visible = useMonitorVisible(monitor)
  const enabled = useGuiPrefsEnabled(prefs) // 设置页「左侧显隐按钮」开关
  const [hover, setHover] = React.useState(false)
  // 偏好关闭 → 行不渲染（list occupant 保留、空渲染；设置页打开开关后即时出现）。
  if (!enabled) return null
  const title = visible ? t('footer.hide') : t('footer.show')
  // rail 态无文案，仅居中方块；宽栏态为图标 + 标签行。样式对齐脚部同排动作
  // （ui-cordis / 设置行观感）：hover 高亮用 --dsw-specific-selector。
  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 8,
    flex: 'none',
    cursor: 'pointer',
    borderRadius: 6,
    userSelect: 'none',
    background: hover ? 'var(--dsw-specific-selector)' : 'transparent',
    color: 'var(--dsw-alias-label-primary)',
  }
  if (wide) { rowStyle.height = 34; rowStyle.padding = '0 10px' } else { rowStyle.width = 34; rowStyle.height = 34; rowStyle.padding = 0 }
  return h('div', {
    role: 'button',
    tabIndex: 0,
    title,
    'aria-label': title,
    'aria-expanded': visible,
    onClick: () => { if (monitor) monitor.toggle() },
    onKeyDown: (e) => { if (monitor && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); monitor.toggle() } },
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: rowStyle,
  },
    h('span', { style: { display: 'inline-flex', flex: 'none' } }, iconEl(IconClock, '⏱', 14)),
    wide ? h('span', { style: { fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, t('footer.label')) : null,
  )
}

module.exports = { BgjobsSidebarAction }
