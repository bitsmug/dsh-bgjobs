// bgjobs client — 设置页「MCP 任务」区块（总开关 + server 登记 + 从 DSH 导入）。
// 三块（自上而下）：
//   1) MCP 任务总开关（默认关闭；host POST /bgjobs/mcpprefs）——关闭时 agent 侧
//      bgjob_submit_mcp / bgjob_mcp_tools 一律拒绝（与 DSH 一致：会话访问模式不限制 MCP）；
//   2) MCP 服务器登记区：列出已登记 server（transport/目标/预热状态/工具数）+ 每行「预热」开关、
//      「列出工具」（展开工具名，点击可复制）、「删除」，以及新增/覆盖表单（名字 + JSON 配置）；
//   3) 「从 DSH 导入」：显示当前 profile 与判定来源，选范围（当前 profile / 全局 / 其它 profile）
//      列出 DSH 的 @deepseek-ai/dsh-mcp-client 条目，逐条或全部导入成 bgjobs 登记（不改 DSH 配置）。
// 失败一律透出到结果行，绝不静默；原子 UI 复用 primitives（Switch），缺失退化为 checkbox。
const React = require('react')
const h = React.createElement
const { makeT } = require('./i18n.js')

let SwitchC = null
try { SwitchC = require('@deepseek-ai/dsh-client-ui-primitives').Switch } catch (e) { /* 退化为自绘 */ }

const getJson = (url) => fetch(url).then((r) => r.json())
const postJson = (url, body) => fetch(url, {
  method: 'POST',
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
}).then((r) => r.json().catch(() => null))

/** 复制到剪贴板（失败静默：仅提示性功能）。 */
const copyText = (text) => {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(text)
  } catch (e) { /* 忽略 */ }
}

function McpSettings({ t }) {
  if (typeof t !== 'function') t = makeT('zh')
  const [enabled, setEnabled] = React.useState(null) // null = 未加载
  const [servers, setServers] = React.useState(null)
  const [dsh, setDsh] = React.useState(null)
  const [scope, setScope] = React.useState('active') // 'active' | 'global' | <profileName>
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState(null) // { ok, text }
  const [tools, setTools] = React.useState({}) // name → { tools, source, channel } | { error }
  const [formName, setFormName] = React.useState('')
  const [formConfig, setFormConfig] = React.useState('')
  const [copied, setCopied] = React.useState('')

  const reloadServers = () => getJson('/bgjobs/mcpservers')
    .then((d) => { if (d && d.ok) setServers(d.servers || []) })
    .catch(() => { /* 列表缺失不阻塞开关 */ })
  const reloadDsh = () => getJson('/bgjobs/dsh-mcp?all=1')
    .then((d) => { if (d && d.ok) setDsh(d) })
    .catch(() => { /* DSH 配置不可读不阻塞其它功能 */ })

  React.useEffect(() => {
    let cancelled = false
    getJson('/bgjobs/mcpprefs')
      .then((d) => { if (!cancelled && d) setEnabled(d.enabled === true) })
      .catch(() => {})
    reloadServers()
    reloadDsh()
    return () => { cancelled = true }
  }, [])

  const act = async (fn) => {
    if (busy) return
    setBusy(true)
    setMsg(null)
    try { await fn() } finally { setBusy(false) }
  }

  const doToggle = (next) => act(async () => {
    const d = await postJson('/bgjobs/mcpprefs?enabled=' + (next ? '1' : '0'))
    if (d && d.ok) {
      setEnabled(d.enabled === true)
      setMsg({ ok: true, text: d.enabled ? t('settings.mcp.on') : t('settings.mcp.off') })
    } else {
      setMsg({ ok: false, text: t('settings.mcp.failed', { error: (d && d.error) || 'HTTP' }) })
    }
  })

  const doSave = () => act(async () => {
    const name = formName.trim()
    if (!name) { setMsg({ ok: false, text: t('settings.mcp.nameRequired') }); return }
    let config = null
    try { config = JSON.parse(formConfig) } catch (e) { config = null }
    if (config === null || typeof config !== 'object') {
      setMsg({ ok: false, text: t('settings.mcp.saveFailed', { error: 'config must be a JSON object' }) })
      return
    }
    const d = await postJson('/bgjobs/mcpservers', { name, config })
    if (d && d.ok) {
      setMsg({ ok: true, text: t('settings.mcp.saved', { name: d.name }) })
      setFormConfig('')
      await reloadServers()
    } else {
      setMsg({ ok: false, text: t('settings.mcp.saveFailed', { error: (d && d.error) || 'HTTP' }) })
    }
  })

  const doPrewarm = (name, on) => act(async () => {
    const d = await postJson('/bgjobs/mcpservers?name=' + encodeURIComponent(name) + '&prewarm=' + (on ? '1' : '0'))
    if (d && d.ok) await reloadServers()
    else setMsg({ ok: false, text: t('settings.mcp.failed', { error: (d && d.error) || 'HTTP' }) })
  })

  const doDelete = (name) => act(async () => {
    const d = await postJson('/bgjobs/mcpservers?name=' + encodeURIComponent(name) + '&delete=1')
    if (d && d.ok) {
      setMsg({ ok: true, text: t('settings.mcp.deleted', { name }) })
      await reloadServers()
    } else {
      setMsg({ ok: false, text: t('settings.mcp.failed', { error: (d && d.error) || 'HTTP' }) })
    }
  })

  const doProbe = (name) => act(async () => {
    const d = await postJson('/bgjobs/mcpservers?name=' + encodeURIComponent(name) + '&probe=1')
    if (d && d.ok) {
      setTools((prev) => ({ ...prev, [name]: { tools: d.tools || [], source: d.source, channel: d.channel } }))
    } else {
      const error = (d && d.error) || 'HTTP'
      setTools((prev) => ({ ...prev, [name]: { error } }))
      setMsg({ ok: false, text: t('settings.mcp.toolsFailed', { error }) })
    }
  })

  const doImport = (name) => act(async () => {
    const scopeParam = scope === 'active' ? 'active' : (scope === 'global' ? 'global' : 'profile:' + scope)
    const url = '/bgjobs/dsh-mcp?action=import&scope=' + encodeURIComponent(scopeParam) + '&name=' + encodeURIComponent(name)
    const d = await postJson(url)
    if (!d || !d.ok) {
      setMsg({ ok: false, text: t('settings.dsh.importFailed', { error: (d && d.error) || 'HTTP' }) })
      return
    }
    const parts = []
    if (d.imported.length > 0) parts.push(t('settings.dsh.imported', { names: d.imported.join(', ') }))
    if (d.skipped.length > 0) parts.push(t('settings.dsh.skipped', { names: d.skipped.map((s) => s.name).join(', ') }))
    if (d.rejected.length > 0) parts.push(t('settings.dsh.rejected', { names: d.rejected.map((s) => s.name).join(', ') }))
    setMsg({ ok: d.imported.length > 0, text: parts.join(' · ') || t('settings.dsh.none') })
    await reloadServers()
    await reloadDsh()
  })

  const labelMain = { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary)' }
  const labelSub = { fontSize: 12, opacity: 0.6, marginTop: 2, color: 'var(--dsw-alias-label-secondary)' }
  const block = { padding: '10px 0 4px', borderTop: '1px solid var(--dsw-alias-border-l1)' }
  const actBtn = {
    display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
    padding: '4px 10px', borderRadius: 6, cursor: busy ? 'default' : 'pointer',
    fontSize: 12, opacity: busy ? 0.6 : 1, userSelect: 'none',
    background: 'var(--dsw-specific-selector)', color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
  }
  const ghostBtn = Object.assign({}, actBtn, { background: 'transparent' })
  const keyAct = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } }
  const srvRow = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderTop: '1px dashed var(--dsw-alias-border-l1)' }
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, wordBreak: 'break-all' }
  const input = {
    fontSize: 12, padding: '4px 8px', borderRadius: 6, color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)',
  }
  const btn = (key, label, fn, style) => h('div', {
    key, role: 'button', tabIndex: 0, title: label, style: style || actBtn, onClick: fn, onKeyDown: keyAct(fn),
  }, label)
  const switchEl = (checked, onChange, label) => (SwitchC
    ? h(SwitchC, { checked, onChange, label })
    : h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 'none', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
        h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) })))

  const currentScopeData = (() => {
    if (!dsh) return null
    const scopeName = scope === 'active' ? dsh.activeProfile : (scope === 'global' ? 'global' : scope)
    if (!scopeName) return null
    const hit = (dsh.scopes || []).find((s) => s.scope === scopeName)
    return hit || null
  })()
  const existing = new Set((dsh && dsh.existing) || [])

  return h('div', { style: block },
    h('div', { style: labelMain }, t('settings.mcp.switchTitle')),
    h('div', { style: labelSub }, t('settings.mcp.switchDesc')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0 2px' } },
      switchEl(enabled === true, doToggle, t('settings.mcp.switchTitle')),
      h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, enabled === true ? t('settings.mcp.on') : t('settings.mcp.off'))),

    // ── server 登记区 ──
    h('div', { style: block },
      h('div', { style: labelMain }, t('settings.mcp.servers')),
      h('div', { style: labelSub }, t('settings.mcp.serversDesc')),
      servers === null ? null : (servers.length === 0
        ? h('div', { style: Object.assign({}, labelSub, { padding: '6px 0' }) }, t('settings.mcp.empty'))
        : servers.map((s) => h('div', { key: s.name, style: srvRow },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                s.name,
                h('span', { style: { marginLeft: 6, fontWeight: 400, opacity: 0.6 } }, '· ' + s.transport),
                s.warm ? h('span', { style: { marginLeft: 6, fontWeight: 400, color: 'var(--dsw-alias-state-success-primary)' } }, t('settings.mcp.warm')) : null,
                s.toolCount !== null && s.toolCount !== undefined
                  ? h('span', { style: { marginLeft: 6, fontWeight: 400, opacity: 0.6 } }, t('settings.mcp.toolsCount', { count: s.toolCount, source: s.toolSource || '-' }))
                  : null),
              h('div', { style: Object.assign({}, mono, { opacity: 0.7, marginTop: 2 }) }, s.target || '-'),
              (s.envKeys && s.envKeys.length > 0) ? h('div', { style: Object.assign({}, mono, { opacity: 0.5 }) }, 'env: ' + s.envKeys.join(', ')) : null,
              (s.headerKeys && s.headerKeys.length > 0) ? h('div', { style: Object.assign({}, mono, { opacity: 0.5 }) }, 'headers: ' + s.headerKeys.join(', ')) : null,
              s.lastError ? h('div', { style: { fontSize: 11, marginTop: 2, color: 'var(--dsw-alias-state-error-primary)' } }, s.lastError) : null,
              tools[s.name] ? h('div', { style: { marginTop: 4 } },
                tools[s.name].error
                  ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, t('settings.mcp.toolsFailed', { error: tools[s.name].error }))
                  : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                      (tools[s.name].tools || []).map((tool) => h('span', {
                        key: tool.name, role: 'button', tabIndex: 0, title: t('settings.mcp.copyTool') + '：' + tool.name + (tool.description ? ' — ' + tool.description : ''),
                        style: Object.assign({}, mono, { padding: '1px 6px', borderRadius: 4, cursor: 'pointer', background: 'var(--dsw-specific-selector)' }),
                        onClick: () => { copyText(tool.name); setCopied(tool.name) },
                        onKeyDown: keyAct(() => { copyText(tool.name); setCopied(tool.name) }),
                      }, tool.name))),
                copied && (tools[s.name].tools || []).some((x) => x.name === copied)
                  ? h('div', { style: { fontSize: 11, marginTop: 2, color: 'var(--dsw-alias-state-success-primary)' } }, t('settings.mcp.copied', { name: copied }))
                  : null) : null),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 'none', alignItems: 'flex-end' } },
              switchEl(s.prewarm === true, (v) => doPrewarm(s.name, v), t('settings.mcp.prewarm')),
              btn('list', t('settings.mcp.listTools'), () => doProbe(s.name), ghostBtn),
              btn('del', t('settings.mcp.delete'), () => doDelete(s.name), ghostBtn))))),
      // 新增/覆盖表单
      h('div', { style: { marginTop: 8 } },
        h('div', { style: Object.assign({}, labelSub, { fontWeight: 600 }) }, t('settings.mcp.add')),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' } },
          h('input', {
            style: Object.assign({}, input, { flex: '0 0 160px' }),
            placeholder: t('settings.mcp.namePlaceholder'),
            value: formName,
            onChange: (e) => setFormName(e.target.value),
          }),
          h('input', {
            style: Object.assign({}, input, { flex: '1 1 320px' }),
            placeholder: t('settings.mcp.configPlaceholder'),
            value: formConfig,
            onChange: (e) => setFormConfig(e.target.value),
          }),
          btn('save', t('settings.mcp.save'), doSave)))),

    // ── 从 DSH 导入 ──
    h('div', { style: block },
      h('div', { style: labelMain }, t('settings.dsh.title')),
      h('div', { style: labelSub }, dsh === null
        ? t('settings.dsh.loading')
        : (dsh.activeProfile
            ? t('settings.dsh.profile', { name: dsh.activeProfile, by: dsh.detectedBy })
            : t('settings.dsh.profileUnknown', { reason: dsh.reason || '-' }))),
      dsh === null ? null : h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
        h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('settings.dsh.scope')),
        h('select', {
          style: Object.assign({}, input, { minWidth: 160 }),
          value: scope,
          onChange: (e) => setScope(e.target.value),
        }, [
          h('option', { key: 'active', value: 'active' }, t('settings.dsh.scopeActive') + (dsh.activeProfile ? '（' + dsh.activeProfile + '）' : '')),
          h('option', { key: 'global', value: 'global' }, t('settings.dsh.scopeGlobal')),
          ...(dsh.profiles || []).filter((p) => p !== dsh.activeProfile).map((p) => h('option', { key: p, value: p }, 'profile：' + p)),
        ]),
        btn('all', t('settings.dsh.importAll'), () => doImport('*'), ghostBtn)),
      dsh === null ? null : (currentScopeData === null
        ? h('div', { style: Object.assign({}, labelSub, { padding: '6px 0' }) }, t('settings.dsh.unavailable'))
        : (currentScopeData.exists === false
            ? h('div', { style: Object.assign({}, labelSub, { padding: '6px 0' }) }, t('settings.dsh.noFile'))
            : ((currentScopeData.servers || []).length === 0
                ? h('div', { style: Object.assign({}, labelSub, { padding: '6px 0' }) }, t('settings.dsh.none'))
                : (currentScopeData.servers || []).map((s) => h('div', { key: s.serverName, style: srvRow },
                    h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                      h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                        s.serverName,
                        h('span', { style: { marginLeft: 6, fontWeight: 400, opacity: 0.6 } }, '· ' + s.transport),
                        s.enabled === false ? h('span', { style: { marginLeft: 6, fontWeight: 400, opacity: 0.6 } }, t('settings.dsh.disabled')) : null,
                        existing.has(s.serverName) ? h('span', { style: { marginLeft: 6, fontWeight: 400, color: 'var(--dsw-alias-state-success-primary)' } }, t('settings.dsh.registered')) : null),
                      h('div', { style: Object.assign({}, mono, { opacity: 0.7, marginTop: 2 }) }, s.transport === 'stdio' ? String((s.config && s.config.command) || '') : String((s.config && s.config.url) || '')),
                      s.needsAttention ? h('div', { style: { fontSize: 11, marginTop: 2, color: 'var(--dsw-alias-state-error-primary)' } }, t('settings.dsh.needsAttention')) : null),
                    h('div', { style: { flex: 'none' } },
                      btn('import', t('settings.dsh.import'), () => doImport(s.serverName), ghostBtn))))))),
      h('div', { style: Object.assign({}, labelSub, { marginTop: 4 }) }, t('settings.dsh.hint'))),

    msg ? h('div', {
      role: 'status',
      style: { marginTop: 6, fontSize: 12, color: msg.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' },
    }, msg.text) : null,
  )
}

module.exports = { McpSettings }
