// bgjobs client — 打开 DSH 设置面板并定位到本插件的设置分区（齿轮按钮用）。
//
// 背景（已核对 deepseek-harness 源码，与已安装版本一致）：
//   - 设置面板的开合是 ui-settings-general 的 SettingsRoot 组件内部 useState
//     （SettingsRoot.tsx `const [open, setOpen] = useState(false)`），既不注册 store，
//     也没有对外暴露服务；客户端无 router / hash 路由 / CustomEvent / postMessage，
//     故**不存在公开 API** 能让插件主动打开设置。
//   - 唯一可靠入口 = 点击第一方渲染的触发按钮：
//       `[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]`
//     `[data-slot]` 锚点由 ui-renderer 明确承诺为稳定 seam
//     （scoped-slots.tsx: "Anchor contract: every slot render site exposes a stable
//      [data-slot="<key>"] wrapper")，`aria-haspopup="dialog"` 是该按钮自身语义。
//   - 导航行是扁平的 `settings.section` 投影（shell-contract SettingsSectionRow
//     = { id, order, label }，无 children），每行一个 `<button>`。
//   - 但「插件」分区（ui-settings-plugins，id='plugins'，label=插件/Plugins）专门声明
//     子座位 `settings.plugins.tab`，把每个贡献渲染成 `role="tab"` 按钮；其源码注释
//     说明插件设置应作为它的子页签出现（"feature plugins contribute pages without
//     competing for Settings nav rows"）。因此本插件设置也可能被收进「插件」里。
//   - 非激活分区的子页签不渲染（SettingsRoot 用 { only: active } 过滤）→ 若本插件
//     在「插件」里，必须先点「插件」行，同名页签才会出现。
//
// 因此本模块按「顶层导航命中优先 → 否则展开『插件』父级再找同名页签」的顺序定位，
// 失败时返回状态码由调用方提示（绝不抛错/白屏）。
//
// v0.1.93 增补（症状：齿轮按钮恒弹「未能自动打开设置」toast）：
//   - 根因：`settings.launcher` 是 **single slot**，被 `ui-settings-account` **无条件占用**
//     （ui-settings-account/src/client/index.ts）：账号 launcher 自己的按钮是
//     `aria-haspopup="menu"`，官方「设置」按钮（`aria-haspopup="dialog"`）只是它的
//     **fallback**、根本不会渲染 ⇒ 下述 TRIGGER_SELECTOR 恒不命中。
//   - 修法（三层，**只加不删**）：⓪ 首选 = 经 `sidebar.settings` 注册的 slot store 调
//     `openSection(rowId)`；① 兜底 A = 点账号 launcher 再点其菜单里的「设置」项；
//     ② 兜底 B = 原有的 DOM 导航链（本文件下半部分原样保留）。
//
// v0.1.93 增补（症状：面板其实已经开了，toast 却说「未能自动打开设置」——文案与事实不符）：
//   - 根因：⓪ 走通（面板被 `openSection` 打开）但 `locateSection` 没找到本插件分区行时，
//     旧代码返回 `notfound` ⇒ `isOpenOk` 判失败 ⇒ 弹 `settings.open.failed`。可此时
//     「打开设置」这个**主目的已经达成**，渲染只是回退到首行（shell 既有行为）。
//   - 修法：新增返回码 `opened-no-section`（面板已开、只是没定位到分区），并入 `OPEN_OK`
//     ⇒ 不再弹失败文案；调用方改弹 `settings.open.noSection`（说明「设置已打开，但没找到
//     分区」并给出可能原因）。既有 `api`/`section`/`tab`/`notfound`/`no-trigger` 语义未动，
//     既有定位分支一个未删。

/**
 * 测试注入缝：DOM / rAF / 时钟（照仓库既有 `setXxx` seam 风格，便于 Node 单测）。
 * 传 `null`/不传 ⇒ 恢复生产实现。
 */
let envResolver = null   // null ⇒ 用 defaultEnv（生产实现）
function setOpenSettingsEnv(fn) { envResolver = (typeof fn === 'function' ? fn : null) }
const defaultEnv = () => ({
  doc: (typeof document === 'undefined' ? null : document),
  raf: (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16)),
  now: () => Date.now(),
})
const openSettingsEnv = () => (envResolver || defaultEnv)() || {}

/** 第一方设置触发按钮（官方稳定锚点 + 自身语义）。 */
const TRIGGER_SELECTOR = '[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]'
/**
 * 账号 launcher 的触发按钮（`settings.launcher` 被 ui-settings-account 占用时的真实入口）。
 * 它自身是 `aria-haspopup="menu"`，「设置」是它的**菜单项**之一（恒为第一项）。
 */
const LAUNCHER_SELECTOR = '[data-slot="sidebar.settings"] button[aria-haspopup="menu"]'
/**
 * 菜单项触发选择器。菜单是 `<Menu … portal …>` 渲染的 ⇒ 菜单项**不在** `sidebar.settings`
 * 子树内，必须在 **document** 上找。
 */
const MENU_ITEM_SELECTOR = 'button[role="menuitem"], [role="menuitem"]'
/** 账号菜单里「设置」项的文案候选（对不上时退回第一个可用 menuitem）。 */
const SETTINGS_ITEM_LABELS = ['设置', 'Settings', '偏好设置', 'Preferences']
/**
 * 本插件设置分区的注册 id（apply.js 里 `settings.section` 的 `id: 'bgjobs'`）。
 * 实测已安装版把分区 id 渲染成 `data-snav-row="<id>"`（如 `data-snav-row="plugins"`），
 * 因此优先按 id 精确定位——比文案匹配稳得多。
 */
const TARGET_ROW_ID = 'bgjobs'
/**
 * 「插件入口」父级候选：优先按 id（实测 `data-snav-row="plugins"`），其次按归一化文案。
 * 文案可能带数量后缀与展开箭头（`插件入口 (11)▾`），故匹配走 normalizeLabel。
 */
const PARENTS = [
  { id: 'plugins', label: '插件入口' },
  { id: null, label: '插件' },
  { id: null, label: 'Plugins' },
  { id: null, label: 'Plugin entry' },
]
/**
 * 面板内可点击候选：导航行是 button，插件子页签是 role="tab"；
 * 另含 `[aria-expanded]`/`summary`，以覆盖展开/折叠头不是 <button> 的实现。
 */
const CLICKABLE = 'button, [role="tab"], [role="button"], [role="menuitem"], [aria-expanded], summary'
/** React 提交后才更新 DOM：等待条件成立的上限（毫秒，含展开动画余量）。 */
const WAIT_MS = 1500

const visible = (el) => !!(el && el.getClientRects && el.getClientRects().length)
const textOf = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '')
/** CSS 属性选择器值转义（id 一般简单，防御性处理引号/反斜杠）。 */
const attrEscape = (s) => String(s || '').replace(/["\\]/g, '\\$&')
/**
 * 归一化可见文案后再比较，容忍导航行的两种干扰：
 *   1) 装饰字形（展开箭头）：`插件入口 (11)▾` → 去 `▾`；
 *   2) 动态数量后缀：`插件入口 (11)` → 去 `(11)`。
 * 因此不能做严格全等比较。
 */
const DECOR = /[▾▸◂▴▲▼◀▶^›»‹«]/g
const normalizeLabel = (s) => String(s || '')
  .replace(DECOR, '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\s*[(（]\s*\d+\s*[)）]\s*$/, '')
  .trim()
/**
 * 设置面板句柄：**先认显式标记**，再回退原选择器（新增，不改旧行为）。
 * `data-shortcut-modal="settings"` 是设置面板 div 上的显式标记（SettingsRoot.tsx），
 * 比 `[role="dialog"][aria-modal="true"]` 精确（后者可能误配登录框等其它 modal）。
 */
const settingsDialog = (env) => (env.doc && env.doc.querySelector('[data-shortcut-modal="settings"]'))
  || (env.doc && env.doc.querySelector('[role="dialog"][aria-modal="true"]'))
/** 按分区 id 定位导航行（`data-snav-row`），仅返回可见元素（折叠时可能不可见）。 */
const findByRowId = (root, id) => {
  if (!id) return null
  const el = root.querySelector('[data-snav-row="' + attrEscape(id) + '"]')
  return el && visible(el) ? el : null
}

/**
 * 在面板内按可见文案找可点击元素。
 * 归一化匹配（容忍箭头/数量后缀）；命中多个时取**最内层**（外层容器常只是包裹按钮，
 * 点击不生效），并优先真正的 `button` / `[role="tab"]`。
 */
const findByLabel = (root, label) => {
  const target = normalizeLabel(label)
  if (!target) return null
  const matches = Array.from(root.querySelectorAll(CLICKABLE))
    .filter((el) => visible(el) && normalizeLabel(textOf(el)) === target)
  if (matches.length === 0) return null
  const deepest = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)))
  const pool = deepest.length ? deepest : matches
  return pool.find((el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'tab') || pool[0]
}

/**
 * 在 **document** 上找账号菜单里的「设置」项（portal 渲染 ⇒ 不在 sidebar 子树内）。
 * 文案候选命中优先；对不上时退回**第一个可用 menuitem**（菜单 items 顺序固定，
 * settings 恒为第一项），保证「能看到菜单就能点进设置」。
 */
const findSettingsMenuItem = (env) => {
  if (!env.doc) return null
  const items = Array.from(env.doc.querySelectorAll(MENU_ITEM_SELECTOR)).filter((el) => visible(el))
  if (items.length === 0) return null
  const wanted = SETTINGS_ITEM_LABELS.map((label) => normalizeLabel(label))
  const hit = items.find((el) => wanted.indexOf(normalizeLabel(textOf(el))) !== -1)
  return hit || items[0]
}

const clickEl = (el) => { try { el.click() } catch (e) { /* 忽略 */ } }
/** 轮询等待 fn() 返回真值（rAF 驱动，超时即返回 undefined）。 */
const waitFor = (env, fn) => new Promise((resolve) => {
  const t0 = env.now()
  const schedule = typeof env.raf === 'function' ? env.raf : (cb) => setTimeout(cb, 16)
  const step = () => {
    let v = null
    try { v = fn() } catch (e) { v = null }
    if (v || env.now() - t0 > WAIT_MS) resolve(v || null)
    else schedule(step)
  }
  step()
})

/**
 * 打开设置面板（⓪①② 三层依次尝试）；已开则直接返回该面板。
 * @returns {Promise<Element|null>} 面板句柄；null = 三条入口都没能打开。
 */
async function openPanel(env) {
  let dialog = settingsDialog(env)
  if (dialog) return dialog
  const trigger = env.doc.querySelector(TRIGGER_SELECTOR)
  if (trigger) {
    clickEl(trigger)
  } else {
    // 官方 fallback 按钮不存在（settings.launcher 已被账号 launcher 占用）⇒ 走菜单。
    const launcher = env.doc.querySelector(LAUNCHER_SELECTOR)
    if (!launcher) return null
    clickEl(launcher)
    const item = await waitFor(env, () => findSettingsMenuItem(env))
    if (!item) return null
    clickEl(item)
  }
  return waitFor(env, () => settingsDialog(env))
}

/**
 * 经设置外壳的 slot store 打开面板并定位分区（DSH 0.2.0-rc.x）。
 * ui-settings-general 把外壳 store 挂在 `sidebar.settings` 注册上，动作
 * `openSection(id)` = `{ activeId = id; open = true }`；其 `create()` 被覆写为返回外壳
 * 正在用的同一单例，故直接改的就是 UI 的状态。
 * 任一步不可用/抛错 ⇒ 返回 null（调用方继续走 DOM 兜底，**绝不抛错**）。
 * @returns {Promise<string|null>} 'api' = 面板确实开了；null = 没走通。
 */
async function openViaShellStore(env, slots, rowId) {
  if (!slots || typeof slots.entries !== 'function') return null
  let entries = []
  try { entries = slots.entries('sidebar.settings') || [] } catch (e) { return null }
  for (const entry of entries) {
    const handle = entry && entry.store
    if (!handle || typeof handle.create !== 'function') continue
    let instance = null
    try { instance = handle.create() } catch (e) { continue }
    const openSection = instance && instance.actions && instance.actions.openSection
    if (typeof openSection !== 'function') continue
    try { openSection(rowId) } catch (e) { continue }
    if (await waitFor(env, () => settingsDialog(env))) return 'api'   // 面板确实开了才算成功
  }
  return null
}

/**
 * 「面板确实开了、只是没定位到目标分区」的返回码（v0.1.93）。
 * 语义：设置面板已成功打开（shell store 的 `openSection` 生效、`settingsDialog` 已出现），
 * 但 `locateSection` 在面板里没找到本插件的分区行（分区未注册 / 插件未加载 / 被收纳到
 * 别处）。「打开设置」这个主目的已达成 ⇒ `isOpenOk` 视为**成功**，只是提示文案必须与
 * 事实相符（`settings.open.noSection`），不能再笼统说「打不开」。
 */
const OPENED_NO_SECTION = 'opened-no-section'
/** 打开成功的返回码（两处调用点共用，避免各自枚举）。 */
const OPEN_OK = new Set(['api', 'section', 'tab', OPENED_NO_SECTION])
const isOpenOk = (r) => OPEN_OK.has(r)

/**
 * 在已打开的面板里把锚点移到目标分区（**不动原有查找顺序**）。
 * ① `data-snav-row` 精确命中 → ②可见文案归一化命中 → ③展开「插件入口」父级再找同名子页签
 * → ④最终复查（父级已展开但上一次等待恰好超时）。
 * @returns {Promise<'section'|'tab'|'notfound'>}
 *   section = 顶层导航行（或分区行）命中；tab = 「插件入口」展开后的子项命中。
 */
async function locateSection(env, dialog, targetId, label) {
  const findTarget = () => findByRowId(dialog, targetId) || findByLabel(dialog, label)
  // 1) 顶层直接命中（分区未被收纳时）
  const direct = findTarget()
  if (direct) { clickEl(direct); return 'section' }
  // 2) 嵌套兜底：先展开「插件入口」父级，再从渲染出的子项里找目标
  for (const parent of PARENTS) {
    const row = findByRowId(dialog, parent.id) || findByLabel(dialog, parent.label)
    if (!row) continue
    try { row.click() } catch (e) { continue }
    const found = await waitFor(env, findTarget)
    if (found) { clickEl(found); return 'tab' }
  }
  // 3) 最终复查：父级已展开但上一次等待恰好超时——再试一次，避免误报未找到
  const late = findTarget()
  if (late) { clickEl(late); return 'section' }
  return 'notfound'
}

/**
 * 打开 DSH 设置面板并定位到指定分区。
 * @param {{ label: string, rowId?: string, slots?: object }} opts - label 为本插件设置分区
 *   的可见文案（t('settings.nav')）；rowId 为分区注册 id（默认 'bgjobs'，用于
 *   data-snav-row 精确定位）；slots 为宿主 client 服务（有则走首选 store 路径）。
 * @returns {Promise<'api'|'section'|'tab'|'opened-no-section'|'notfound'|'no-trigger'>}
 *   api = 面板由 shell store 打开且锚点落位（首选）；section = 命中顶层导航（或分区行）；
 *   tab = 命中「插件入口」展开后的子项；opened-no-section = 面板确由 shell store 打开了、
 *   但面板里没有本插件的分区行（**算成功**，提示「设置已打开，但没找到分区」）；
 *   notfound = 面板已打开但没找到（交给用户手动点）；no-trigger = 组合里没有设置入口。
 */
async function openBgjobsSettings({ label, rowId, slots } = {}) {
  const env = openSettingsEnv()
  if (!label || !env.doc) return 'no-trigger'
  const targetId = rowId === undefined ? TARGET_ROW_ID : rowId
  // ⓪ 首选：经 shell store 开面板（与文案/DOM 结构解耦）
  const viaApi = await openViaShellStore(env, slots, targetId)
  // ①② 兜底：官方按钮 / 账号 launcher 菜单（store 已开面板时下面这个分支不会触发）
  let dialog = settingsDialog(env)
  if (!dialog) dialog = await openPanel(env)
  if (!dialog) return 'no-trigger'
  // 面板开好了；锚点仍要走原有查找顺序落位（顶层行 / 「插件入口」折叠兼容分支）。
  const located = await locateSection(env, dialog, targetId, label)
  if (viaApi === null) return located
  // store 已开面板：①锚点也落位才叫 api；②面板**确实**开了、只是目标分区没定位到
  // ⇒ opened-no-section（算成功，但提示必须与事实相符：开是开了，只是没找到分区）；
  // ③面板本就在别处开着、锚点恰好就是目标 ⇒ 也算 api。
  // `notfound` 语义一字未改：仍指「DOM 兜底开/已开的面板里没找到」（走原失败提示）。
  if (located === 'notfound') return OPENED_NO_SECTION
  return 'api'
}

// 导出缝（Node 单测经 createRequire 直接加载本文件；bundle 里 module 由模块包装器提供）。
// **不用 `module.exports = {…}` 整体替换**：esbuild 把本模块内联进 lib/client.js 后，
// 这里赋的正是 bundle **入口**的 module.exports（index.js 已挂 `{ name, inject, apply }`），
// 整体替换会连 `apply` 一起冲掉、插件直接失效 ⇒ 只挂属性、不动对象引用。
module.exports.openBgjobsSettings = openBgjobsSettings
module.exports.isOpenOk = isOpenOk
module.exports.OPENED_NO_SECTION = OPENED_NO_SECTION
module.exports.setOpenSettingsEnv = setOpenSettingsEnv
