// bgjobs core —— 工具「默认参数」的**唯一所有者**（B′，2026-10-28）。
//
// 为什么要有这个模块：`bgjob_submit` 一次要接受 10 个参数（command/name/workdir/sandbox/
// sandbox_backend/output_encoding/justification/notify/notify_mode/wait），模型每次都得重新
// 决定一遍，实际使用中大量调用只关心 `command`。这里把「不常变的那部分」抽成四层默认：
//
//   L1 插件 config   ctx.config = { submit:{}, query:{}, control:{} }      （全局，作者/用户配置）
//   L2 项目文件      <workspace>/.dsh/bgjobs.json                        （随项目走，agent 用 write 就能改）
//   L3 会话内 set    bgjob_config({ action:'set', set:{...} })           （内存态，随会话结束失效）
//   L4 逐次参数      调用参数                                             （最高）
//
// 合并语义：**按组浅合并**，L4 覆盖 L3 覆盖 L2 覆盖 L1；值为 `null` 表示**显式删除该键**
// （回到工具内建默认）。只合并「白名单键」—— `command` / `tool` / `server` / `server_config`
// / `name` / `workdir` 这类一次性参数**一律拒绝并告警**，避免把某次调用的值固化成隐式行为。
//
// 容错纪律（照 dsh-subagent-spec）：JSON 语法错 / 未知键 / 类型不符 ⇒ **只告警、不报错**，
// 绝不因为配置坏而让提交失败；项目文件不存在是常态，安静返回空。
//
// ★ 唯一所有者原则：任何「默认值从哪来」的判断只能在这个文件里；`tools.js` 只负责把
//   自己的组名和调用参数递进来，`jobs.js` 及以下完全不知道有"默认层"这回事。

import fs from 'node:fs'
import path from 'node:path'

/** 项目层默认文件的相对路径（放在工作区的 .dsh/ 下，与 subagent-spec 同位置）。 */
export const PROJECT_FILE_REL = path.join('.dsh', 'bgjobs.json')

/** 允许出现在默认层的三个组。 */
export const GROUPS = ['submit', 'query', 'control']

/** 一次性参数：出现在默认层一律拒绝（含 `name`/`workdir`/`command`/`tool`/`server*`）。 */
export const FORBIDDEN_KEYS = ['command', 'tool', 'server', 'server_config', 'name', 'workdir']

/** 各组允许的默认键（白名单）。新增参数时**必须**同步这里，否则默认层静默不生效。 */
export const KEY_WHITELIST = {
  submit: ['engine', 'sandbox', 'sandbox_backend', 'output_encoding', 'notify', 'notify_mode', 'wait', 'justification'],
  query: ['timeoutSeconds'],
  control: ['reason'],
}

/** path → { mtimeMs, size, groups, warnings }；按 mtime+size 失效，改完即生效，不用重启。 */
const projectCache = new Map()
/** sessionId → { submit:{}, query:{}, control:{} } */
const sessionStore = new Map()

const emptyGroups = () => ({ submit: {}, query: {}, control: {} })

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 把一层原始配置按白名单收进 out（就地写）。
 * @param {string} group 组名
 * @param {unknown} raw 该层的原始对象
 * @param {string} label 告警里显示的位置（如 `bgjobs.json.submit`）
 * @param {string[]} warnings 告警收集器
 * @param {{submit:object,query:object,control:object}} out 目标
 */
function absorbLayer(group, raw, label, warnings, out) {
  if (raw === void 0 || raw === null) return
  if (!isPlainObject(raw)) {
    warnings.push(label + ' 不是对象，已忽略该层')
    return
  }
  const groupRaw = raw
  if (groupRaw === void 0 || groupRaw === null) return
  if (!isPlainObject(groupRaw)) {
    warnings.push(label + ' 不是对象，已忽略该层')
    return
  }
  const allowed = KEY_WHITELIST[group] || []
  for (const [key, value] of Object.entries(groupRaw)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      warnings.push(label + '.' + key + ' 是一次性参数，默认层不接受（已忽略）')
      continue
    }
    if (!allowed.includes(key)) {
      warnings.push(label + '.' + key + ' 不是可识别字段（允许: ' + allowed.join(', ') + '），已忽略')
      continue
    }
    out[group][key] = value
  }
}

/**
 * 读项目层默认（带 mtime+size 缓存）。
 * @param {string|undefined} workspace 工作区绝对路径
 * @returns {{groups:{submit:object,query:object,control:object}, warnings:string[], path:string|null, exists:boolean}}
 */
export function readProjectDefaults(workspace) {
  const warnings = []
  const empty = { groups: emptyGroups(), warnings, path: null, exists: false }
  if (typeof workspace !== 'string' || workspace.length === 0) return empty
  const file = path.join(workspace, PROJECT_FILE_REL)
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return Object.assign(empty, { path: file })
  }
  const hit = projectCache.get(file)
  if (hit !== void 0 && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { groups: cloneGroups(hit.groups), warnings: [], path: file, exists: true }
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    warnings.push('bgjobs.json 解析失败：' + String(e && e.message ? e.message : e) + '（已忽略项目默认）')
    projectCache.delete(file)
    return { groups: emptyGroups(), warnings, path: file, exists: true }
  }
  const out = emptyGroups()
  for (const group of GROUPS) absorbLayer(group, (parsed || {})[group], 'bgjobs.json.' + group, warnings, out)
  for (const key of Object.keys(parsed || {})) {
    if (!GROUPS.includes(key)) warnings.push('bgjobs.json.' + key + ' 不是可识别的组（允许: ' + GROUPS.join(', ') + '），已忽略')
  }
  projectCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, groups: cloneGroups(out) })
  return { groups: out, warnings, path: file, exists: true }
}

const cloneGroups = (g) => ({
  submit: Object.assign({}, g.submit),
  query: Object.assign({}, g.query),
  control: Object.assign({}, g.control),
})

/** 读会话层（不存在就是空）。 */
export function getSessionGroups(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return emptyGroups()
  const hit = sessionStore.get(sessionId)
  return hit === void 0 ? emptyGroups() : cloneGroups(hit)
}

/**
 * 合并写入会话层（浅合并；`null` 删除该键）。
 * @returns {{groups:object, warnings:string[]}}
 */
export function setSessionGroups(sessionId, patch) {
  const warnings = []
  const current = getSessionGroups(sessionId)
  for (const group of GROUPS) absorbLayer(group, (patch || {})[group], 'bgjob_config.set.' + group, warnings, current)
  for (const key of Object.keys(patch || {})) {
    if (!GROUPS.includes(key)) warnings.push('bgjob_config.set.' + key + ' 不是可识别的组（允许: ' + GROUPS.join(', ') + '），已忽略')
  }
  for (const group of GROUPS) {
    for (const [k, v] of Object.entries(current[group])) {
      if (v === null) delete current[group][k]
    }
  }
  if (typeof sessionId === 'string' && sessionId.length > 0) sessionStore.set(sessionId, cloneGroups(current))
  return { groups: current, warnings }
}

/** 清空某会话的会话层（全部组）。 */
export function resetSessionGroups(sessionId) {
  if (typeof sessionId === 'string' && sessionId.length > 0) sessionStore.delete(sessionId)
  return emptyGroups()
}

/**
 * 解析某个组的生效参数：L1 config → L2 项目 → L3 会话 → L4 调用参数。
 * @param {{group:string, config?:object, workspace?:string, sessionId?:string, call?:object}} input
 * @returns {{values:object, warnings:string[]}}
 */
export function resolveDefaults(input) {
  const group = input && input.group
  const warnings = []
  if (!GROUPS.includes(group)) return { values: {}, warnings }
  const merged = {}
  const out = { submit: {}, query: {}, control: {} }
  // L1：插件 config（只取本组）
  try {
    absorbLayer(group, input.config === void 0 ? void 0 : input.config[group], 'ctx.config.' + group, warnings, out)
  } catch { /* 配置形状异常不影响提交 */ }
  // L2：项目文件
  const project = readProjectDefaults(input.workspace)
  if (project.warnings.length > 0) warnings.push(...project.warnings)
  absorbLayer(group, project.groups[group], 'bgjobs.json.' + group, warnings, out)
  // L3：会话层
  absorbLayer(group, getSessionGroups(input.sessionId)[group], 'bgjob_config.' + group, warnings, out)
  // L4：调用参数（同样只取白名单键；一次性参数由调用方自己处理，这里不碰）
  if (isPlainObject(input.call)) {
    for (const [k, v] of Object.entries(input.call)) {
      if (v !== void 0) out[group][k] = v
    }
  }
  for (const [k, v] of Object.entries(out[group])) {
    if (v !== null) merged[k] = v
  }
  return { values: merged, warnings }
}

/** 仅供测试：清掉两个缓存。 */
export function __resetCachesForTest() {
  projectCache.clear()
  sessionStore.clear()
}
