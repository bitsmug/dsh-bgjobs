// bgjobs —— 中央任务索引（v0.1.61 结构重构自 lib/index.js 拆分）。
// 索引只存 jobDir 当"地图"，不存状态：状态永远实时读 <jobDir>/job.json。
// 因此 DSH 离线期间任务完成、或索引过期，都不影响正确性。
// 路径：$DSH_HOME/bgjobs/index.json（DSH_HOME 与 harness resolveDshHome 同规则）。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { strip } from './util.js'

const INDEX_VERSION = 1

/** 解析 DSH home；与 harness `resolveDshHome()` 同规则（env 优先，默认 ~/.dsh）。 */
export function resolveBgjobsHome() {
  const fromEnv = process.env.DSH_HOME
  const home = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : path.join(os.homedir(), '.dsh')
  return path.resolve(home)
}

/** 中央索引文件路径。 */
export function bgjobsIndexPath(home = resolveBgjobsHome()) {
  return path.join(home, 'bgjobs', 'index.json')
}

/** 读取索引；缺失/损坏返回空索引（损坏不抛错，引导 index rebuild）。 */
export async function readBgjobsIndex(home = resolveBgjobsHome()) {
  try {
    const raw = await fsp.readFile(bgjobsIndexPath(home), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.jobs)) return { version: INDEX_VERSION, updatedAt: 0, jobs: [] }
    return { version: INDEX_VERSION, updatedAt: Number(parsed.updatedAt) || 0, jobs: parsed.jobs }
  } catch (e) {
    return { version: INDEX_VERSION, updatedAt: 0, jobs: [] }
  }
}

/** 整体覆写索引；写失败静默（索引是地图，不影响插件主流程）。 */
export async function writeBgjobsIndex(index, home = resolveBgjobsHome()) {
  try {
    const dir = path.dirname(bgjobsIndexPath(home))
    await fsp.mkdir(dir, { recursive: true })
    const payload = { version: INDEX_VERSION, updatedAt: Date.now(), jobs: index.jobs }
    await fsp.writeFile(bgjobsIndexPath(home), JSON.stringify(payload, null, 2), 'utf8')
  } catch (e) { /* 静默 */ }
}

/** 索引写串行化队列：多个 fire-and-forget 更新并发时避免读-改-写互相覆盖。 */
let indexWriteChain = Promise.resolve()

/** 读-改-写：mutator 接收并修改 jobs 数组，随后整体覆写。串行执行。 */
export function updateBgjobsIndex(mutator, home = resolveBgjobsHome()) {
  const task = indexWriteChain.then(async () => {
    const index = await readBgjobsIndex(home)
    mutator(index.jobs)
    await writeBgjobsIndex(index, home)
  })
  indexWriteChain = task.catch(() => {})
  return task
}

/**
 * 从磁盘扫描已知 job 目录重建索引：给定工作区根目录列表，找到每个
 * `.dsh/bgjobs/<id>/job.json`（避开 `*` 注释终止符）。
 */
export async function rebuildBgjobsIndex(workdirs, home = resolveBgjobsHome()) {
  const jobs = []
  for (const raw of workdirs) {
    const workdir = strip(String(raw))
    if (!workdir) continue
    const jobsDir = path.join(workdir, '.dsh', 'bgjobs')
    let names = []
    try { names = await fsp.readdir(jobsDir) } catch (e) { continue }
    for (const n of names) {
      try {
        const jsonPath = path.join(jobsDir, n, 'job.json')
        const meta = JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
        if (!meta || !meta.id || !meta.logPath) continue
        jobs.push({
          id: meta.id,
          jobDir: meta.jobDir || path.dirname(jsonPath),
          workdir,
          name: String(meta.name || meta.id),
          createdBySession: String(meta.createdBySession || ''),
          createdAt: Number(meta.createdAt) || 0,
        })
      } catch (e) { /* 非任务目录 */ }
    }
  }
  jobs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  const index = { version: INDEX_VERSION, updatedAt: Date.now(), jobs }
  await writeBgjobsIndex(index, home)
  return index
}
