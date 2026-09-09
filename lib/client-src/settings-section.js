// bgjobs client — DSH 设置面板「后台任务」section（v0.1.69）
// 注册进 settings.section（root/list，ui-settings-models 同款）。自绘（自上而下）：
//   0) 版本行（GET /bgjobs/gui 的 version 字段，缺失不显示）；
//   1) 「左侧栏显隐按钮」开关（guiPrefs，默认隐藏入口）；
//   2) 「监控面板」开关（monitor，直接显隐右下角浮动面板/悬浮球，与入口开关独立）；
//   3) 「打开离线 GUI」动作行 —— host POST /bgjobs/gui?action=open（schtasks 拉起，脱离宿主 job）；
//   4) 「打开所在文件夹」动作行 —— 优先第一方 POST /open-in-app/open（{app:'explorer',
//      path:<tools 目录>}，与 DSH 右上角同链路），端点不可用才回退 host reveal
//      （powershell Invoke-Item；不用 explorer.exe 直开——实测会堆积 explorer 进程）；
//   5) GUI 脚本路径只读展示。
// 所有动作失败都把宿主错误透出到结果行，绝不静默。原子 UI 尽量复用 primitives（Switch），
// 任一缺失退化为自绘，不白屏。
const React = require('react')
const h = React.createElement
const { makeT } = require('./i18n.js')
const { useGuiPrefsEnabled } = require('./gui-prefs.js')
const { useMonitorVisible } = require('./monitor.js')

let SwitchC = null
try { SwitchC = require('@deepseek-ai/dsh-client-ui-primitives').Switch } catch (e) { /* 退化为自绘 */ }

/** 无 path 依赖的浏览器侧父目录（去掉尾部分隔符后取最后一个 \\ 或 / 之前）。 */
const parentDir = (p) => {
  const s = String(p || '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i > 0 ? s.slice(0, i) : s
}

function SettingsSection({ t, guiPrefs, monitor }) {
  // t 兜底：locale seat 注入或 apply 传入；双重保险防未注入时白屏。
  if (typeof t !== 'function') t = makeT('zh')
  const entryEnabled = useGuiPrefsEnabled(guiPrefs)
  const panelVisible = useMonitorVisible(monitor)
  const [busy, setBusy] = React.useState(false) // 防双击重复触发
  const [guiInfo, setGuiInfo] = React.useState(null) // { path, exists, version } | null
  const [message, setMessage] = React.useState(null) // { ok:boolean, text } | null
  React.useEffect(() => {
    let cancelled = false
    fetch('/bgjobs/gui')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && typeof d.path === 'string') setGuiInfo(d) })
      .catch(() => { /* 信息行缺失不阻塞其余功能 */ })
    return () => { cancelled = true }
  }, [])

  const finish = (ok, key, params) => {
    setMessage({ ok, text: t(key, params) })
    setBusy(false)
  }
  // 本插件宿主动作（open / reveal 回退）
  const callHost = (action) => fetch('/bgjobs/gui?action=' + action, { method: 'POST' })
    .then(async (r) => {
      let d = null
      try { d = await r.json() } catch (e) { /* 空 body */ }
      if (r.ok && d && d.ok) return { ok: true }
      return { ok: false, error: (d && (d.error || d.message)) || ('HTTP ' + r.status) }
    })
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))

  // 打开所在文件夹：优先第一方 open-in-app（与 DSH 右上角同链路，仅收目录）；端点不可用才回退
  // 宿主 reveal（Invoke-Item）。不用 explorer.exe 直开——用户 Win10 实测会堆积 explorer 进程。
  const doReveal = async () => {
    if (busy) return
    if (!guiInfo || !guiInfo.path) { setMessage({ ok: false, text: t('settings.gui.failed', { error: 'gui path missing' }) }); return }
    setBusy(true)
    setMessage(null)
    const dir = parentDir(guiInfo.path)
    let res = null
    try {
      const r = await fetch('/open-in-app/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'explorer', path: dir }),
      })
      const d = await r.json().catch(() => null)
      if (r.ok && d && d.ok !== false) res = { ok: true }
      else res = { ok: false, error: (d && (d.message || d.code)) || ('HTTP ' + r.status) }
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) }
    }
    if (!res.ok) res = await callHost('reveal')
    if (res.ok) finish(true, 'settings.gui.openedReveal')
    else finish(false, 'settings.gui.failed', { error: res.error })
  }

  // 打开离线 GUI：host 直接 spawn（GUI 不在第一方 app 目录，无法走 open-in-app）
  const doOpen = async () => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    const res = await callHost('open')
    if (res.ok) finish(true, 'settings.gui.openedHint')
    else finish(false, 'settings.gui.failed', { error: res.error })
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
  const keyAct = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } }
  return h('div', { style: { padding: '4px 0 8px' } },
    h('div', { style: { fontSize: 18, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } },
      t('settings.title'),
      guiInfo && guiInfo.version ? h('span', { style: { marginLeft: 8, fontSize: 12, opacity: 0.55, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, 'v' + guiInfo.version) : null),
    h('p', { style: { fontSize: 12, opacity: 0.65, margin: '4px 0 12px', color: 'var(--dsw-alias-label-secondary)' } }, t('settings.intro')),
    // 行 1：左侧栏显隐按钮（入口）
    h('div', { style: row },
      h('div', { style: labelCol },
        h('div', { style: labelMain }, t('settings.entryLabel')),
        h('div', { style: labelSub }, t('settings.entryDesc'))),
      SwitchC
        ? h(SwitchC, { checked: entryEnabled, onChange: (v) => guiPrefs && guiPrefs.setEnabled(!!v), label: t('settings.entryLabel') })
        : h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 'none', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
            h('input', { type: 'checkbox', checked: entryEnabled, onChange: (e) => guiPrefs && guiPrefs.setEnabled(e.target.checked) }), entryEnabled ? t('footer.hide') : t('footer.show'))
    ),
    // 行 2：监控面板显隐（直接控制面板/悬浮球）
    h('div', { style: row },
      h('div', { style: labelCol },
        h('div', { style: labelMain }, t('settings.panel')),
        h('div', { style: labelSub }, t('settings.panelDesc'))),
      SwitchC
        ? h(SwitchC, { checked: panelVisible, onChange: (v) => monitor && monitor.setVisible(!!v), label: t('settings.panel') })
        : h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 'none', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
            h('input', { type: 'checkbox', checked: panelVisible, onChange: (e) => monitor && monitor.setVisible(e.target.checked) }), panelVisible ? t('footer.hide') : t('footer.show'))
    ),
    // 行 3：打开离线 GUI
    h('div', { style: row },
      h('div', { style: labelCol },
        h('div', { style: labelMain }, t('settings.gui.open')),
        h('div', { style: labelSub }, t('settings.gui.openDesc'))),
      h('div', { role: 'button', tabIndex: 0, title: t('settings.gui.open'), style: actBtn, onClick: doOpen, onKeyDown: keyAct(doOpen) },
        t('settings.gui.open'))
    ),
    // 行 4：打开所在文件夹（tools 目录；host explorer.exe 直开，v0.1.68）
    h('div', { style: row },
      h('div', { style: labelCol },
        h('div', { style: labelMain }, t('settings.gui.reveal')),
        h('div', { style: labelSub }, t('settings.gui.revealDesc'))),
      h('div', { role: 'button', tabIndex: 0, title: t('settings.gui.reveal'), style: Object.assign({}, actBtn, { background: 'transparent' }), onClick: doReveal, onKeyDown: keyAct(doReveal) },
        t('settings.gui.reveal'))
    ),
    // 行 5：GUI 脚本路径
    guiInfo && guiInfo.path ? h('div', { style: Object.assign({}, row, { paddingTop: 0 }) },
      h('div', { style: labelCol },
        h('div', { style: labelSub }, t('settings.gui.path')),
        h('code', { style: { display: 'block', fontSize: 12, marginTop: 2, wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)' } }, guiInfo.path))) : null,
    message ? h('div', { role: 'status', style: { marginTop: 4, fontSize: 12, opacity: 0.85, color: message.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, message.text) : null,
  )
}

module.exports = { SettingsSection }
