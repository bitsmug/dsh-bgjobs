// bgjobs —— 包版本读取（v0.1.66）。设置页「后台任务」显示当前版本用；
// 模块级缓存（版本在包生命周期内不变）。root 定位同 gui-launch（import.meta.url 上一级）。
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

let cachedVersion = null
let loaded = false

/** 读 package.json 的 version；读失败返回 null（仍 ok，UI 不显示版本即可）。 */
export async function readBgjobsVersion() {
  if (loaded) return cachedVersion
  loaded = true
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : null
  } catch (e) {
    cachedVersion = null
  }
  return cachedVersion
}
