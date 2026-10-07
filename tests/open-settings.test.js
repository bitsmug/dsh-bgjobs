// bgjobs tests —— 齿轮/🗄 按钮打开 DSH 设置面板的定位链（v0.1.93）。
// 被测模块 lib/client-src/open-settings.js 是纯 CJS 且**不 require react** ⇒ 用 createRequire
// 直接加载（同 banner.test.js 的既有模式：node:test 里 import 会把它当 ESM 而拉不起来）。
//
// DOM 用「选择器 → 元素」映射桩（**不引入 jsdom**）：每个用例造一份最小 fake document，
// 只实现本模块真正调用的 surface（querySelector(All) / click / contains / textContent /
// getClientRects / getAttribute / tagName / children）。seam（setOpenSettingsEnv）逐用例成对恢复。
// 判据一律「单引号 + 非子串 + 打印期望值」（`assert.equal` 是全等断言，日志里打印期望/实际）。
//
// 覆盖（计划 §7 八组）：①store 首选路径 ②store 不可用的各降级 ③store 调用成功但面板未出现
// ④账号 launcher 菜单 ⑤no-trigger / notfound ⑥既有兼容分支不回归（data-snav-row / 插件父级 tab）
// ⑦isOpenOk 真值表 ⑧无 document。
//
// v0.1.93 追加（面板其实开了、却弹「未能自动打开设置」）：
// ⑨store 开面板成功但目标分区行缺失 ⇒ 新返回码 opened-no-section（算成功）
// ⑩i18n 新键 settings.open.noSection 中英双字典齐备（渲染文本逐字锁定）
// ⑪panel.js 接线守卫：新码挂新文案键、notfound/no-trigger 仍走旧失败键

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { openBgjobsSettings, isOpenOk, setOpenSettingsEnv, OPENED_NO_SECTION } = require('../lib/client-src/open-settings.js')
const { ZH, EN, makeT } = require('../lib/client-src/i18n.js')
// panel.js 要 require react（bundle 期才有的依赖）⇒ 本文件只读源码做「接线守卫」，不 require 它。
const PANEL_SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client-src', 'panel.js'), 'utf8')

const BGJOBS_LABEL = '后台任务'
const MCP_LABEL = 'MCP 任务'
const CLICKABLE = 'button, [role="tab"], [role="button"], [role="menuitem"], [aria-expanded], summary'

/** 造一个元素桩（visible() 判据 = getClientRects().length 非空 ⇒ 返回一项 = 渲染可见）。 */
function makeElement(tagName, attrs, text) {
  const element = {
    tagName,
    textContent: text === undefined ? '' : text,
    attrs: attrs || {},
    children: [],
    clickCount: 0,
    click: () => { element.clickCount += 1 },   // 用例可覆盖成带副作用的实现
    appendChild: (child) => { element.children.push(child); return child },
    contains: (other) => element.children.indexOf(other) !== -1,
    getAttribute: (name) => (name in element.attrs ? element.attrs[name] : null),
    getClientRects: () => [{}],
    querySelectorAll: (selector) => element.children.filter((child) => child.clickable && matches(child, selector)),
    querySelector: (selector) => element.querySelectorAll(selector)[0] || null,
  }
  return element
}

/** 元素是否匹配单个选择器（只支持被测模块实际用到的那几种形态）。 */
function matches(element, selector) {
  const parts = String(selector).split(',').map((part) => part.trim())
  return parts.some((part) => {
    const withValue = /^([a-zA-Z]*)\[([\w-]+)="([^"]+)"\]$/.exec(part)
    if (withValue) {
      if (withValue[1] && element.tagName.toLowerCase() !== withValue[1].toLowerCase()) return false
      return element.getAttribute(withValue[2]) === withValue[3]
    }
    const exists = /^\[([\w-]+)\]$/.exec(part)
    if (exists) return element.getAttribute(exists[1]) !== null
    if (/^[a-zA-Z]+$/.test(part)) return element.tagName.toLowerCase() === part.toLowerCase()
    return false
  })
}

/**
 * 造一份最小 fake DOM。
 * @param {object} opts.withTrigger  是否渲染官方兜底按钮（aria-haspopup="dialog"），默认 true
 * @param {object} opts.withLauncher 是否渲染账号 launcher（aria-haspopup="menu"），默认 true
 * @param {object} opts.panelOpen    初始面板是否已开，默认 false
 * @param {object} opts.withBgjobsRow 是否渲染顶层「后台任务」导航行，默认 true
 * @param {object} opts.menuLabels   账号菜单两项的文案，默认 ['设置', '个人资料']
 */
function makeFakeDom(opts) {
  const options = opts || {}
  const state = { panelOpen: !!options.panelOpen, menuOpen: false, tabRendered: false }

  const dialog = makeElement('div', { 'data-shortcut-modal': 'settings' }, '设置')
  const trigger = makeElement('button', { 'aria-haspopup': 'dialog' }, '设置')
  const launcher = makeElement('button', { 'aria-haspopup': 'menu' }, '账号')
  const labels = options.menuLabels || ['设置', '个人资料']
  const menuItems = [
    makeElement('button', { role: 'menuitem' }, labels[0]),
    makeElement('button', { role: 'menuitem' }, labels[1]),
  ]
  const rowPlugins = makeElement('button', { 'data-snav-row': 'plugins' }, '插件入口')
  const rowBgjobs = makeElement('button', { 'data-snav-row': 'bgjobs' }, BGJOBS_LABEL)
  const rowBgjobsMcp = makeElement('button', { 'data-snav-row': 'bgjobs-mcp' }, options.mcpLabel === undefined ? MCP_LABEL : options.mcpLabel)
  const tabBgjobs = makeElement('button', { role: 'tab' }, BGJOBS_LABEL)
  const rowByLabel = makeElement('button', null, options.labelOnly === undefined ? BGJOBS_LABEL : options.labelOnly)
  for (const element of [rowPlugins, rowBgjobs, rowBgjobsMcp, rowByLabel]) element.clickable = true
  for (const element of menuItems) element.clickable = true
  if (options.withTab !== false) rowPlugins.appendChild(tabBgjobs)   // 子页签：仅「插件入口」展开后渲染

  // 行为：点触发按钮 ⇒ 面板打开；点 launcher ⇒ 菜单（portal）出现；点菜单项 ⇒ 面板打开。
  trigger.click = () => { trigger.clickCount += 1; state.panelOpen = options.triggerOpens === false ? false : true }
  launcher.click = () => { launcher.clickCount += 1; state.menuOpen = true }
  menuItems[0].click = () => { menuItems[0].clickCount += 1; state.panelOpen = true }
  menuItems[1].click = () => { menuItems[1].clickCount += 1 }
  // 非激活分区的子页签不渲染（SettingsRoot 用 { only: active } 过滤）⇒ 点父级才让子页签进入 DOM。
  rowPlugins.click = () => {
    rowPlugins.clickCount += 1
    if (options.withTab !== false) { state.tabRendered = true; tabBgjobs.clickable = true }
  }

  const rowsInDom = () => [
    rowPlugins,
    options.withBgjobsRow === false ? null : rowBgjobs,
    options.withMcpRow === false ? null : rowBgjobsMcp,
    options.labelOnly === null ? null : rowByLabel,
    state.tabRendered ? tabBgjobs : null,
  ].filter(Boolean)
  const menuInDom = () => (state.menuOpen ? menuItems : [])

  // 面板句柄：显式标记优先，其次通用 modal 角色（两条都要能命中）。
  const dialogInDom = () => (state.panelOpen ? dialog : null)
  const queryTop = (selector) => {
    if (selector === '[data-shortcut-modal="settings"]') return dialogInDom()
    if (selector === '[role="dialog"][aria-modal="true"]') return dialogInDom()
    if (selector.indexOf('data-slot') !== -1 && selector.indexOf('dialog') !== -1) return options.withTrigger === false ? null : trigger
    if (selector.indexOf('data-slot') !== -1 && selector.indexOf('menu') !== -1) return options.withLauncher === false ? null : launcher
    return null
  }
  const queryTopAll = (selector) => {
    if (selector.indexOf('menuitem') !== -1) return menuInDom()
    const one = queryTop(selector)
    return one ? [one] : []
  }
  const queryDialogAll = (selector) => {
    const rows = rowsInDom()
    if (selector.indexOf('data-snav-row') !== -1) return rows.filter((element) => matches(element, selector))
    if (selector === CLICKABLE) return rows
    return rows.filter((element) => matches(element, selector))
  }

  const doc = {
    querySelector: queryTop,
    querySelectorAll: queryTopAll,
  }
  dialog.querySelectorAll = queryDialogAll
  dialog.querySelector = (selector) => queryDialogAll(selector)[0] || null

  return {
    doc, state, dialog, trigger, launcher,
    menuItemSettings: menuItems[0], menuItemOther: menuItems[1],
    rowPlugins, rowBgjobs, rowBgjobsMcp, rowByLabel, tabBgjobs,
  }
}

/** 用例脚手架：装 seam（fake DOM + 假时钟/假 rAF）→ 跑 → 成对恢复。 */
function withFakeEnv(dom, run) {
  setOpenSettingsEnv(() => ({ doc: dom.doc, raf: (cb) => { setTimeout(cb, 0) }, now: () => Date.now() }))
  return Promise.resolve({ dom, state: dom.state })
    .then(run)
    .finally(() => { setOpenSettingsEnv(null) })
}

/** 桩 slots 服务：entries('sidebar.settings') 返回注入的注册项。 */
const slotsWith = (entries) => ({ entries: (name) => (name === 'sidebar.settings' ? entries : []) })
/** 桩注册项：store.create() 由调用方给。 */
const storeEntry = (create) => ({ store: { create } })

// ── ① store 首选路径 ─────────────────────────────────────────────────────────

test('① store 首选路径：openSection 收到分区 id 且面板随之打开 ⇒ api（bgjobs / bgjobs-mcp 各一例）', async () => {
  const dom = makeFakeDom({ withTrigger: false })
  const openedIds = []
  const slots = slotsWith([storeEntry(() => ({ actions: { openSection: (id) => { openedIds.push(id); dom.state.panelOpen = true } } }))])
  await withFakeEnv(dom, async () => {
    const expectedBgjobs = 'bgjobs'
    const expectedMcp = 'bgjobs-mcp'
    const first = await openBgjobsSettings({ label: BGJOBS_LABEL, slots })
    console.log('  [bgjobs]     期望 openSection:', expectedBgjobs, '| 实际:', openedIds[0], '| 期望返回 api 实际:', first)
    assert.equal(openedIds[0], expectedBgjobs)
    assert.equal(first, 'api')
    const second = await openBgjobsSettings({ label: MCP_LABEL, rowId: 'bgjobs-mcp', slots })
    console.log('  [bgjobs-mcp] 期望 openSection:', expectedMcp, '| 实际:', openedIds[1], '| 期望返回 api 实际:', second)
    assert.equal(openedIds[1], expectedMcp)
    assert.equal(second, 'api')
    console.log('  （官方兜底按钮不存在：withTrigger=false，命中数 0；目标行点击：', dom.rowBgjobs.clickCount, '/', dom.rowBgjobsMcp.clickCount, '）')
    assert.equal(dom.rowBgjobs.clickCount, 1)
    assert.equal(dom.rowBgjobsMcp.clickCount, 1)
  })
})

// ── ② store 不可用 → 降级到 DOM 触发按钮 ─────────────────────────────────────

test('② store 不可用（无 slots / 无 entry / 无 store / create 抛错 / openSection 抛错…）⇒ 逐个降级到官方按钮 → section', async () => {
  const cases = [
    ['无 slots', undefined],
    ['slots 无 entries 函数', {}],
    ['entries 抛错', { entries: () => { throw new Error('boom') } }],
    ['无 entry', slotsWith([])],
    ['entry 无 store', slotsWith([{}])],
    ['store 无 create 函数', slotsWith([{ store: {} }])],
    ['create 抛错', slotsWith([storeEntry(() => { throw new Error('boom') })])],
    ['actions 无 openSection', slotsWith([storeEntry(() => ({ actions: {} }))])],
    ['openSection 抛错', slotsWith([storeEntry(() => ({ actions: { openSection: () => { throw new Error('boom') } } }))])],
  ]
  for (const [name, slots] of cases) {
    const dom = makeFakeDom({})
    await withFakeEnv(dom, async () => {
      const expected = 'section'
      const actual = await openBgjobsSettings({ label: BGJOBS_LABEL, slots })
      console.log('  [' + name + '] 期望:', expected, '| 实际:', actual, '| 官方按钮点击:', dom.trigger.clickCount, '| 目标行点击:', dom.rowBgjobs.clickCount)
      assert.equal(actual, expected, name)
      assert.equal(dom.trigger.clickCount, 1, name + '：官方按钮被点了一次')
      assert.equal(dom.rowBgjobs.clickCount, 1, name + '：目标行被点了一次')
    })
  }
})

test('③ store 调用成功但面板未出现（React 未提交 ⇒ 等到超时）⇒ 继续 DOM 兜底 → section', async () => {
  const dom = makeFakeDom({})
  const slots = slotsWith([storeEntry(() => ({ actions: { openSection: () => {} } }))])
  await withFakeEnv(dom, async () => {
    const expected = 'section'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL, slots })
    console.log('  期望:', expected, '| 实际:', actual, '| 官方按钮点击:', dom.trigger.clickCount, '| 目标行点击:', dom.rowBgjobs.clickCount)
    assert.equal(actual, expected)
    assert.equal(dom.trigger.clickCount, 1)
    assert.equal(dom.rowBgjobs.clickCount, 1)
  })
})

// ── ④ 账号 launcher 菜单（官方 fallback 按钮不存在时的真实入口）───────────────

test('④ 仅账号 launcher：点 launcher → 点 portal 出去的「设置」菜单项 → section', async () => {
  const dom = makeFakeDom({ withTrigger: false })
  await withFakeEnv(dom, async () => {
    const expected = 'section'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL })
    console.log('  期望:', expected, '| 实际:', actual, '| launcher 点击:', dom.launcher.clickCount, '| 设置项点击:', dom.menuItemSettings.clickCount, '| 第二项点击:', dom.menuItemOther.clickCount)
    assert.equal(actual, expected)
    assert.equal(dom.launcher.clickCount, 1)
    assert.equal(dom.menuItemSettings.clickCount, 1)
    assert.equal(dom.menuItemOther.clickCount, 0)
    assert.equal(dom.rowBgjobs.clickCount, 1)
  })
})

test('④b 菜单文案对不上 zh/en 候选 ⇒ 退回第一个可用 menuitem（order 里设置恒为第一项）', async () => {
  const dom = makeFakeDom({ withTrigger: false, menuLabels: ['账户中心', '退出登录'] })
  await withFakeEnv(dom, async () => {
    const expected = 'section'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL })
    console.log('  期望:', expected, '| 实际:', actual, '| 第一项点击:', dom.menuItemSettings.clickCount)
    assert.equal(actual, expected)
    assert.equal(dom.menuItemSettings.clickCount, 1)
  })
})

test('④c launcher 与菜单都不存在 ⇒ no-trigger（不抛错、不白屏）', async () => {
  const dom = makeFakeDom({ withTrigger: false, withLauncher: false })
  await withFakeEnv(dom, async () => {
    const expected = 'no-trigger'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL })
    console.log('  期望:', expected, '| 实际:', actual)
    assert.equal(actual, expected)
  })
})

// ── ⑤ 无触发器 / 面板已开但目标行缺失 ────────────────────────────────────────

test('⑤ 面板已开但「后台任务」行与同名文案都没有、父级也没有子页签 ⇒ notfound（面板已开 ⇒ 不弹 no-trigger）', async () => {
  const dom = makeFakeDom({ panelOpen: true, withBgjobsRow: false, labelOnly: null, withTab: false })
  await withFakeEnv(dom, async () => {
    const expected = 'notfound'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL })
    console.log('  期望:', expected, '| 实际:', actual, '| 父级点击:', dom.rowPlugins.clickCount)
    assert.equal(actual, expected)
  })
})

// ── ⑥ 既有兼容分支不回归（守住 §6 保留清单）──────────────────────────────────

test('⑥a 兼容路径：data-snav-row="bgjobs" 命中 ⇒ section（父级未被触碰）', async () => {
  const dom = makeFakeDom({ panelOpen: true })
  await withFakeEnv(dom, async () => {
    const expected = 'section'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL })
    console.log('  期望:', expected, '| 实际:', actual, '| 目标行点击:', dom.rowBgjobs.clickCount, '| 父级点击:', dom.rowPlugins.clickCount)
    assert.equal(actual, expected)
    assert.equal(dom.rowBgjobs.clickCount, 1)
    assert.equal(dom.rowPlugins.clickCount, 0)
  })
})

test('⑥b 兼容路径：顶层无「后台任务」行 ⇒ 展开「插件入口」父级后命中的同名子页签 ⇒ tab', async () => {
  const dom = makeFakeDom({ panelOpen: true, withBgjobsRow: false, labelOnly: null })
  await withFakeEnv(dom, async () => {
    const expected = 'tab'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL })
    console.log('  期望:', expected, '| 实际:', actual, '| 父级点击:', dom.rowPlugins.clickCount, '| tab 点击:', dom.tabBgjobs.clickCount)
    assert.equal(actual, expected)
    assert.equal(dom.rowPlugins.clickCount, 1)
    assert.equal(dom.tabBgjobs.clickCount, 1)
  })
})

test('⑥c 兼容路径：无 data-snav-row 时靠可见文案归一化命中 ⇒ section（MCP 页走 rowId）', async () => {
  const dom = makeFakeDom({ panelOpen: true, withBgjobsRow: false, withMcpRow: false, labelOnly: BGJOBS_LABEL })
  await withFakeEnv(dom, async () => {
    const expected = 'section'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL })
    console.log('  期望:', expected, '| 实际:', actual, '| 文案行点击:', dom.rowByLabel.clickCount)
    assert.equal(actual, expected)
    assert.equal(dom.rowByLabel.clickCount, 1)
  })
})

// ── ⑦ isOpenOk 真值表 ────────────────────────────────────────────────────────

test('⑦ isOpenOk 真值表：api/section/tab/opened-no-section 为真；notfound/no-trigger 及其它为假', () => {
  const expectedTrue = ['api', 'section', 'tab', OPENED_NO_SECTION]
  const expectedFalse = ['notfound', 'no-trigger', undefined, null, '', 'ok']
  console.log('  期望 true :', expectedTrue.join(' / '))
  console.log('  期望 false:', expectedFalse.map(String).join(' / '))
  for (const code of expectedTrue) {
    console.log('  isOpenOk(' + String(code) + ') 期望 true  实际', isOpenOk(code))
    assert.equal(isOpenOk(code), true, String(code))
  }
  for (const code of expectedFalse) {
    console.log('  isOpenOk(' + String(code) + ') 期望 false 实际', isOpenOk(code))
    assert.equal(isOpenOk(code), false, String(code))
  }
})

// ── ⑧ 无 document（Node 环境）────────────────────────────────────────────────

test('⑧ 无 document（恢复生产实现）⇒ no-trigger；无 label 同样 no-trigger（不抛错）', async () => {
  setOpenSettingsEnv(undefined)   // 恢复生产实现：Node 里 typeof document === 'undefined'
  try {
    const expected = 'no-trigger'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL })
    console.log('  期望:', expected, '| 实际:', actual)
    assert.equal(actual, expected)
    const withoutLabel = await openBgjobsSettings({})
    console.log('  无 label 期望:', expected, '| 实际:', withoutLabel)
    assert.equal(withoutLabel, expected)
  } finally {
    setOpenSettingsEnv(null)
  }
})

// ── ⑨ v0.1.93：面板确实开了、只是没定位到目标分区 ⇒ opened-no-section（算成功）────────

test('⑨ store 开面板成功但目标分区行缺失 ⇒ opened-no-section（面板已开 ⇒ 不再弹失败文案）', async () => {
  // 两个入口各一例：齿轮（bgjobs）/ 🗄（bgjobs-mcp）；父级「插件入口」也无同名子页签。
  const cases = [
    ['齿轮 bgjobs', BGJOBS_LABEL, undefined, 'bgjobs', { withBgjobsRow: false }],
    ['🗄 bgjobs-mcp', MCP_LABEL, 'bgjobs-mcp', 'bgjobs-mcp', { withMcpRow: false }],
  ]
  for (const [name, label, rowId, expectedId, domOpts] of cases) {
    const dom = makeFakeDom(Object.assign({ withTrigger: false, labelOnly: null, withTab: false }, domOpts))
    const openedIds = []
    const slots = slotsWith([storeEntry(() => ({ actions: { openSection: (id) => { openedIds.push(id); dom.state.panelOpen = true } } }))])
    await withFakeEnv(dom, async () => {
      const expected = OPENED_NO_SECTION
      const actual = await openBgjobsSettings({ label, rowId, slots })
      console.log('  [' + name + '] 期望:', expected, '| 实际:', actual, '| openSection 收到:', openedIds[0], '| 面板已开:', dom.state.panelOpen, '| 期望该码 isOpenOk:', true, '实际:', isOpenOk(actual))
      assert.equal(actual, expected, name)
      assert.equal(openedIds[0], expectedId, name + '：openSection 收到目标分区 id')
      assert.equal(dom.state.panelOpen, true, name + '：面板确实已打开（主目的达成）')
      assert.equal(isOpenOk(actual), true, name + '：新码必须算成功（否则又弹失败文案）')
      assert.equal(dom.trigger.clickCount, 0, name + '：官方按钮不该被点（store 已开面板）')
    })
  }
})

test('⑨b 未过 store（DOM 兜底开的面板）里目标行缺失 ⇒ 仍是 notfound（旧语义不变）', async () => {
  const dom = makeFakeDom({ withBgjobsRow: false, labelOnly: null, withTab: false })
  await withFakeEnv(dom, async () => {
    const expected = 'notfound'
    const actual = await openBgjobsSettings({ label: BGJOBS_LABEL })
    console.log('  期望:', expected, '| 实际:', actual, '| 期望 isOpenOk:', false, '实际:', isOpenOk(actual), '| 官方按钮点击:', dom.trigger.clickCount)
    assert.equal(actual, expected)
    assert.equal(isOpenOk(actual), false)
    assert.equal(dom.trigger.clickCount, 1)
  })
})

// ── ⑩ v0.1.93：新文案（中英双字典）────────────────────────────────────────────

test('⑩ i18n：settings.open.noSection 中英双字典齐备、{section} 渲染、旧键原样保留', () => {
  const key = 'settings.open.noSection'
  const expectedZh = '设置已打开，但没找到「后台任务」分区（插件可能未加载）——请在设置里手动查找。'
  const expectedEn = 'Settings is open, but the "MCP jobs" section was not found (the plugin may not be loaded) — please look for it manually in Settings.'
  console.log('  期望 zh[' + key + '] =', expectedZh)
  console.log('  期望 en[' + key + '] =', expectedEn)
  const actualZh = makeT('zh')(key, { section: '后台任务' })
  const actualEn = makeT('en')(key, { section: 'MCP jobs' })
  console.log('  实际 zh =', actualZh)
  console.log('  实际 en =', actualEn)
  // 逐字全等：zh 缺键会回退到 en、en 缺键会回退到 zh，两条都能被这条断言抓住。
  assert.equal(actualZh, expectedZh)
  assert.equal(actualEn, expectedEn)
  assert.equal(ZH[key] === EN[key], false, '中英必须是两条不同文案（防复制粘贴漏译）')
  // 旧键仍在（notfound / no-trigger 继续用它）
  const expectedFailedZh = '未能自动打开设置，请在左下角「设置 → 后台任务」查看。'
  const actualFailedZh = makeT('zh')('settings.open.failed')
  console.log('  期望旧键 settings.open.failed（zh）=', expectedFailedZh)
  console.log('  实际旧键（zh）=', actualFailedZh)
  assert.equal(actualFailedZh, expectedFailedZh)
})

// ── ⑪ v0.1.93：panel.js 接线守卫（panel.js 需 react，不能 require ⇒ 读源码断言）──────

test('⑪ panel.js 接线：新码 ⇒ 新文案键（两处调用点）；notfound/no-trigger 仍走旧失败键', () => {
  // 每处调用点：`r === OPENED_NO_SECTION` 紧跟 `t('settings.open.noSection'`。
  const wired = PANEL_SRC.match(/r === OPENED_NO_SECTION[\s\S]{0,160}?t\('settings\.open\.noSection'/g) || []
  const expectedWired = 2
  console.log('  期望「新码 ⇒ 新键」接线处数:', expectedWired, '实际:', wired.length)
  assert.equal(wired.length, expectedWired)
  // 旧闸门必须保留在两处调用点（notfound / no-trigger 继续弹旧文案）。
  const gates = PANEL_SRC.match(/else if \(!isOpenOk\(r\)\)/g) || []
  const expectedGates = 2
  console.log('  期望旧闸门 else if (!isOpenOk(r)) 处数:', expectedGates, '实际:', gates.length)
  assert.equal(gates.length, expectedGates)
  // 旧失败键仍用于非成功码 + 各自 catch 兜底 ⇒ 每处调用点 2 次，共 4 次。
  const failedUses = PANEL_SRC.split("t('settings.open.failed')").length - 1
  const expectedFailedUses = 4
  console.log('  期望 t(\'settings.open.failed\') 出现次数:', expectedFailedUses, '实际:', failedUses)
  assert.equal(failedUses, expectedFailedUses)
  // 目标分区名按各自入口注入（齿轮=后台任务 / 🗄=MCP 任务）。
  const sectionParams = PANEL_SRC.match(/t\('settings\.open\.noSection', \{ section: t\('[^']+'\) \}\)/g) || []
  console.log('  期望「新键带 section 参数」处数:', expectedWired, '实际:', sectionParams.length, '| 命中:', sectionParams.join(' ; '))
  assert.equal(sectionParams.length, expectedWired)
})
