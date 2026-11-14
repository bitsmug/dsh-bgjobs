// bgjobs exec —— 启动期对账（spec v7 §4.5）。
//
// 目标只是清理**本插件注册但已无主**的任务，不做任何"猜测性"状态改写：
//   - 任务前缀必须是 `dsh-bgj-`，且 id 必须符合本插件的 jobId 形状（`bg-<base36>-<base36>`）；
//     历史上的人工探针任务（如 dsh-bgj-probe3）不匹配，**永不触碰**；
//   - 只删「不在中央索引里」且「非 Running」且「注册时间早于 90s 宽限」的任务；
//   - 任务查询失败（PowerShell 不可用/输出不可解析）⇒ 整体放弃，不删任何东西。

import os from 'node:os'
import { readBgjobsIndex } from '../index-store.js'
import { deleteScheduledTask, listBgjobsTasks } from './task.mjs'

export const RECONCILE_TASK_PREFIX = 'dsh-bgj-'
export const RECONCILE_GRACE_MS = 90000

const JOB_ID_RE = /^bg-[a-z0-9]+-[a-z0-9]+$/

/** 任务名 → 本插件 jobId；不属于本插件（前缀/id 形状不符）返回 null。 */
export function jobIdFromTaskName(name) {
  if (typeof name !== 'string' || !name.startsWith(RECONCILE_TASK_PREFIX)) return null
  const id = name.slice(RECONCILE_TASK_PREFIX.length)
  return JOB_ID_RE.test(id) ? id : null
}

/**
 * 纯选择函数：给定任务列表与「索引里已知的 jobId」，返回可安全删除的无主任务。
 * @param {{ tasks: Array<{name:string,state:string,date:number}>, knownIds: Iterable<string>, now?: number, graceMs?: number }} input
 */
export function selectOrphanTasks({ tasks, knownIds, now = Date.now(), graceMs = RECONCILE_GRACE_MS }) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || [])
  const picked = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task.name !== 'string') continue
    const id = jobIdFromTaskName(task.name)
    if (id === null) continue
    if (known.has(id)) continue
    if (String(task.state).toLowerCase() === 'running') continue
    if (!Number.isFinite(task.date) || task.date <= 0) continue
    if (now - task.date < graceMs) continue
    picked.push({ id, name: task.name })
  }
  return picked
}

/**
 * 对账入口（插件加载后 fire-and-forget 调用）。返回 `{ ok, deleted }`；
 * `ok=false` 表示查询不可用（未做任何删除）。
 */
export async function reconcileOrphanTasks({ workdir, now = Date.now(), graceMs = RECONCILE_GRACE_MS } = {}) {
  const cwd = workdir && workdir.length > 0 ? workdir : os.tmpdir()
  const index = await readBgjobsIndex()
  const knownIds = new Set((Array.isArray(index.jobs) ? index.jobs : []).map((job) => job && job.id).filter(Boolean))
  const tasks = await listBgjobsTasks(cwd)
  if (tasks === null) return { ok: false, deleted: [] }
  const orphans = selectOrphanTasks({ tasks, knownIds, now, graceMs })
  const deleted = []
  for (const orphan of orphans) {
    const result = await deleteScheduledTask(orphan.name, cwd)
    if (result && result.exitCode === 0) deleted.push(orphan.name)
  }
  return { ok: true, deleted }
}
