// bgjobs client — DSH 设置面板「后台任务」section（v0.1.65）
// 注册进 settings.section（root/list，ui-settings-models 同款）。自绘三段：
//   1) 开关行：左侧显隐按钮（sidebar.footer.action 入口）显隐；
//   2) 动作行：打开离线 GUI + 打开所在文件夹（host /bgjobs/gui 路由）；
//   3) 路径行：GUI 脚本路径（GET /bgjobs/gui 回显），缓解装完找不到 GUI。
// 全部动作走 fetch 宿主路由，无 ctx.remote 依赖；原子 UI 尽量复用 primitives
// （Switch），任一缺失退化为自绘，不白屏。
const React = require('react')
const h = React.createElement
const { makeT } = require('./i18n.js')
const { useGuiPrefsEnabled } = require('./gui-prefs.js')

let SwitchC = null
try { SwitchC = require('@deepseek-ai/dsh-client-ui-primitives').Switch } catch (e) { /* 退化为自绘 */ }

function SettingsSection({ t, guiPrefs }) {
  // t 兜底：locale seat 注入或 apply 传入；双重保险防未注入时白屏。
  if (typeof t !== 'function') t = makeT('zh')
  const enabled = useGuiPrefsEnabled(guiPrefs)
  const [busy, setBusy] = React.useState(false) // 防双击重复拉起 GUI
  const [guiInfo, setGuiInfo] = React.useState(null) // { path, exists } | null
  const [message, setMessage] = React.useState(null) // { ok:boolean, text } | null
  React.useEffect(() => {
    let cancelled = false
    fetch('/bgjobs/gui')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && typeof d.path === 'string') setGuiInfo(d) })
      .catch(() => { /* 路径展示失败不阻塞其余行 */ })
    return () => { cancelled = true }
  }, [])

  const callGui = (action) => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    fetch('/bgjobs/gui?action=' + action, { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        setMessage({ ok: !!(d && d.ok), text: (d && d.ok)
          ? t('settings.gui.opened')
          : t('settings.gui.failed', { error: String((d && d.error) || 'unknown') }) })
      })
      .catch((e) => { setMessage({ ok: false, text: t('settings.gui.failed', { error: String(e && e.message || e) }) }) })
      .finally(() => setBusy(false))
  }

  const row = { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }
  const labelCol = { flex: '1 1 auto', minWidth: 0 }
  const labelMain = { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary)' }
  const labelSub = { fontSize: 12, opacity: 0.6, marginTop: 2, color: 'var(--dsw-alias-label-secondary)' }
  const actBtn = {
    display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
    padding: '5px 12px', borderRadius: 6, cursor: busy ? 'default' : 'pointer',
    fontSize: 12, opacity: busy ? 0.6 : 1, userSelect: 'none',
    background: 'var(--dsw-specific-selector)', color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
  }
  return h('div', { style: { padding: '4px 0 8px' } },
    h('div', { style: { fontSize: 18, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, t('settings.title')),
    h('p', { style: { fontSize: 12, opacity: 0.65, margin: '4px 0 12px', color: 'var(--dsw-alias-label-secondary)' } }, t('settings.intro')),
    // 行 1：左侧显隐按钮开关
    h('div', { style: row },
      h('div', { style: labelCol },
        h('div', { style: labelMain }, t('settings.entryLabel')),
        h('div', { style: labelSub }, t('settings.entryDesc'))),
      SwitchC
        ? h(SwitchC, { checked: enabled, onChange: (v) => guiPrefs && guiPrefs.setEnabled(!!v), label: t('settings.entryLabel') })
        : h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 'none', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
            h('input', { type: 'checkbox', checked: enabled, onChange: (e) => guiPrefs && guiPrefs.setEnabled(e.target.checked) }), enabled ? t('footer.hide') : t('footer.show'))
    ),
    // 行 2：打开离线 GUI / 打开所在文件夹
    h('div', { style: row },
      h('div', { style: labelCol },
        h('div', { style: labelMain }, t('settings.gui.open')),
        h('div', { style: labelSub }, t('settings.gui.openDesc'))),
      h('div', { role: 'button', tabIndex: 0, title: t('settings.gui.open'), style: actBtn,
        onClick: () => callGui('open'),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); callGui('open') } } },
        t('settings.gui.open')),
      h('div', { role: 'button', tabIndex: 0, title: t('settings.gui.reveal'), style: Object.assign({}, actBtn, { background: 'transparent' }),
        onClick: () => callGui('reveal'),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); callGui('reveal') } } },
        t('settings.gui.reveal'))
    ),
    // 行 3：GUI 脚本路径
    guiInfo && guiInfo.path ? h('div', { style: Object.assign({}, row, { paddingTop: 0 }) },
      h('div', { style: labelCol },
        h('div', { style: labelSub }, t('settings.gui.path')),
        h('code', { style: { display: 'block', fontSize: 12, marginTop: 2, wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)' } }, guiInfo.path))) : null,
    message ? h('div', { role: 'status', style: { marginTop: 4, fontSize: 12, opacity: 0.85, color: message.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, message.text) : null,
  )
}

module.exports = { SettingsSection }
