// bgjobs core —— 每 apply 一份的可变状态（v0.1.61 结构重构）。
// 规则：凡「每插件实例一份」的可变状态（任务注册表、full access 缓存）都集中在此，
// 严禁放模块级（多 apply/测试间会互相污染）。纯函数模块见 ../*.js。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { resolveBgjobsHome } from '../index-store.js'

/** 创建本 apply 实例持有的状态：registry（任务内存注册表）+ full access 持久化开关。 */
export function createStore() {
  const registry = new Map()

  // ── full access 开关（web 面板 toggle；默认关）。ON = 用户预批准"全权限后台任务"，
  //    受限会话里宽请求（含 bat 引擎默认的全权限）不再逐次弹审批。持久化
  //    $DSH_HOME/bgjobs/fullaccess.json；仅 sandboxPolicy 挂载（会话受限）时才有意义。
  const fullAccessPath = () => path.join(resolveBgjobsHome(), 'bgjobs', 'fullaccess.json')
  let fullAccessCache = null
  const readFullAccess = async () => {
    if (fullAccessCache !== null) return fullAccessCache
    try {
      fullAccessCache = JSON.parse(await fsp.readFile(fullAccessPath(), 'utf8')).enabled === true
    } catch (e) { fullAccessCache = false }
    return fullAccessCache
  }
  const setFullAccess = async (enabled) => {
    fullAccessCache = !!enabled
    try {
      const p = fullAccessPath()
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify({ enabled: fullAccessCache }, null, 2), 'utf8')
    } catch (e) { /* 尽力而为 */ }
    return { ok: true, enabled: fullAccessCache }
  }

  return { registry, readFullAccess, setFullAccess }
}
