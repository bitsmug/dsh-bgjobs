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
// 设计取舍：MCP 相关配置（开关 / server 登记 / 导入导出）已拆到**独立页**「MCP 任务」
// （见 mcp-section.js + apply.js 的第二个 settings.section 注册），避免本页过长。
// 所有动作失败都把宿主错误透出到结果行，绝不静默。原子 UI 尽量复用 primitives（Switch），
// 任一缺失退化为自绘，不白屏。
const React = require('react')
const h = React.createElement
const { makeT } = require('./i18n.js')
const { useGuiPrefsEnabled, useGuiPrefsDisplay, useGuiPrefsElements } = require('./gui-prefs.js')
const { useMonitorVisible } = require('./monitor.js')

// 「字段显示」可配置字段（与 host store.js 的 DISPLAY_FIELDS 顺序一致）。
const DISPLAY_FIELD_KEYS = ['id', 'name', 'status', 'exitCode', 'workdir', 'command', 'createdAt', 'finishedAt']
const DISPLAY_VALUE_KEYS = ['list', 'detail', 'hidden']
// 「界面元素」显隐（与 host store.js 的 ELEMENT_KEYS 一致）。
const ELEMENT_KEYS = ['settingsButton', 'mcpSettingsButton', 'onlySession', 'fullAccess', 'groupHeader', 'notify']

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
  // 字段显示：当前配置（订阅生效）+ 页签 + 恢复结果提示。
  const display = useGuiPrefsDisplay(guiPrefs)
  const elements = useGuiPrefsElements(guiPrefs)
  const [displayTab, setDisplayTab] = React.useState('custom') // 'custom' | 'default'
  const [resetMsg, setResetMsg] = React.useState('')
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
  // 字段显示：三态分段控件 / 选项卡样式（选中态高亮）。
  const segStyle = (active) => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 40, padding: '3px 8px', borderRadius: 6, cursor: 'pointer', userSelect: 'none', fontSize: 12,
    border: '1px solid ' + (active ? 'transparent' : 'var(--dsw-alias-border-l2)'),
    background: active ? 'var(--dsw-specific-selector)' : 'transparent',
    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
    fontWeight: active ? 600 : 400,
  })
  const tabStyle = (active) => ({
    display: 'inline-flex', alignItems: 'center', padding: '4px 12px', borderRadius: 6,
    cursor: 'pointer', userSelect: 'none', fontSize: 12, marginRight: 6,
    border: '1px solid ' + (active ? 'var(--dsw-alias-border-l2)' : 'transparent'),
    background: active ? 'var(--dsw-specific-selector)' : 'transparent',
    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
    fontWeight: active ? 600 : 400,
  })
  const curDisplay = display || {}
  const curElements = elements || {}
  const defaultDisplay = (guiPrefs && typeof guiPrefs.getDefaultDisplay === 'function') ? guiPrefs.getDefaultDisplay() : {}
  const defaultElements = (guiPrefs && typeof guiPrefs.getDefaultElements === 'function') ? guiPrefs.getDefaultElements() : {}
  const doResetDisplay = () => {
    if (guiPrefs && typeof guiPrefs.resetDisplay === 'function') guiPrefs.resetDisplay()
    setResetMsg(t('settings.display.resetDone'))
  }
  // 单个字段行：左侧字段名 + 右侧三态分段（列表/详情/隐藏）。
  const fldRow = (f) => {
    const segments = DISPLAY_VALUE_KEYS.map((v) => h('div', {
      key: v, role: 'button', tabIndex: 0, title: t('display.' + v), style: segStyle(curDisplay[f] === v),
      onClick: () => { guiPrefs && guiPrefs.setDisplayField(f, v) },
      onKeyDown: keyAct(() => { guiPrefs && guiPrefs.setDisplayField(f, v) }),
    }, t('display.' + v)))
    return h('div', { key: f, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' } },
      h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, t('field.' + f)),
      h('div', { style: { display: 'flex', gap: 4, flex: 'none' } }, segments))
  }
  // 单个界面元素行：左侧元素名 + 右侧两态分段（显示/隐藏）。
  const elemRow = (k) => {
    const visible = curElements[k] !== false
    const seg = (val, label) => h('div', {
      key: String(val), role: 'button', tabIndex: 0, title: label, style: segStyle(visible === val),
      onClick: () => { guiPrefs && guiPrefs.setElement(k, val) },
      onKeyDown: keyAct(() => { guiPrefs && guiPrefs.setElement(k, val) }),
    }, label)
    return h('div', { key: k, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' } },
      h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, t('element.' + k)),
      h('div', { style: { display: 'flex', gap: 4, flex: 'none' } }, [seg(true, t('display.show')), seg(false, t('display.hidden'))]))
  }
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
    // 行 2.5：字段显示（选项卡：自定义配置 / 默认配置 + 一键恢复）
    h('div', { style: { padding: '10px 0 4px', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
      h('div', { style: labelMain }, t('settings.display.title')),
      h('div', { style: labelSub }, t('settings.display.desc')),
      h('div', { style: { display: 'flex', alignItems: 'center', margin: '8px 0 2px' } },
        h('div', { role: 'tab', tabIndex: 0, 'aria-selected': displayTab === 'custom', title: t('settings.display.tab.custom'), style: tabStyle(displayTab === 'custom'), onClick: () => setDisplayTab('custom'), onKeyDown: keyAct(() => setDisplayTab('custom')) }, t('settings.display.tab.custom')),
        h('div', { role: 'tab', tabIndex: 0, 'aria-selected': displayTab === 'default', title: t('settings.display.tab.default'), style: tabStyle(displayTab === 'default'), onClick: () => setDisplayTab('default'), onKeyDown: keyAct(() => setDisplayTab('default')) }, t('settings.display.tab.default'))),
      displayTab === 'custom'
        ? h('div', null,
            h('div', { style: Object.assign({}, labelSub, { margin: '6px 0 2px', fontWeight: 600 }) }, t('settings.display.fieldsLabel')),
            DISPLAY_FIELD_KEYS.map((f) => fldRow(f)),
            h('div', { style: Object.assign({}, labelSub, { margin: '10px 0 2px', fontWeight: 600 }) }, t('settings.display.elementsLabel')),
            ELEMENT_KEYS.map((k) => elemRow(k)))
        : h('div', null,
            h('div', { style: Object.assign({}, labelSub, { margin: '8px 0' }) }, t('settings.display.defaultDesc')),
            h('div', { style: Object.assign({}, labelSub, { margin: '6px 0 2px', fontWeight: 600 }) }, t('settings.display.fieldsLabel')),
            DISPLAY_FIELD_KEYS.map((f) => h('div', { key: f, style: { display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 12 } },
              h('span', { style: { opacity: 0.75, color: 'var(--dsw-alias-label-secondary)' } }, t('field.' + f)),
              h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('display.' + (defaultDisplay[f] || 'hidden'))))),
            h('div', { style: Object.assign({}, labelSub, { margin: '10px 0 2px', fontWeight: 600 }) }, t('settings.display.elementsLabel')),
            ELEMENT_KEYS.map((k) => h('div', { key: k, style: { display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 12 } },
              h('span', { style: { opacity: 0.75, color: 'var(--dsw-alias-label-secondary)' } }, t('element.' + k)),
              h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, t(defaultElements[k] === false ? 'display.hidden' : 'display.show')))),
            h('div', { role: 'button', tabIndex: 0, title: t('settings.display.reset'), style: Object.assign({}, actBtn, { marginTop: 8 }), onClick: doResetDisplay, onKeyDown: keyAct(doResetDisplay) }, t('settings.display.reset')),
            resetMsg ? h('div', { role: 'status', style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' } }, resetMsg) : null)
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
