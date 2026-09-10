// bgjobs client — 打开 DSH 设置面板并定位到本插件的设置分区（齿轮按钮用）。
//
// 背景（已核对 M:\deepseek-harness 源码，与已安装版本一致）：
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

/** 第一方设置触发按钮（官方稳定锚点 + 自身语义）。 */
const TRIGGER_SELECTOR = '[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]'
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
const settingsDialog = () => document.querySelector('[role="dialog"][aria-modal="true"]')
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

/** 轮询等待 fn() 返回真值（rAF 驱动，超时即返回 undefined）。 */
const waitFor = (fn) => new Promise((resolve) => {
  const t0 = Date.now()
  const step = () => {
    let v = null
    try { v = fn() } catch (e) { v = null }
    if (v || Date.now() - t0 > WAIT_MS) resolve(v || null)
    else requestAnimationFrame(step)
  }
  step()
})

/**
 * 打开 DSH 设置面板并定位到指定分区。
 * @param {{ label: string, rowId?: string }} opts - label 为本插件设置分区的可见文案
 *   （t('settings.nav')）；rowId 为分区注册 id（默认 'bgjobs'，用于 data-snav-row 精确定位）。
 * @returns {Promise<'section'|'tab'|'notfound'|'no-trigger'>}
 *   section = 命中顶层导航（或分区行）；tab = 命中「插件入口」展开后的子项；
 *   notfound = 面板已打开但没找到（交给用户手动点）；no-trigger = 组合里没有设置入口。
 */
async function openBgjobsSettings({ label, rowId } = {}) {
  if (!label || typeof document === 'undefined') return 'no-trigger'
  const targetId = rowId === undefined ? TARGET_ROW_ID : rowId
  let dlg = settingsDialog()
  if (!dlg) {
    const trigger = document.querySelector(TRIGGER_SELECTOR)
    if (!trigger) return 'no-trigger'   // 未组合 ui-sidebar / 设置 shell
    try { trigger.click() } catch (e) { return 'no-trigger' }
    dlg = await waitFor(settingsDialog)
    if (!dlg) return 'no-trigger'
  }
  // 定位目标：①分区 id（data-snav-row）精确命中 → ②可见文案归一化命中
  const findTarget = () => findByRowId(dlg, targetId) || findByLabel(dlg, label)
  // 1) 顶层直接命中（分区未被收纳时）
  const direct = findTarget()
  if (direct) { try { direct.click() } catch (e) { /* 忽略 */ } return 'section' }
  // 2) 嵌套兜底：先展开「插件入口」父级，再从渲染出的子项里找目标
  for (const parent of PARENTS) {
    const row = findByRowId(dlg, parent.id) || findByLabel(dlg, parent.label)
    if (!row) continue
    try { row.click() } catch (e) { continue }
    const found = await waitFor(findTarget)
    if (found) { try { found.click() } catch (e) { /* 忽略 */ } return 'tab' }
  }
  // 3) 最终复查：父级已展开但上一轮恰好超时——再试一次，避免误报未找到
  const late = findTarget()
  if (late) { try { late.click() } catch (e) { /* 忽略 */ } return 'section' }
  return 'notfound'
}

module.exports = { openBgjobsSettings }
