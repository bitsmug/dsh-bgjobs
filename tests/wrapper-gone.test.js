// bgjobs tests —— 「死任务显示运行中」的收尾判定（v0.2.3）。
//
// 缺陷：状态权威只看 `exitcode.txt` —— 包装器（run.ps1 / mcp server）**死了却没写成**它
// （GUI 子系统程序静默退出 / 包装器被非正常终止 / **重启或注销**——计划任务"仅用户登录时运行"，
// 一重启全灭且都不留退出口）时，任务**永久停在 running**：面板显示「运行中」而实际没有任何进程。
// 现场实测（2026-10-09）三条存量僵尸记录就是这个形态（run.pid 里的 pid 已不存在 +
// exitcode.txt 不存在 ⇒ 记录永久 running）。
//
// 修法：`lib/core/wrapper-gone.js` 是**唯一**收尾判定入口 —— 磁盘路径
// （registry.statusFromDisk）与内存路径（watch.checkCompletion）都汇到它；判定发生在**读取时**
// ⇒ 存量僵尸记录一查即被追认，不需要迁移脚本、也不需要人工 kill。
//
// 覆盖（对应验收四条 + 现场实测的复用陷阱）：
//   ① pid 已不存在 + 无 exitcode.txt ⇒ 判终态（exitCode: null + exitCodeSource:'wrapper-gone'
//      + reason:'pid-gone'），且**零 spawn**（tick 每 5s 调它，热路径不能起 PowerShell）
//   ② 活进程 + 无 exitcode.txt ⇒ **仍 running**（真在跑就绝不误判为死）
//   ③ run.pid 缺失 / 预检 unknown / 探针 unknown ⇒ **仍 running**（fail-safe）
//   ④ exitcode.txt 存在 ⇒ **仍以它为准**（回归，且完全不经过探活）
//   ⑤ pid 被系统复用给无关进程 ⇒ 判终态（reason:'pid-reused'），**不得**被读成"还活着"
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import {
  apply, setSchtasksRunner, setPidProbe, setOwnershipProbeClock, resetOwnershipProbeThrottle,
  resolveWrapperGone, wrapperGoneOf, WRAPPER_GONE_SOURCE, WRAPPER_REASON_PID_GONE, WRAPPER_REASON_PID_REUSED,
} from '../lib/index.js'
import { makeWorkdir, makeCtx, makeFakeRunner, runningPlugin, attachWebServer, installSuiteHooks } from './helpers/common.js'

installSuiteHooks()

/** 探针输出标记（与 lib/kill-tree.js 同口径）：`BGJOBS-PID <存在 0|1> <归属 0|1>`。 */
const PROBE_GONE = 'BGJOBS-PID 0 0'
const PROBE_ALIVE_OWNED = 'BGJOBS-PID 1 1'
const PROBE_ALIVE_FOREIGN = 'BGJOBS-PID 1 0'
/** 只读查询脚本恒含 Win32_Process；用它把"探针调用"从其它 schtasks 调用里择出来。 */
const isProbeCall = (argv) => String((argv || []).join(' ')).includes('Win32_Process')

/** 造一个「running 但无退出码」的任务目录（可选 run.pid 文件名 / pid / exitcode.txt）。 */
async function makeJobDir(options = {}) {
  const workdir = await makeWorkdir()
  const jobId = options.jobId || 'bg-wg-1'
  const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
  await fsp.mkdir(jobDir, { recursive: true })
  const meta = {
    id: jobId, name: 'wg', workdir, jobDir,
    logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
    jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-' + jobId,
    command: 'echo x', status: 'running', createdAt: Date.now(),
  }
  await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(meta), 'utf8')
  await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'line1\n', 'utf8')
  if (options.pid !== undefined && options.pid !== null) {
    await fsp.writeFile(path.join(jobDir, options.pidFile || 'run.pid'), String(options.pid), 'utf8')
  }
  if (options.exitCode !== undefined) {
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), String(options.exitCode), 'utf8')
  }
  return { workdir, jobId, jobDir, meta }
}

/** 清理：恢复注入缝 + 清节流表 + 删临时目录（每个用例 finally 里调）。 */
async function cleanup(workdir) {
  setPidProbe(null)
  setOwnershipProbeClock(null)
  resetOwnershipProbeThrottle()
  if (workdir) await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
}

// ── ① pid 已不存在 ⇒ 终态，且零 spawn ─────────────────────────────────────────

test('wrapper-gone ① 判定入口：pid 已不存在 + 无 exitcode ⇒ 终态（无退出码，但留下"为何这样判"）', async () => {
  const { meta, workdir } = await makeJobDir({ pid: 4242 })
  try {
    const calls = []
    setSchtasksRunner(makeFakeRunner(calls))
    setPidProbe(() => 'gone')
    const gone = await resolveWrapperGone(meta)
    assert.notEqual(gone, null, 'pid 都不存在了 ⇒ 包装器必然已消失')
    assert.equal(gone.exitCode, null, '★ 无退出码是事实：绝不编一个码（如实记 null）')
    assert.equal(gone.exitCodeSource, WRAPPER_GONE_SOURCE, '来源必须可区分（与 killed 并列的第二种）')
    assert.equal(gone.wrapperGoneReason, WRAPPER_REASON_PID_GONE, '记下判据：pid 不存在')
    assert.equal(gone.wrapperGonePid, 4242, '记下判据 pid')
    assert.equal(gone.wrapperGoneFile, 'run.pid', '记下判据来自哪个 pid 文件')
    assert.equal(typeof gone.wrapperGoneAt, 'number', '记下判定时刻（事后审计）')
    assert.deepEqual(calls, [], '★ 这条路径必须**零 spawn**（tick 每 5s 调它，不许起 PowerShell）')
  } finally {
    await cleanup(workdir)
  }
})

// ── ② 活进程 ⇒ 仍 running ────────────────────────────────────────────────────

test('wrapper-gone ② 活进程（属于本任务）+ 无 exitcode ⇒ 仍 running（不许误判为死）', async () => {
  const { meta, workdir } = await makeJobDir({ pid: 4242 })
  try {
    const calls = []
    setSchtasksRunner(async (argv) => { calls.push(argv); return { exitCode: 0, stdout: PROBE_ALIVE_OWNED, stderr: '' } })
    setPidProbe(() => 'alive')
    assert.equal(await resolveWrapperGone(meta), null, '进程还在且是本任务的 ⇒ 保持 running')
    assert.equal(calls.filter(isProbeCall).length, 1, '归属复核走一次既有探针')
  } finally {
    await cleanup(workdir)
  }
})

test('wrapper-gone ②b 归属复核按任务目录**节流**：同一任务目录的连续调用不重复起探针（tick 每 5s 调一次）', async () => {
  const { meta, workdir } = await makeJobDir({ pid: 4243 })
  try {
    const calls = []
    setSchtasksRunner(async (argv) => { calls.push(argv); return { exitCode: 0, stdout: PROBE_ALIVE_OWNED, stderr: '' } })
    setPidProbe(() => 'alive')
    const t0 = Date.now()
    setOwnershipProbeClock(() => t0)
    assert.equal(await resolveWrapperGone(meta), null)
    assert.equal(await resolveWrapperGone(meta), null)
    assert.equal(await resolveWrapperGone(meta), null)
    assert.equal(calls.filter(isProbeCall).length, 1, '窗口内只复核一次（正常在跑的任务不该被反复探测）')
    // 过了窗口才允许再复核一次（pid 此后被复用也能被发现）。
    setOwnershipProbeClock(() => t0 + 5 * 60 * 1000 + 1)
    assert.equal(await resolveWrapperGone(meta), null)
    assert.equal(calls.filter(isProbeCall).length, 2, '窗口过后重新复核')
  } finally {
    await cleanup(workdir)
  }
})

// ── ③ fail-safe：无 pid 文件 / 说不清 ⇒ 仍 running ───────────────────────────

test('wrapper-gone ③a 没有 pid 文件 ⇒ 仍 running（少一个确证就不改状态；不做反查）', async () => {
  const { meta, workdir } = await makeJobDir({}) // 不写 run.pid
  try {
    const calls = []
    setSchtasksRunner(makeFakeRunner(calls))
    setPidProbe(() => 'gone') // 连"预检说死"也不该被采信：没有 pid 可查
    assert.equal(await resolveWrapperGone(meta), null, '无 pid 文件 ⇒ 保持 running')
    assert.deepEqual(calls, [], '无 pid 文件时连探针都不该起')
  } finally {
    await cleanup(workdir)
  }
})

test('wrapper-gone ③b 存活预检说不清（unknown）⇒ 仍 running，且不起探针', async () => {
  const { meta, workdir } = await makeJobDir({ pid: 4244 })
  try {
    const calls = []
    setSchtasksRunner(makeFakeRunner(calls))
    setPidProbe(() => 'unknown')
    assert.equal(await resolveWrapperGone(meta), null, 'unknown ≠ 死 ⇒ 保持 running')
    assert.deepEqual(calls, [], '预检说不清 ⇒ 不起探针猜')
  } finally {
    await cleanup(workdir)
  }
})

test('wrapper-gone ③c 归属复核不可用（探针 unknown）⇒ 仍 running（探针跑不起来不得当作死）', async () => {
  const { meta, workdir } = await makeJobDir({ pid: 4245 })
  try {
    setSchtasksRunner(async () => ({ exitCode: 1, stdout: '', stderr: 'probe failed' }))
    setPidProbe(() => 'alive')
    assert.equal(await resolveWrapperGone(meta), null, '复核说不清 ⇒ 保持 running')
  } finally {
    await cleanup(workdir)
  }
})

test('wrapper-gone ③d 预检说"活"、复核却说"已消失"（两个信号打架）⇒ 一律不动状态（等下一轮预检再判）', async () => {
  const { meta, workdir } = await makeJobDir({ pid: 4246 })
  try {
    setSchtasksRunner(async () => ({ exitCode: 0, stdout: PROBE_GONE, stderr: '' }))
    setPidProbe(() => 'alive') // 预检说活、探针说死：两个信号打架 ⇒ 保守不动
    assert.equal(await resolveWrapperGone(meta), null, '信号不一致 ⇒ 保持 running')
  } finally {
    await cleanup(workdir)
  }
})

// ── ⑤ pid 复用：活着但不是本任务的包装器 ⇒ 终态 ───────────────────────────────

test('wrapper-gone ⑤ pid 被复用给无关进程（run.pid 活着但命令行不含 jobDir）⇒ 终态 reason:pid-reused，不得读成"还活着"', async () => {
  const { meta, workdir } = await makeJobDir({ pid: 4247 })
  try {
    setSchtasksRunner(async () => ({ exitCode: 0, stdout: PROBE_ALIVE_FOREIGN, stderr: '' }))
    setPidProbe(() => 'alive')
    const gone = await resolveWrapperGone(meta)
    assert.notEqual(gone, null, '该 pid 上是无关进程 ⇒ 本任务包装器确已消失')
    assert.equal(gone.wrapperGoneReason, WRAPPER_REASON_PID_REUSED)
    assert.equal(gone.exitCodeSource, WRAPPER_GONE_SOURCE)
    assert.equal(gone.exitCode, null)
  } finally {
    await cleanup(workdir)
  }
})

test('wrapper-gone ⑤b mcp-server.pid 不做归属核验（其命令行天然不含 jobDir）⇒ 仍 running', async () => {
  const { meta, workdir } = await makeJobDir({ pid: 4248, pidFile: 'mcp-server.pid' })
  try {
    setSchtasksRunner(async () => ({ exitCode: 0, stdout: PROBE_ALIVE_FOREIGN, stderr: '' }))
    setPidProbe(() => 'alive')
    assert.equal(await resolveWrapperGone(meta), null, 'mcp-server.pid 沿用既有"只看存活"口径')
  } finally {
    await cleanup(workdir)
  }
})

// ── 投影字段（view / statusFromDisk / bgjob_status 共用同一份）──────────────────

test('wrapper-gone 投影：只对 wrapper-gone 来源给字段（其它来源返回空对象，消费方 spread 后零影响）', () => {
  assert.deepEqual(wrapperGoneOf({ exitCodeSource: 'killed', killedAt: 1 }), {}, 'killed 来源不该被投影成 wrapper-gone')
  assert.deepEqual(wrapperGoneOf({}), {})
  const fields = wrapperGoneOf({ exitCodeSource: WRAPPER_GONE_SOURCE, wrapperGoneReason: 'pid-gone', wrapperGoneAt: 123, wrapperGonePid: 7, wrapperGoneFile: 'run.pid' })
  assert.equal(fields.wrapperGone, true)
  assert.equal(fields.exitCodeSource, WRAPPER_GONE_SOURCE)
  assert.equal(fields.wrapperGoneReason, 'pid-gone')
  assert.equal(fields.wrapperGoneAt, 123)
  assert.equal(fields.wrapperGonePid, 7)
  assert.equal(fields.wrapperGoneFile, 'run.pid')
  // 字段缺失时不抛、如实给 null。
  assert.deepEqual(wrapperGoneOf({ exitCodeSource: WRAPPER_GONE_SOURCE }), {
    exitCodeSource: WRAPPER_GONE_SOURCE, wrapperGone: true, wrapperGoneReason: null,
    wrapperGoneAt: null, wrapperGonePid: null, wrapperGoneFile: null,
  })
})

// ── 磁盘路径（bgjob_status 的磁盘回退；★ 存量僵尸记录就是靠这条追认的）──────────

/** 通过 bgjob_status 工具走磁盘回退路径。 */
async function diskStatus(workdir, jobId) {
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [{ path: workdir }] } } })
  const dispose = apply(ctx)
  try {
    const status = tools.find((t) => t.name === 'bgjob_status')
    return await status.execute({ jobId })
  } finally {
    dispose()
  }
}

test('wrapper-gone ①b 磁盘路径（存量僵尸记录）：死 pid + 无 exitcode ⇒ 一查即给终态，并说明为何这样判', async () => {
  const { jobDir, workdir, jobId, meta } = await makeJobDir({ pid: 4242 })
  try {
    const calls = []
    setSchtasksRunner(makeFakeRunner(calls))
    setPidProbe(() => 'gone')
    const st = await diskStatus(workdir, jobId)
    assert.equal(st.error, undefined)
    assert.equal(st.status, 'done', '★ 包装器已消失 ⇒ 必须给终态（存量僵尸不再永久"运行中"）')
    assert.equal(st.exitCode, null, '没有退出码就如实给 null')
    assert.equal(st.exitCodeSource, WRAPPER_GONE_SOURCE)
    assert.equal(st.wrapperGone, true)
    assert.equal(st.wrapperGoneReason, WRAPPER_REASON_PID_GONE)
    assert.equal(st.wrapperGonePid, 4242)
    assert.equal(st.wrapperGoneFile, 'run.pid')
    assert.equal(typeof st.wrapperGoneAt, 'number')
    assert.deepEqual(calls, [], '零 spawn：判定不依赖 PowerShell')
    // 只读查询：判定不改盘上 job.json（落盘终态是内存路径的职责）。
    const onDisk = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(onDisk.status, 'running', '磁盘回退保持只读：不改写 job.json')
    assert.equal(meta.status, 'running')
  } finally {
    await cleanup(workdir)
  }
})

test('wrapper-gone ②c 磁盘路径：活进程（属于本任务）+ 无 exitcode ⇒ 仍 running', async () => {
  const { workdir, jobId } = await makeJobDir({ pid: 4242 })
  try {
    setSchtasksRunner(async () => ({ exitCode: 0, stdout: PROBE_ALIVE_OWNED, stderr: '' }))
    setPidProbe(() => 'alive')
    const st = await diskStatus(workdir, jobId)
    assert.equal(st.status, 'running')
    assert.equal(st.exitCode, null)
    assert.equal(st.wrapperGone, undefined, '还在跑 ⇒ 不出现终态来源标记')
    assert.equal(st.exitCodeSource, undefined)
  } finally {
    await cleanup(workdir)
  }
})

test('wrapper-gone ⑤c 磁盘路径：pid 已被复用给无关进程 ⇒ 终态 reason:pid-reused（不误判存活）', async () => {
  const { workdir, jobId } = await makeJobDir({ pid: 4242 })
  try {
    setSchtasksRunner(async () => ({ exitCode: 0, stdout: PROBE_ALIVE_FOREIGN, stderr: '' }))
    setPidProbe(() => 'alive')
    const st = await diskStatus(workdir, jobId)
    assert.equal(st.status, 'done')
    assert.equal(st.wrapperGoneReason, WRAPPER_REASON_PID_REUSED)
  } finally {
    await cleanup(workdir)
  }
})

test('wrapper-gone ③e 磁盘路径：run.pid 缺失 ⇒ 仍 running（fail-safe）', async () => {
  const { workdir, jobId } = await makeJobDir({})
  try {
    setSchtasksRunner(makeFakeRunner([]))
    setPidProbe(() => 'gone')
    const st = await diskStatus(workdir, jobId)
    assert.equal(st.status, 'running', '无 pid 文件 ⇒ 保守保持 running')
  } finally {
    await cleanup(workdir)
  }
})

test('wrapper-gone ④ 回归：exitcode.txt 存在 ⇒ 依旧以它为准（7），且完全不经过探活', async () => {
  const { workdir, jobId } = await makeJobDir({ pid: 4242, exitCode: 7 })
  try {
    const calls = []
    setSchtasksRunner(makeFakeRunner(calls))
    setPidProbe(() => 'gone') // 就算 pid 没了，退出码说了算
    const st = await diskStatus(workdir, jobId)
    assert.equal(st.status, 'done')
    assert.equal(st.exitCode, 7, '退出码是权威：探活不得覆盖它')
    assert.equal(st.exitCodeSource, undefined, '正常退出码不携带"无退出码"来源')
    assert.deepEqual(calls, [], '退出码可读 ⇒ 一步探针都不该走（既有语义不变）')
  } finally {
    await cleanup(workdir)
  }
})

// ── 内存路径（fs.watch + 5s 兜底 tick）────────────────────────────────────────

test('wrapper-gone ①c 内存路径：tick 发现包装器已消失 ⇒ 落盘终态 + 状态快照带上来源字段', async () => {
  const workdir = await makeWorkdir()
  setPidProbe(() => 'gone')
  setSchtasksRunner(makeFakeRunner([]))
  const { ctx, tools, injectCallbacks, dispose, res, tick } = await runningPlugin(workdir, { agent: undefined })
  try {
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    // 真实样本的形态：任务被提交过，包装器留下过 pid 文件，但进程已经没了、exitcode.txt 也没写。
    await fsp.writeFile(path.join(jobDir, 'run.pid'), '4242', 'utf8')
    await tick()
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done', '★ tick 必须把它收尾（否则永久 running）')
    assert.equal(meta.exitCode, null)
    assert.equal(meta.exitCodeSource, WRAPPER_GONE_SOURCE)
    assert.equal(meta.wrapperGoneReason, WRAPPER_REASON_PID_GONE)
    assert.equal(meta.wrapperGonePid, 4242)
    assert.equal(meta.wrapperGoneFile, 'run.pid')
    // /bgjobs/state 快照（面板口径）也带同一份来源字段。
    const getState = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getState().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const job = JSON.parse(body).jobs.find((j) => j.id === res.jobId)
    assert.equal(job.status, 'done')
    assert.equal(job.exitCode, null)
    assert.equal(job.exitCodeSource, WRAPPER_GONE_SOURCE)
    assert.equal(job.wrapperGone, true)
    assert.equal(job.wrapperGoneReason, WRAPPER_REASON_PID_GONE)
    assert.equal(job.wrapperGoneFile, 'run.pid')
    // bgjob_status（内存路径）同样带上来源字段。
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId: res.jobId })
    assert.equal(st.status, 'done')
    assert.equal(st.exitCodeSource, WRAPPER_GONE_SOURCE)
    assert.equal(st.wrapperGone, true)
  } finally {
    dispose()
    await cleanup(workdir)
  }
})

test('wrapper-gone ②d 内存路径：包装器还活着 + 无 exitcode ⇒ tick 后仍是 running', async () => {
  const workdir = await makeWorkdir()
  setPidProbe(() => 'alive')
  setSchtasksRunner(async () => ({ exitCode: 0, stdout: PROBE_ALIVE_OWNED, stderr: '' }))
  const { dispose, res, tick } = await runningPlugin(workdir, { agent: undefined })
  try {
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'run.pid'), '4242', 'utf8')
    await tick()
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'running', '进程还在 ⇒ 绝不能被收尾')
    assert.equal(meta.exitCodeSource, undefined)
  } finally {
    dispose()
    await cleanup(workdir)
  }
})
