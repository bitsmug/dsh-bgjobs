// bgjobs tests —— bgjob_wait 多任务 / submit wait / 交付标记（v0.1.61 自 tests/index.test.js 拆分）。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, strip, buildBat, buildCmdBat, buildPwshRunner, buildPs1, buildLaunchVbs, parseExitCode,
  jobSandboxDecision, shouldNotifyForExit,
  setSchtasksRunner, setShellResolver, setSandboxRunnerResolver,
  resolveBgjobsHome, bgjobsIndexPath, readBgjobsIndex, writeBgjobsIndex,
  updateBgjobsIndex, rebuildBgjobsIndex, buildBgjobsGuidance,
} from '../lib/index.js'
import {
  makeDshHome, makeWorkdir, makeCtx, makeFakeRunner, attachWebServer,
  runningPlugin, waitFor, setFullAccessEnabled, restrictedPolicy, fullPolicy,
  agentHandle, submitAndFinish, scheduleExitWrite, installSuiteHooks,
} from './helpers/common.js'

installSuiteHooks()

test('bgjob_wait: 已 done 的任务立即返回（waitedMs 0，不再轮询）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    const w = await wait.execute({ jobId: res.jobId })
    assert.equal(w.ok, true)
    assert.equal(w.timedOut, false)
    assert.equal(w.waitedMs, 0)
    assert.equal(w.status, 'done')
    assert.equal(w.exitCode, 0)
    assert.equal(w.error, undefined)
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done', 'wait 首查应顺带完成幂等收尾（job.json 落盘 done）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_wait: 未知 id 立即报 not found（不空等）', async () => {
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  const wait = tools.find((t) => t.name === 'bgjob_wait')
  const started = Date.now()
  const w = await wait.execute({ jobId: 'bg-nonexistent' })
  assert.equal(w.ok, false)
  assert.ok(w.error && w.error.includes('not found'))
  assert.ok(Date.now() - started < 1000, '未知 id 应立即返回，不进入轮询')
  dispose()
})


test('bgjob_wait: 超时返回 timedOut 快照（任务仍在 running）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const w = await wait.execute({ jobId: res.jobId, timeoutSeconds: 1 })
    assert.equal(w.ok, true)
    assert.equal(w.timedOut, true)
    assert.equal(w.status, 'running')
    assert.ok(w.waitedMs >= 950, '应等待约 timeoutSeconds')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_wait: 等待期间任务完成 → 立即返回 done + 退出码（无需 sleep 轮询）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    setTimeout(() => {
      fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '7', 'utf8').catch(() => {})
    }, 150)
    const w = await wait.execute({ jobId: res.jobId, timeoutSeconds: 5 })
    assert.equal(w.ok, true)
    assert.equal(w.timedOut, false)
    assert.equal(w.status, 'done')
    assert.equal(w.exitCode, 7)
    assert.ok(w.waitedMs >= 100 && w.waitedMs < 5000, '完成后应尽快返回（waitedMs=' + w.waitedMs + '）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── submit 可选 wait（v0.1.52）：提交成功后自动等待 ──

/** 轮询扫描 jobsRoot：任务目录出现 delayMs 后写 exitcode（模拟真实任务收尾）。返回 stop()，可读是否已写入。 */

test('bgjob_submit wait=1：提交后自动等待，任务结束立即返回 done + 退出码', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  const writer = scheduleExitWrite(workdir + '\\.dsh\\bgjobs', 5, 150)
  try {
    const r = await submit.execute({ name: 't', command: 'echo x', workdir, wait: 1 }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.timedOut, false)
    assert.equal(r.status, 'done')
    assert.equal(r.exitCode, 5)
    assert.ok(r.jobId)
    assert.ok(r.waitedMs > 0, '提交+等待应消耗等待时间')
    const meta = JSON.parse(await fsp.readFile(path.join(workdir, '.dsh', 'bgjobs', r.jobId, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done', '等待结束 job.json 已落盘 done')
    assert.equal(writer.wrote, true)
  } finally {
    writer.stop()
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit wait 缺省/0：立即返回（不等待、无 timedOut）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const started = Date.now()
    const r = await submit.execute({ name: 't', command: 'echo x', workdir, wait: 0 }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.timedOut, undefined)
    assert.ok(r.jobId)
    assert.ok(Date.now() - started < 3000, 'wait:0 应立即返回不阻塞')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit wait=1：任务未结束则超时返回 timedOut 快照', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const r = await submit.execute({ name: 't', command: 'echo x', workdir, wait: 1 }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.timedOut, true)
    assert.equal(r.status, 'running')
    assert.ok(r.waitedMs >= 950, '超时应等待约 wait 秒')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_submit_pwsh wait=1：提交后自动等待 done', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
  const writer = scheduleExitWrite(workdir + '\\.dsh\\bgjobs', 0, 150)
  try {
    const r = await submit.execute({ name: 't', command: 'Write-Output ok', workdir, wait: 1 }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.timedOut, false)
    assert.equal(r.status, 'done')
    assert.equal(r.exitCode, 0)
    assert.ok(r.waitedMs > 0)
    assert.equal(writer.wrote, true)
  } finally {
    writer.stop()
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 多任务等待（v0.1.59）：bgjob_wait any 竞速 / bgjob_wait_all / bgjob_list ──


test('bgjob_wait jobIds 数组：任一先完成即返回（any 竞速）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const exec = { agent: { session: { id: 's1' } } }
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const a = await submit.execute({ name: 'a', command: 'echo a', workdir }, exec)
    const b = await submit.execute({ name: 'b', command: 'echo b', workdir }, exec)
    assert.ok(a.jobId && b.jobId && a.jobId !== b.jobId)
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + a.jobId + '\\exitcode.txt', '0', 'utf8')
    const r = await wait.execute({ jobIds: [a.jobId, b.jobId], timeoutSeconds: 5 })
    assert.equal(r.ok, true)
    assert.equal(r.anyDone, true)
    assert.equal(r.timedOut, false)
    assert.equal(r.result.jobId, a.jobId, '先完成者应命中')
    assert.equal(r.result.status, 'done')
    assert.equal(r.result.exitCode, 0)
    assert.deepEqual(r.pending, [b.jobId], '未完成的 b 应在 pending')
    assert.ok(r.waitedMs < 5000)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_wait 全缺省：等本会话任务任一结束（跨会话任务不入集合）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const a = await submit.execute({ name: 'a', command: 'echo a', workdir }, { agent: { session: { id: 's1' } } })
    const b = await submit.execute({ name: 'b', command: 'echo b', workdir }, { agent: { session: { id: 's1' } } })
    await submit.execute({ name: 'c', command: 'echo c', workdir }, { agent: { session: { id: 's2' } } })
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + a.jobId + '\\exitcode.txt', '3', 'utf8')
    const r = await wait.execute({ timeoutSeconds: 5 }, { agent: { session: { id: 's1' } } })
    assert.equal(r.ok, true)
    assert.equal(r.anyDone, true)
    assert.equal(r.result.jobId, a.jobId, '应命中本会话完成的 a')
    assert.equal(r.result.exitCode, 3)
    assert.deepEqual(r.pending, [b.jobId], 'pending 只含本会话未完成的 b（s2 任务不在集合）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_wait 缺省空视图：会话无未交付任务 → empty 空返回；无会话 → 报错', async () => {
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  const wait = tools.find((t) => t.name === 'bgjob_wait')
  // 会话存在但没有任何任务（notify 视图为空）
  const empty = await wait.execute({ timeoutSeconds: 1 }, { agent: { session: { id: 'nosess' } } })
  assert.equal(empty.ok, true)
  assert.equal(empty.empty, true)
  assert.equal(empty.anyDone, false)
  // 完全无会话上下文 → 无法解析视图 → 报错
  const noExec = await wait.execute({ timeoutSeconds: 1 }, { agent: undefined })
  assert.equal(noExec.ok, false)
  assert.ok(noExec.error.includes('no jobId'))
  dispose()
})


test('bgjob_wait_all：全部完成返回 allDone，含各自退出码；超时返回部分', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const all = tools.find((t) => t.name === 'bgjob_wait_all')
    const a = await submit.execute({ name: 'a', command: 'echo a', workdir }, { agent: { session: { id: 's1' } } })
    const b = await submit.execute({ name: 'b', command: 'echo b', workdir }, { agent: { session: { id: 's1' } } })
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + a.jobId + '\\exitcode.txt', '0', 'utf8')
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + b.jobId + '\\exitcode.txt', '7', 'utf8')
    const r = await all.execute({ jobIds: [a.jobId, b.jobId], timeoutSeconds: 5 })
    assert.equal(r.ok, true)
    assert.equal(r.allDone, true)
    assert.equal(r.timedOut, false)
    assert.equal(r.results.length, 2)
    const ra = r.results.find((x) => x.jobId === a.jobId)
    const rb = r.results.find((x) => x.jobId === b.jobId)
    assert.equal(ra.exitCode, 0)
    assert.equal(rb.exitCode, 7)
    // 一直 running → 超时 allDone:false
    const c = await submit.execute({ name: 'c', command: 'echo c', workdir }, { agent: { session: { id: 's1' } } })
    const t = await all.execute({ jobIds: [c.jobId], timeoutSeconds: 1 })
    assert.equal(t.ok, true)
    assert.equal(t.allDone, false)
    assert.equal(t.timedOut, true)
    assert.equal(t.results[0].status, 'running')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_list：仅返回本会话任务，字段齐全', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const list = tools.find((t) => t.name === 'bgjob_list')
    const a = await submit.execute({ name: 'a', command: 'echo a', workdir }, { agent: { session: { id: 's1' } } })
    const b = await submit.execute({ name: 'b', command: 'echo b', workdir }, { agent: { session: { id: 's1' } } })
    await submit.execute({ name: 'c', command: 'echo c', workdir }, { agent: { session: { id: 's2' } } })
    const r = await list.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r.ok, true)
    assert.equal(r.sessionId, 's1')
    assert.equal(r.jobs.length, 2, '只含 s1 的任务')
    const ids = r.jobs.map((j) => j.jobId).sort()
    assert.deepEqual(ids, [a.jobId, b.jobId].sort())
    const first = r.jobs[0]
    assert.ok(typeof first.name === 'string' && first.status === 'running' && typeof first.workdir === 'string')
    assert.equal(first.exitCode, null)
    // 会话不可识别
    const bad = await list.execute({}, { agent: undefined })
    assert.equal(bad.ok, false)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('submit wait（有会话）＝全缺省 any：本会话已结束的任务先返回', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec1 = { agent: { session: { id: 's1' } } }
    const a = await submit.execute({ name: 'a', command: 'echo a', workdir }, exec1) // 不 wait
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + a.jobId + '\\exitcode.txt', '0', 'utf8')
    const r = await submit.execute({ name: 'b', command: 'echo b', workdir, wait: 1 }, exec1)
    assert.equal(r.ok, true)
    assert.equal(r.anyDone, true)
    assert.equal(r.result.jobId, a.jobId, '全缺省 any 应命中先完成的 a（本会话集合）')
    assert.equal(r.result.status, 'done')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── notify（交付）标记（v0.1.60）：wait 返回即置已通知、缺省=notify 视图 ──


test('交付标记: off 任务 wait 返回即置 delivered·wait 并落盘（再 wait 不覆盖）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const tick = intervals.find((i) => i.ms === 1000).fn
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: { session: { id: 's1' } } })
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    await tick() // 完成 → done，但未 notify/未 wait → pending
    let meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done')
    assert.equal(meta.notifiedAt, undefined, '完成且未被 wait 前应保持 pending（无 notifiedAt）')
    const w = await wait.execute({ jobId: res.jobId, timeoutSeconds: 5 })
    assert.equal(w.ok, true)
    assert.equal(w.notified, true, 'wait 返回即视为交付')
    assert.equal(w.notifiedBy, 'wait')
    meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.ok(meta.notifiedAt !== undefined && meta.notifiedAt !== null, 'wait 交付应落盘')
    assert.equal(meta.notifiedBy, 'wait')
    const firstAt = meta.notifiedAt
    const w2 = await wait.execute({ jobId: res.jobId })
    assert.equal(w2.notified, true)
    meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.notifiedAt, firstAt, '已交付任务不被再次 wait 覆盖')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('交付标记: notify 任务投递成功先行置 delivered·notify，wait 不覆盖', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const tick = intervals.find((i) => i.ms === 1000).fn
    const exec = { agent: { session: { id: 's1' } } }
    const jobDir = await submitAndFinish(submit, { name: 't', command: 'echo x', workdir, notify: 'on-exit' }, exec, workdir, 3, tick)
    assert.equal(handle.calls.followup.length, 1, '完成通知应投递成功')
    let meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.ok(meta.notifiedAt !== undefined, '投递成功后应落盘 notifiedAt')
    assert.equal(meta.notifiedBy, 'notify')
    // 面板数据源：state 视图应同步显示已通知（Bug1 回归）
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const stateParsed = JSON.parse(body)
    const sv = stateParsed.jobs.find((x) => x.id === meta.id)
    assert.ok(sv && sv.notified === true, 'state 视图应带 notified:true')
    const w = await wait.execute({ jobId: meta.id, timeoutSeconds: 5 })
    assert.equal(w.notified, true)
    assert.equal(w.notifiedBy, 'notify', '首通道 notify，wait 不覆盖')
    meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.notifiedBy, 'notify')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_wait 缺省=notify 视图：已交付任务剔除，只等未交付的', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const exec1 = { agent: { session: { id: 's1' } } }
    const a = await submit.execute({ name: 'a', command: 'echo a', workdir }, exec1)
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + a.jobId + '\\exitcode.txt', '0', 'utf8')
    const da = await wait.execute({ jobId: a.jobId, timeoutSeconds: 5 }) // 交付 a
    assert.equal(da.notified, true)
    const b = await submit.execute({ name: 'b', command: 'echo b', workdir }, exec1) // 仍 running、未交付
    // 缺省 wait：a 已被交付 → 不应返回它；只有 b 在视图里 → 等满超时 timedOut
    const r = await wait.execute({ timeoutSeconds: 1 }, exec1)
    assert.equal(r.ok, true)
    assert.equal(r.anyDone, false)
    assert.equal(r.timedOut, true)
    assert.equal(r.result, undefined)
    assert.ok(r.results && r.results.length === 1 && r.results[0].jobId === b.jobId, '视图只含未交付的 b')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_pending_list：仅本会话未交付任务', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const pending = tools.find((t) => t.name === 'bgjob_pending_list')
    const exec1 = { agent: { session: { id: 's1' } } }
    const a = await submit.execute({ name: 'a', command: 'echo a', workdir }, exec1) // running pending
    const b = await submit.execute({ name: 'b', command: 'echo b', workdir }, exec1)
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + b.jobId + '\\exitcode.txt', '0', 'utf8')
    await wait.execute({ jobId: b.jobId, timeoutSeconds: 5 }) // b 已交付
    await submit.execute({ name: 'c', command: 'echo c', workdir }, { agent: { session: { id: 's2' } } }) // 其它会话
    const r = await pending.execute({}, exec1)
    assert.equal(r.ok, true)
    assert.equal(r.jobs.length, 1, '只含本会话未交付的 a')
    assert.equal(r.jobs[0].jobId, a.jobId)
    assert.equal(r.jobs[0].notified, false)
    const bad = await pending.execute({}, { agent: undefined })
    assert.equal(bad.ok, false)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_wait_all 缺省空视图 → allDone 真空返回', async () => {
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  const all = tools.find((t) => t.name === 'bgjob_wait_all')
  const r = await all.execute({}, { agent: { session: { id: 'nosess' } } })
  assert.equal(r.ok, true)
  assert.equal(r.allDone, true)
  assert.equal(r.timedOut, false)
  assert.deepEqual(r.results, [])
  dispose()
})


// ── v0.1.71 用户手动停止（exec.signal abort → stopped:true，不置 delivered）──────────────────

/** 建一个保持 running 的任务并返回其 jobId/jobDir。 */
async function submitRunning(workdir, tools) {
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
  return { jobId: res.jobId, jobDir: workdir + '\\.dsh\\bgjobs\\' + res.jobId }
}

test('bgjob_wait: 等待中 signal abort → 立即返回 stopped（不置 delivered、waitedMs 小）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const { jobId, jobDir } = await submitRunning(workdir, tools)
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const controller = new AbortController()
    const started = Date.now()
    const p = wait.execute({ jobId, timeoutSeconds: 30 }, { agent: undefined, signal: controller.signal })
    setTimeout(() => controller.abort(new Error('stopped by user')), 300)
    const w = await p
    assert.equal(w.ok, true)
    assert.equal(w.stopped, true)
    assert.equal(w.timedOut, false)
    assert.equal(w.status, 'running')
    assert.ok(Date.now() - started < 3000, '打断后应 ~1s 内返回（waitedMs=' + w.waitedMs + '）')
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.ok(meta.notifiedAt === undefined || meta.notifiedAt === null, 'stopped 不置已交付')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_wait jobIds(any): signal abort → stopped:true + 各任务当前状态（不置 delivered）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const a = await submitRunning(workdir, tools)
    const b = await submitRunning(workdir, tools)
    const wait = tools.find((t) => t.name === 'bgjob_wait')
    const controller = new AbortController()
    const p = wait.execute({ jobIds: [a.jobId, b.jobId], timeoutSeconds: 30 }, { agent: undefined, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const w = await p
    assert.equal(w.ok, true)
    assert.equal(w.stopped, true)
    assert.equal(w.anyDone, false)
    assert.equal(w.timedOut, false)
    assert.ok(Array.isArray(w.results) && w.results.length === 2, 'stopped 返回全部当前状态')
    const metaA = JSON.parse(await fsp.readFile(path.join(a.jobDir, 'job.json'), 'utf8'))
    assert.ok(metaA.notifiedAt === undefined || metaA.notifiedAt === null, 'any stopped 不置已交付')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_wait_all: signal abort → stopped:true + results 当前状态（不置 delivered）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const { jobId, jobDir } = await submitRunning(workdir, tools)
    const all = tools.find((t) => t.name === 'bgjob_wait_all')
    const controller = new AbortController()
    const p = all.execute({ jobIds: [jobId], timeoutSeconds: 30 }, { agent: undefined, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const w = await p
    assert.equal(w.ok, true)
    assert.equal(w.stopped, true)
    assert.equal(w.allDone, false)
    assert.equal(w.timedOut, false)
    assert.ok(Array.isArray(w.results) && w.results.length === 1)
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.ok(meta.notifiedAt === undefined || meta.notifiedAt === null, 'wait_all stopped 不置已交付')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('bgjob_submit wait= 参数共享中断：提交后原地等待被 signal abort → stopped', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const controller = new AbortController()
    const started = Date.now()
    const p = submit.execute({ name: 't', command: 'echo x', workdir, wait: 30 }, { agent: undefined, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const res = await p
    assert.equal(res.ok, true)
    assert.equal(res.stopped, true)
    assert.equal(res.timedOut, false)
    assert.equal(res.status, 'running')
    assert.ok(Date.now() - started < 3000, 'submit wait 打断应尽快返回（waitedMs=' + res.waitedMs + '）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


