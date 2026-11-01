// 0.3 D1/D5：全局配置文件的唯一读写者。
//
// 设计要点（见 _开发日志/design-v03-config.md）：
// - $DSH_HOME/bgjobs/config.json 是**唯一全局值**文件；`cordis.patch.yml` 的插件 config
//   降级为"种子"（仅当 config.json 不存在时由调用方读取一次，不在此模块里处理）。
// - 读-改-写 + mtime 检查：写入前若文件在我们读取后被别人改过，就重读一次再合，避免覆盖。
// - 坏 JSON / 非对象 ⇒ 返回 { ok:false, error } 而不是抛错（沿用插件"坏配置只告警"的纪律）。
import path from 'node:path'
import fsp from 'node:fs/promises'
import { resolveBgjobsHome } from '../index-store.js'

/** config.json 的绝对路径（$DSH_HOME/bgjobs/config.json）。 */
export const globalConfigPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'config.json')

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const emptyShape = () => ({ submit: {}, query: {}, control: {}, ui: {} })

/**
 * 读全局配置。
 * @returns {Promise<{ok:true, value:object, mtimeMs:number|null} | {ok:false, error:string, mtimeMs:null}>}
 * 文件不存在 ⇒ { ok:true, value:{submit:{},query:{},control:{},ui:{}}, mtimeMs:null }（不是错误）。
 */
export async function readGlobalConfig() {
  const p = globalConfigPath()
  let raw
  try {
    raw = await fsp.readFile(p, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, value: emptyShape(), mtimeMs: null }
    return { ok: false, error: '读取 config.json 失败：' + (e && e.message ? e.message : String(e)), mtimeMs: null }
  }
  let stat = null
  try { stat = await fsp.stat(p) } catch { /* 拿不到 mtime 不影响读取 */ }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: 'config.json 不是合法 JSON：' + (e && e.message ? e.message : String(e)), mtimeMs: stat ? stat.mtimeMs : null }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'config.json 顶层必须是对象', mtimeMs: stat ? stat.mtimeMs : null }
  }
  const value = emptyShape()
  for (const g of ['submit', 'query', 'control', 'ui']) {
    if (isPlainObject(parsed[g])) value[g] = { ...parsed[g] }
  }
  return { ok: true, value, mtimeMs: stat ? stat.mtimeMs : null }
}

/**
 * 把 patch 合并进 config.json 后整体写回（读-改-写）。
 * - 只合并 submit / query / control / ui 四个组；组内浅合并；值为 null 的键表示删除。
 * - 写前若文件 mtime 变化过 ⇒ 重读一次再合（避免覆盖他人写入）。
 * @param {object} patch 形如 { submit:{...}, ui:{...} }
 * @returns {Promise<{ok:boolean, value?:object, error?:string, warnings?:string[]}>}
 */
export async function writeGlobalConfig(patch) {
  if (!isPlainObject(patch)) return { ok: false, error: 'patch 必须是对象' }
  const warnings = []
  const first = await readGlobalConfig()
  if (!first.ok) return { ok: false, error: first.error }
  let base = first.value
  let baseMtime = first.mtimeMs

  // mtime 检查：写前再 stat 一次，若变过则重读（最多重试一次，避免活锁）
  const p = globalConfigPath()
  try {
    const stat = await fsp.stat(p)
    if (baseMtime !== null && stat.mtimeMs !== baseMtime) {
      const again = await readGlobalConfig()
      if (!again.ok) return { ok: false, error: again.error }
      base = again.value
      baseMtime = again.mtimeMs
      warnings.push('config.json 在读取后被修改过，已重读后再合并')
    }
  } catch { /* 文件不存在 ⇒ 首次写入，无需校验 */ }

  const next = emptyShape()
  for (const g of ['submit', 'query', 'control', 'ui']) {
    next[g] = { ...base[g] }
    if (!isPlainObject(patch[g])) continue
    for (const [k, v] of Object.entries(patch[g])) {
      if (v === null) delete next[g][k]
      else next[g][k] = v
    }
  }

  try {
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (e) {
    return { ok: false, error: '写入 config.json 失败：' + (e && e.message ? e.message : String(e)) }
  }
  return { ok: true, value: next, warnings: warnings.length > 0 ? warnings : undefined }
}
