// bgjobs tests —— 完成横幅（toast）幂等（v0.1.88）：client 纯函数判定 + host 写回路由 + 一次性种子。
// client 侧判定是纯 CJS（lib/client-src/banner.js）——用 createRequire 直接加载，**不能 import**：
// 该目录的模块会 require('react')（客户端 bundle 的 seed 依赖），node:test 里拉不起来。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { apply, setSchtasksRunner, writeBgjobsIndex } from '../lib/index.js'
import { makeCtx, makeDshHome, makeWorkdir, makeFakeRunner, attachWebServer, submitAndFinish, installSuiteHooks } from './helpers/common.js'

const require = createRequire(import.meta.url)
const { shouldToast } = require('../lib/client-src/banner.js')

installSuiteHooks()

const bgjobsFile = (name) => path.join(process.env.DSH_HOME, 'bgjobs', name)
const readJson = async (p) => JSON.parse(await fsp.readFile(p, 'utf8'))
/** 一条 /bgjobs/state 形状的 done 快照。 */
const doneJob = (id, extra) => Object.assign({ id, name: 'j', status: 'done', exitCode: 0, toasted: false }, extra)
const opts = (extra) => Object.assign({ enabled: true, memo: true }, extra)

/** 挂 webServer，返回 { status, body } 调用器（query 与 JSON body 两用）。 */
function makeClient(ctx, injectCallbacks) {
  const handler = attachWebServer(ctx, injectCallbacks)().handler
  return async (url, method = 'GET', body) => {
    let out = ''
    let status = 0
    const req = { url, method }
    if (body !== undefined) {
      req.on = (ev, cb) => {
        if (ev === 'data') cb(Buffer.from(JSON.stringify(body), 'utf8'))
        if (ev === 'end') cb()
      }
      req.destroy = () => {}
    }
    await handler(req, { writeHead: (c) => { status = c }, end: (b) => { out = b } })
    return { status, body: JSON.parse(out || '{}') }
  }
}

/** 造一个磁盘任务（job.json + 可选日志）；返回 jobDir。 */
async function makeDiskJob(workdir, id, status) {
  const jobDir = workdir + '\\.dsh\\bgjobs\\' + id
  await fsp.mkdir(jobDir, { recursive: true })
  const meta = {
    id, name: id, workdir, jobDir,
    logPath: path.join(jobDir, 'stdout.log'), exitcodePath: path.join(jobDir, 'exitcode.txt'),
    jsonPath: path.join(jobDir, 'job.json'), taskName: 'dsh-bgj-' + id,
    command: 'echo x', status, createdAt: Date.now() - 1000,
  }
  if (status === 'done') { meta.exitCode = 0; meta.finishedAt = Date.now() }
  await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(meta), 'utf8')
  await fsp.writeFile(meta.logPath, 'done\n', 'utf8')
  return jobDir
}

// ── A. 纯函数判定：shouldToast 的 5 条口径 ────────────────────────────────────

test('shouldToast: 首轮已 done 且未 toasted ⇒ 不弹（只记基线）', () => {
  assert.deepEqual(shouldToast(doneJob('a'), null, opts()), { toast: false, memo: false })
  assert.deepEqual(shouldToast(doneJob('a'), undefined, opts()), { toast: false, memo: false })
})

test('shouldToast: 新完成（不在本轮基线里）⇒ 弹 + 写回', () => {
  assert.deepEqual(shouldToast(doneJob('b'), new Set(['a']), opts()), { toast: true, memo: true })
})

test('shouldToast: 已 toasted ⇒ 不弹（刷新页面不重弹）', () => {
  assert.deepEqual(shouldToast(doneJob('c', { toasted: true }), new Set(['a']), opts()), { toast: false, memo: false })
})

test('shouldToast: 总开关关（enabled=false）⇒ 完全不弹（首轮也弹不出）', () => {
  assert.equal(shouldToast(doneJob('d'), new Set(), opts({ enabled: false })).toast, false)
  assert.equal(shouldToast(doneJob('d'), null, opts({ enabled: false })).toast, false)
  assert.equal(shouldToast(doneJob('d', { toasted: false }), null, opts({ enabled: false })).memo, false)
})

test('shouldToast: 去重关（memo=false）⇒ 弹但不写（忽略标记，刷新即重弹；同轮不刷屏）', () => {
  // 首轮也弹：A 关 = 无记忆模式，每次挂载/刷新都对 done 重弹
  assert.deepEqual(shouldToast(doneJob('e'), null, opts({ memo: false })), { toast: true, memo: false })
  // 已 toasted 标记被忽略（否则关掉 A 后刷新仍然弹不出来）
  assert.deepEqual(shouldToast(doneJob('e', { toasted: true }), new Set(['x']), opts({ memo: false })), { toast: true, memo: false })
  // 同一轮已见过 ⇒ 不重复（每秒轮询不会刷屏）
  assert.deepEqual(shouldToast(doneJob('e'), new Set(['e']), opts({ memo: false })), { toast: false, memo: false })
})

test('shouldToast: 边界 —— running 不弹 / 本轮已见过不弹 / 缺省 opts 视为全开 / 空 job 不崩', () => {
  assert.equal(shouldToast({ id: 'f', status: 'running' }, new Set(), opts()).toast, false)
  assert.equal(shouldToast(doneJob('g'), new Set(['g']), opts()).toast, false)
  assert.deepEqual(shouldToast(doneJob('h'), new Set(), {}), { toast: true, memo: true })
  assert.deepEqual(shouldToast(null, new Set(), opts()), { toast: false, memo: false })
})

// ── B. host：POST /bgjobs/toasted 写回 ───────────────────────────────────────

test('webServer: /bgjobs/toasted 写回成对、未知 id 忽略不 500、非数组 400、GET 405', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const home = await makeDshHome()
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const call = makeClient(ctx, injectCallbacks)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick() // 先跑 recover + 种子（= 真实启动顺序），此后完成的任务才是"新完成"
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const jobDir = await submitAndFinish(submit, { name: 't', command: 'echo x', workdir }, undefined, workdir, 0, tick)
    const jobId = path.basename(jobDir)

    // 未知 id 与真实 id 同批：未知进 ignored、真实 id 写盘，整体 200
    let r = await call('/bgjobs/toasted', 'POST', { ids: ['bg-nope', jobId] })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.deepEqual(r.body.marked, [jobId], '真实 id 被标记')
    assert.deepEqual(r.body.ignored, ['bg-nope'], '未知 id 忽略（不 500）')
    let meta = await readJson(path.join(jobDir, 'job.json'))
    assert.equal(typeof meta.toastedAt, 'number', 'toastedAt 落盘 job.json')
    assert.equal(meta.toastedBy, 'web')

    // 幂等：重复 POST 同 id → ignored，且不覆写原时间戳
    const first = meta.toastedAt
    r = await call('/bgjobs/toasted', 'POST', { ids: [jobId] })
    assert.deepEqual(r.body.ignored, [jobId], '已标记的 id 再写 ⇒ ignored')
    meta = await readJson(path.join(jobDir, 'job.json'))
    assert.equal(meta.toastedAt, first, '不覆写既有 toastedAt')

    // 读路径：/bgjobs/state 的 view() 带 toasted（client 判定依据）
    const state = (await call('/bgjobs/state')).body
    assert.equal(state.jobs.find((j) => j.id === jobId).toasted, true, 'state 快照含 toasted')

    // 非法体：ids 非数组 / 缺 ids ⇒ 400（绝不 500）
    assert.equal((await call('/bgjobs/toasted', 'POST', { ids: 'x' })).status, 400)
    assert.equal((await call('/bgjobs/toasted', 'POST', {})).status, 400)
    assert.equal((await call('/bgjobs/toasted')).status, 405, '非 POST ⇒ 405')
  } finally {
    dispose()
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('webServer: bannerMemo=false ⇒ /bgjobs/toasted 直接 no-op（不写盘）；两开关经 elements 下发且有默认值', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const home = await makeDshHome()
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const call = makeClient(ctx, injectCallbacks)
    const tick = intervals.find((i) => i.ms === 1000).fn

    // 默认值：两开关都 true（缺省即现状：检测 + 记忆）；种子尚未跑 ⇒ bannerSeedVersion=0
    let prefs = (await call('/bgjobs/uiprefs')).body
    assert.equal(prefs.elements.bannerEnabled, true, 'bannerEnabled 默认 true')
    assert.equal(prefs.elements.bannerMemo, true, 'bannerMemo 默认 true')
    assert.equal(prefs.defaultElements.bannerEnabled, true)
    assert.equal(prefs.bannerSeedVersion, 0, '未跑种子时为 0')

    await tick()
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const jobDir = await submitAndFinish(submit, { name: 't', command: 'echo x', workdir }, undefined, workdir, 0, tick)
    const jobId = path.basename(jobDir)

    // 关掉 A（写回）→ 路由 no-op
    const set = await call('/bgjobs/uiprefs', 'POST', { elements: { bannerMemo: false } })
    assert.equal(set.body.elements.bannerMemo, false, '开关落盘并回显')
    assert.equal((await readJson(bgjobsFile('ui-prefs.json'))).elements.bannerMemo, false, '写进 ui-prefs.json')
    const r = await call('/bgjobs/toasted', 'POST', { ids: [jobId] })
    assert.equal(r.status, 200)
    assert.equal(r.body.skipped, 'memo-off')
    assert.equal((await readJson(path.join(jobDir, 'job.json'))).toastedAt, undefined, 'A 关 ⇒ 不写任何标记')

    // 总开关 B 也走同一条链路
    const off = await call('/bgjobs/uiprefs', 'POST', { elements: { bannerEnabled: false } })
    assert.equal(off.body.elements.bannerEnabled, false)
    assert.equal((await call('/bgjobs/uiprefs')).body.elements.bannerMemo, false, '两项互不影响')
  } finally {
    dispose()
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── C. host：一次性种子 + ready 同批置位 ─────────────────────────────────────

test('种子: 首 tick 给存量 done 补 toastedAt=seed（running 不动），bannerSeedVersion=1，ready 同批置位，且只跑一次', async () => {
  const home = await makeDshHome()
  const workdir = await makeWorkdir()
  try {
    const doneDir = await makeDiskJob(workdir, 'bg-seed-done', 'done')
    const runningDir = await makeDiskJob(workdir, 'bg-seed-running', 'running')
    await writeBgjobsIndex({
      version: 1, updatedAt: Date.now(),
      jobs: [
        { id: 'bg-seed-done', jobDir: doneDir, workdir, name: 'd', createdAt: Date.now() },
        { id: 'bg-seed-running', jobDir: runningDir, workdir, name: 'r', createdAt: Date.now() },
      ],
    }, home)
    const { ctx, intervals, injectCallbacks } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
    const dispose = apply(ctx)
    try {
      const call = makeClient(ctx, injectCallbacks)
      // tick 之前：ready=false —— client 首轮据此跳过整段横幅判定
      assert.equal((await call('/bgjobs/state')).body.ready, false, 'recover 前 ready=false')
      const tick = intervals.find((i) => i.ms === 1000).fn
      await tick()

      const doneMeta = await readJson(path.join(doneDir, 'job.json'))
      assert.equal(typeof doneMeta.toastedAt, 'number', '存量 done 被补标 toastedAt')
      assert.equal(doneMeta.toastedBy, 'seed')
      assert.equal(doneMeta.status, 'done', '补标不丢状态字段')
      assert.equal(doneMeta.exitCode, 0, '补标不丢 exitCode')
      assert.equal((await readJson(path.join(runningDir, 'job.json'))).toastedAt, undefined, 'running 不补标')
      assert.equal((await readJson(bgjobsFile('ui-prefs.json'))).bannerSeedVersion, 1, '种子版本落盘')

      const state = (await call('/bgjobs/state')).body
      assert.equal(state.ready, true, 'recover+seed 都完成后 ready=true')
      assert.equal(state.jobs.find((j) => j.id === 'bg-seed-done').toasted, true, '内存 meta 同步：本轮快照即带 toasted')

      // 只跑一次：新出现的 done 任务不再被补标（否则「关页面期间完成的任务」永远弹不出来）
      const laterDir = await makeDiskJob(workdir, 'bg-seed-later', 'done')
      await writeBgjobsIndex({
        version: 1, updatedAt: Date.now(),
        jobs: [{ id: 'bg-seed-later', jobDir: laterDir, workdir, name: 'l', createdAt: Date.now() }],
      }, home)
      await tick()
      assert.equal((await readJson(path.join(laterDir, 'job.json'))).toastedAt, undefined, '种子只跑一次：新 done 保持未标记')
    } finally { dispose() }
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})
