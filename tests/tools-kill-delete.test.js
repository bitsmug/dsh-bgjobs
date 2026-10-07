// bgjobs tests —— agent 侧的两个新工具入口：`bgjob_kill`（只终止进程、不删记录）
//   与 `bgjob_delete`（只删记录、不杀进程；有活进程则拒绝）。
//
// 为什么单独一个文件：`tests/tools.test.js` 管"注册契约与 guidance"，`tests/kill-tree.test.js`
//   管 host 路由（/bgjobs/kill、/bgjobs/delete）的语义。本文件管的是**工具层**这一层：
//   agent 真能拿到两个入口、形状与既有 8 个工具一致、并把参数**原样转达**给 host 的
//   `killJob` / `removeJob`（工具层不新造语义、不复制字段与文案）。
//
// 注入缝与判据全部沿用 tests/kill-tree.test.js（**绝不真杀进程**、绝不真起计划任务）：
//   `setSchtasksRunner(makeKillRunner(...))` 造"有活进程 / 无活进程 / 无法判定"三种现场。
// 判据一律**单引号字面量 + 整串相等 + 先打印期望值**（文案唯一来源仍是 lib/core/web.js）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { apply, setSchtasksRunner, setShellResolver } from '../lib/index.js'
import { makeWorkdir, makeCtx, attachWebServer, installSuiteHooks, waitFor } from './helpers/common.js'

installSuiteHooks()

// ── 与 lib/kill-tree.js 的探针标记同格式（与 tests/kill-tree.test.js 逐字同源）──────────
const PROBE_ALIVE_OWNED = 'BGJOBS-PID 1 1'
const PROBE_GONE = 'BGJOBS-PID 0 0'
/** 反查脚本非零退出 ⇒ 原始失败文案固定为这一串（makeKillRunner 的 proclistError）。 */
const UNKNOWN_REASON = 'process query exit 1: ERROR: query failed'
/** host 的 absent note（唯一来源 = lib/core/web.js 的 absent 分支）——整串相等钉死。 */
const HOST_ABSENT_NOTE = '未发现该任务的活进程 ⇒ 无可终止；kill 只终止进程，本次未删除任何记录（job 目录/索引/注册表原封不动），要清记录请调用 delete'

const joined = (argv) => argv.map(String).join(' ')
const isProcessList = (argv) => joined(argv).includes('BGJOBS-PROC')
const isProbe = (argv) => joined(argv).includes('Win32_Process') && !isProcessList(argv)
const isTaskkill = (argv) => String(argv[0]).toLowerCase().includes('taskkill')
const probePidOf = (argv) => {
  const hit = joined(argv).match(/ProcessId=(\d+)/)
  return hit === null ? null : hit[1]
}

/**
 * 可编排的 fake runner（复制 tests/kill-tree.test.js 的 makeKillRunner，语义一致）：
 *   - 带 `Win32_Process` 且不带 `BGJOBS-PROC` = pid 探针：`probes` 按 pid 精确作答，否则 probeQueue/probe；
 *   - 带 `BGJOBS-PROC` = 反查查询：`proclistError` ⇒ 非零退出（模拟"查询本身跑不起来" ⇒ 无法判定）；
 *   - 带 `taskkill` = 树杀：killExit / killExitByPid；
 *   - 其余（schtasks /End、/Delete）= exit 0。
 * 顺序要紧：反查脚本同样含 `Win32_Process`，必须先认 `BGJOBS-PROC`，否则反查会被误当探针。
 */
function makeKillRunner(options = {}) {
  const probeQueue = Array.isArray(options.probeQueue) ? options.probeQueue.slice() : null
  const fixedProbe = options.probe === undefined ? PROBE_GONE : options.probe
  const probes = options.probes === undefined ? {} : options.probes
  const proclistQueue = Array.isArray(options.proclistQueue) ? options.proclistQueue.slice() : null
  const fixedProclist = options.proclist === undefined ? '' : options.proclist
  const killExit = options.killExit === undefined ? 0 : options.killExit
  const killExitByPid = options.killExitByPid === undefined ? {} : options.killExitByPid
  const calls = []
  const runner = async (argv) => {
    calls.push(Object.assign(argv, { script: joined(argv) }))
    if (isProcessList(argv)) {
      if (options.proclistError === true) return { exitCode: 1, stdout: '', stderr: 'ERROR: query failed' }
      const out = proclistQueue !== null && proclistQueue.length > 0 ? proclistQueue.shift() : fixedProclist
      return { exitCode: 0, stdout: out, stderr: '' }
    }
    if (isProbe(argv)) {
      const probedPid = probePidOf(argv)
      if (probedPid !== null && probes[probedPid] !== undefined) {
        return { exitCode: 0, stdout: probes[probedPid], stderr: '' }
      }
      const out = probeQueue !== null && probeQueue.length > 0 ? probeQueue.shift() : fixedProbe
      return { exitCode: 0, stdout: out, stderr: '' }
    }
    if (isTaskkill(argv)) {
      const killedPid = String(argv[2])
      const code = killExitByPid[killedPid] === undefined ? killExit : killExitByPid[killedPid]
      return { exitCode: code, stdout: '', stderr: code === 0 ? '' : 'ERROR: access denied' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  runner.calls = calls
  return runner
}

/** 非法动作断言：不得有任何 taskkill / schtasks /End / /Delete（= "什么都没做"）。 */
function assertNoDestructiveCall(runner, label) {
  const destructive = runner.calls.filter((argv) => isTaskkill(argv)
    || joined(argv).includes('/End') || joined(argv).includes('/Delete'))
  assert.deepEqual(destructive.map((argv) => joined(argv)), [], label)
}

/** 索引写回是 fire-and-forget 且非原子（截断+重写）：读到半截 JSON 按"还没写完"重试。 */
async function readIndexJobs(indexFile) {
  let jobs = null
  await waitFor(async () => {
    try { jobs = JSON.parse(await fsp.readFile(indexFile, 'utf8')).jobs; return true } catch { return false }
  })
  return jobs
}

/** host 的两条路由都在用的记录契约：job 目录 / 中央索引 / 注册表条目**三样都在**。 */
async function assertRecordsKept(jobDir, jobId, call) {
  assert.notEqual(await fsp.stat(jobDir).catch(() => null), null, '记录契约 ⇒ job 目录必须还在')
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  const jobs = await readIndexJobs(indexFile)
  assert.ok(jobs.some((entry) => entry.id === jobId), '记录契约 ⇒ 中央索引条目必须还在')
  const state = await call('/bgjobs/state')
  assert.ok(state.jobs.some((job) => job.id === jobId), '记录契约 ⇒ 注册表条目必须还在')
}

/** 轮询到索引里那条真的消失（删记录之后用）。 */
async function waitIndexGone(indexFile, jobId) {
  await waitFor(async () => {
    let index
    try { index = JSON.parse(await fsp.readFile(indexFile, 'utf8')) } catch { return false }
    return index.jobs.some((entry) => entry.id === jobId) === false
  })
}

/**
 * 提交一个 pwsh 任务（默认保持 running，绝不真起计划任务），并把工具层需要的现场都备齐。
 * 与 tests/kill-tree.test.js 的 seedJob 同构：返回 `{ res, jobDir, call, dispose, workdir, tools }`。
 */
async function seedJob(options = {}) {
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools, injectCallbacks } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
  const res = await submit.execute({ name: 't', command: 'Start-Sleep -Seconds 30', workdir }, { agent: undefined })
  assert.equal(res.ok, true, '提交应成功')
  const jobDir = path.join(workdir, '.dsh', 'bgjobs', res.jobId)
  if (options.pidFile !== undefined) {
    await fsp.writeFile(path.join(jobDir, options.pidFile), String(options.pid === undefined ? 4242 : options.pid), 'utf8')
  }
  const handler = attachWebServer(ctx, injectCallbacks)().handler
  const call = (url) => new Promise((resolve) => {
    handler({ url }, { writeHead: () => {}, end: (b) => resolve(JSON.parse(b || '{}')) })
  })
  return { res, jobDir, call, dispose, workdir, tools }
}

/** 工具层入口（拿不到就 fail loud，别让"工具没注册"变成后续断言里的 undefined 噪音）。 */
function toolOf(tools, name) {
  const tool = tools.find((entry) => entry.name === name)
  assert.ok(tool, name + ' 必须已注册（期望注册面含 ' + name + '，实际 ' + tools.map((t) => t.name).join(',') + '）')
  return tool
}

// ── ① 注册面：工具数 8 → 10，两个新工具形状与既有工具一致 ─────────────────────

test('tools: 注册面 8 → 10 —— bgjob_kill / bgjob_delete 在列且形状与既有工具一致', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  try {
    const expectedCount = 10
    console.log('  期望工具数 =', expectedCount)
    assert.equal(tools.length, expectedCount, '新增两个工具入口 ⇒ 注册面 8 → 10（期望 ' + expectedCount + '，实际 ' + tools.length + '）')
    const expectedNames = ['bgjob_delete', 'bgjob_kill', 'bgjob_list', 'bgjob_mcp_tools', 'bgjob_pending_list', 'bgjob_status', 'bgjob_submit', 'bgjob_submit_mcp', 'bgjob_submit_pwsh', 'bgjob_wait']
    console.log('  期望工具名集合 =', JSON.stringify(expectedNames))
    assert.deepEqual(tools.map((t) => t.name).sort(), expectedNames)
    for (const name of ['bgjob_kill', 'bgjob_delete']) {
      const tool = toolOf(tools, name)
      assert.equal(typeof tool.execute, 'function', name + ' 必须有 execute')
      assert.equal(typeof tool.presentCall, 'function', name + ' 必须有 presentCall')
      assert.equal(typeof tool.output.render, 'function', name + ' 必须有 output.render')
      assert.equal(typeof tool.output.schema, 'object', name + ' 必须有 output.schema')
      assert.ok(tool.output.schema.required.includes('ok'), name + ' 的 output.schema.required 必须含 ok')
      assert.equal(tool.parameters.type, 'object', name + ' 的 parameters 必须是 object')
      const expectedRequired = ['jobId']
      console.log('  期望 ' + name + '.parameters.required =', JSON.stringify(expectedRequired))
      assert.deepEqual(tool.parameters.required, expectedRequired, name + ' 只要求 jobId（命名跟既有工具：jobId 驼峰）')
      assert.equal(tool.parameters.properties.jobId.type, 'string', name + ' 的 jobId 是 string')
      assert.equal(tool.parameters.properties.force.type, 'boolean', name + ' 的 force 是 boolean')
      assert.equal(tool.parameters.properties.force.default, false, name + ' 的 force 缺省必须是 false')
      assert.equal(typeof tool.description, 'string', name + ' 必须有描述')
    }
    // presentCall 形状照既有工具（标题各不相同，逐字钉死）
    const expectedKillTitle = '终止后台任务'
    const expectedDeleteTitle = '删除任务记录'
    console.log('  期望 bgjob_kill.presentCall =', JSON.stringify({ card: 'generic', title: expectedKillTitle, kind: 'execute', rawInput: 'bg-x' }))
    console.log('  期望 bgjob_delete.presentCall =', JSON.stringify({ card: 'generic', title: expectedDeleteTitle, kind: 'execute', rawInput: 'bg-x' }))
    assert.deepEqual(toolOf(tools, 'bgjob_kill').presentCall({ jobId: 'bg-x' }), {
      card: 'generic', title: expectedKillTitle, kind: 'execute', rawInput: 'bg-x',
    })
    assert.deepEqual(toolOf(tools, 'bgjob_delete').presentCall({ jobId: 'bg-x' }), {
      card: 'generic', title: expectedDeleteTitle, kind: 'execute', rawInput: 'bg-x',
    })
    // reason 只在 kill 侧有（delete 没有"原因"这回事：它没有对应的落盘字段）
    assert.equal(typeof toolOf(tools, 'bgjob_kill').parameters.properties.reason, 'object', 'bgjob_kill 必须有可选 reason')
    assert.equal(toolOf(tools, 'bgjob_delete').parameters.properties.reason, undefined, 'bgjob_delete 不该有 reason（host 无对应字段）')
    // 描述必须写明两条边界（用户最容易误解的地方）
    const killDescription = toolOf(tools, 'bgjob_kill').description
    const deleteDescription = toolOf(tools, 'bgjob_delete').description
    for (const [label, text, needle] of [
      ['bgjob_kill', killDescription, '不删记录'],
      ['bgjob_kill', killDescription, 'force'],
      ['bgjob_delete', deleteDescription, '不杀进程'],
      ['bgjob_delete', deleteDescription, '拒绝'],
    ]) {
      console.log('  期望 ' + label + '.description 含：' + needle)
      assert.ok(text.includes(needle), label + ' 的描述必须写明「' + needle + '」')
    }
  } finally {
    dispose()
  }
})

// ── ② 有活进程 ⇒ kill：真终止 + 记录全留 + 仍可用 bgjob_status 查到 ─────────────

test('tools: bgjob_kill(有活进程) ⇒ mode:kill + killed:true + 记录全留，且 bgjob_status 仍查得到', async () => {
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED, PROBE_GONE] })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir, tools } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  try {
    const killTool = toolOf(tools, 'bgjob_kill')
    // reason 记进 job.json 的 killedBy（审计：谁/为什么终止的）
    const killResult = await killTool.execute({ jobId: res.jobId, reason: 'agent-test-reason' }, { agent: undefined })
    assert.equal(killResult.ok, true, '存活核验通过 ⇒ ok')
    assert.equal(killResult.mode, 'kill', '有活进程 ⇒ kill 语义')
    assert.equal(killResult.killed, true, '确实终止了进程')
    assert.equal(killResult.recordsKept, true, 'kill 路径的记录契约：一律保留')
    assert.equal(killResult.exitCode, 1, 'host 补写的退出码 = taskkill 的真实记录值 1')
    assert.equal(killResult.exitCodeSource, undefined,
      'host 的 kill 返回值**本来就没有** exitCodeSource 字段（它落在 job.json 里）——工具层不许自己造一个')
    assert.ok(runner.calls.some(isTaskkill), '必须调用 taskkill')
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.exitCodeSource, 'killed')
    const expectedKilledBy = 'agent-test-reason'
    console.log('  期望 job.json.killedBy =', expectedKilledBy)
    assert.equal(meta.killedBy, expectedKilledBy, 'reason 必须落进 killedBy（审计）')
    // ★ 计划的核心断言：kill 之后**记录仍在**，bgjob_status 还查得到这个任务
    const statusTool = toolOf(tools, 'bgjob_status')
    const statusAfterKill = await statusTool.execute({ jobId: res.jobId }, { agent: undefined })
    assert.equal(statusAfterKill.error, undefined, 'kill 不删记录 ⇒ bgjob_status 不该回 job not found（实际 ' + String(statusAfterKill.error) + '）')
    assert.equal(statusAfterKill.id, res.jobId, 'bgjob_status 应仍能查到该任务')
    assert.equal(statusAfterKill.status, 'done', '已被终止 ⇒ 终态 done')
    assert.equal(statusAfterKill.exitCode, 1, 'bgjob_status 读到的仍是被终止的真值 1')
    assert.equal(statusAfterKill.exitCodeSource, 'killed', 'bgjob_status 必须能区分"被终止"与"自己以 1 退出"')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('tools: bgjob_kill(不带 reason) ⇒ job.json.killedBy 仍是既有缺省 "kill"（缺省行为一字未改）', async () => {
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED, PROBE_GONE] })
  setSchtasksRunner(runner)
  const { res, jobDir, dispose, workdir, tools } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  try {
    const killResult = await toolOf(tools, 'bgjob_kill').execute({ jobId: res.jobId }, { agent: undefined })
    assert.equal(killResult.ok, true)
    assert.equal(killResult.mode, 'kill')
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    const expectedKilledBy = 'kill'
    console.log('  期望 job.json.killedBy =', expectedKilledBy)
    assert.equal(meta.killedBy, expectedKilledBy, '不传 reason ⇒ 缺省仍是 "kill"（既有调用方行为不变）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ③ 无活进程 ⇒ absent：**真的一动没动** ────────────────────────────────────

test('tools: bgjob_kill(无活进程) ⇒ mode:absent + note，且 job 目录/索引/注册表三样原封不动、零破坏性调用', async () => {
  const runner = makeKillRunner({ proclist: '' })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir, tools } = await seedJob({})
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const killResult = await toolOf(tools, 'bgjob_kill').execute({ jobId: res.jobId }, { agent: undefined })
    assert.equal(killResult.ok, true, '没有进程可杀不是失败（如实处理了本次请求）')
    assert.equal(killResult.mode, 'absent', '未发现本任务的活进程 ⇒ absent（不是"内部转 delete"）')
    assert.equal(killResult.killed, false, '没终止任何进程')
    assert.equal(killResult.recordsKept, true, '记录契约：一律保留')
    console.log('  期望 kill absent note =', HOST_ABSENT_NOTE)
    assert.equal(killResult.note, HOST_ABSENT_NOTE, 'note 必须整串等于 host 的「未发现活进程」文案')
    // ★★ 无可终止 ⇒ 什么都不做：不 taskkill、不动计划任务注册
    assertNoDestructiveCall(runner, '无活进程 ⇒ 绝不 taskkill、也不 /End、不 /Delete（什么都别做）')
    // ★ 三样记录都在
    await assertRecordsKept(jobDir, res.jobId, call)
    assert.ok((await readIndexJobs(indexFile)).some((entry) => entry.id === res.jobId), 'kill 不删记录 ⇒ 索引条目必须还在')
    // ★ 也别补写退出码（没杀任何东西，不许把无辜任务标成"被终止"）
    assert.equal(await fsp.readFile(path.join(jobDir, 'exitcode.txt'), 'utf8').catch(() => null), null,
      '没杀任何东西 ⇒ 绝不补写退出码')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ④ bgjob_delete：有活进程拒绝 / 无活进程删净 / unknown 门槛 ─────────────────

test('tools: bgjob_delete(有活进程) ⇒ **拒绝**（mode:kill）且记录一条都没动', async () => {
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED] })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir, tools } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  try {
    const deleteResult = await toolOf(tools, 'bgjob_delete').execute({ jobId: res.jobId }, { agent: undefined })
    assert.equal(deleteResult.ok, false, 'delete 只删记录 ⇒ 有活进程必须拒绝，绝不越界杀进程')
    assert.equal(deleteResult.mode, 'kill', '与 host 口径一致：拒绝时回 mode:"kill"（提示先 kill）')
    assert.equal(deleteResult.jobDirRemoved, false, 'job 目录必须原封不动')
    assert.equal(deleteResult.registryRemoved, false, '注册表条目必须原封不动')
    assert.equal(deleteResult.indexRemoved, false, '中央索引条目必须原封不动')
    assert.equal(typeof deleteResult.error, 'string', '必须给出原因（提示先 kill）')
    console.log('  delete 拒绝时的 error =', deleteResult.error)
    assert.ok(deleteResult.error.includes('请先 kill'), 'error 必须提示先 kill（实际 ' + deleteResult.error + '）')
    assertNoDestructiveCall(runner, '拒绝 ⇒ 绝不 taskkill、也不动计划任务注册')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('tools: bgjob_delete(无活进程) ⇒ 删净（mode:delete）：目录/索引/注册表三样都消失', async () => {
  const runner = makeKillRunner({ proclist: '' })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir, tools } = await seedJob({})
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const deleteResult = await toolOf(tools, 'bgjob_delete').execute({ jobId: res.jobId }, { agent: undefined })
    assert.equal(deleteResult.ok, true, '无活进程 ⇒ 照常删记录')
    assert.equal(deleteResult.mode, 'delete', '只删记录 ⇒ mode:"delete"')
    assert.equal(deleteResult.jobDirRemoved, true, 'job 目录必须被删掉')
    assert.equal(deleteResult.registryRemoved, true, '注册表条目必须被删掉')
    assert.equal(deleteResult.indexRemoved, true, '中央索引条目必须被删掉')
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, 'job 目录才真的消失')
    const state = await call('/bgjobs/state')
    assert.equal(state.jobs.some((job) => job.id === res.jobId), false, '注册表条目才真的消失')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('tools: bgjob_delete(无法判定) ⇒ 不带 force 不动作、带 force 照做（forced:true）', async () => {
  const runner = makeKillRunner({ proclistError: true })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir, tools } = await seedJob({})
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const deleteTool = toolOf(tools, 'bgjob_delete')
    // (i) 不带 force：不删任何记录
    const blocked = await deleteTool.execute({ jobId: res.jobId }, { agent: undefined })
    assert.equal(blocked.ok, false, '无法判定 ⇒ 绝不谎报删除成功')
    assert.equal(blocked.mode, 'unknown')
    assert.equal(blocked.needsForce, true, '必须明确指示需要 force（期望 needsForce=true，实际 ' + blocked.needsForce + '）')
    assert.equal(blocked.forced, undefined, '不带 force ⇒ 绝不得出现 forced 标记')
    assert.equal(blocked.jobDirRemoved, false, 'job 目录必须原封不动')
    assert.equal(blocked.registryRemoved, false, '注册表条目必须原封不动')
    assert.equal(blocked.indexRemoved, false, '中央索引条目必须原封不动')
    assertNoDestructiveCall(runner, '无法判定 ⇒ 什么都不做')
    await assertRecordsKept(jobDir, res.jobId, call)
    // (ii) 带 force：越过门槛，真的删掉
    const forced = await deleteTool.execute({ jobId: res.jobId, force: true }, { agent: undefined })
    assert.equal(forced.ok, true, '带 force ⇒ 照常执行（真删）')
    assert.equal(forced.mode, 'delete')
    assert.equal(forced.forced, true, '必须能看出"是带 force 才做的"（期望 forced=true，实际 ' + forced.forced + '）')
    assert.equal(forced.needsForce, undefined, '执行了 ⇒ 不得再回 needsForce')
    assert.equal(forced.jobDirRemoved, true, 'job 目录必须被删掉')
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, 'job 目录才真的消失')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('tools: bgjob_kill(无法判定) ⇒ 不带 force 不动作 + needsForce（记录原封不动）；带 force 门槛解除', async () => {
  const runner = makeKillRunner({ proclistError: true })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir, tools } = await seedJob({})
  try {
    const killTool = toolOf(tools, 'bgjob_kill')
    const blocked = await killTool.execute({ jobId: res.jobId }, { agent: undefined })
    assert.equal(blocked.ok, false, '无法判定 ⇒ 绝不谎报成功')
    assert.equal(blocked.mode, 'unknown')
    assert.equal(blocked.needsForce, true, '必须明确指示需要 force')
    assert.equal(blocked.forced, undefined, '不带 force ⇒ 绝不得出现 forced 标记')
    assert.equal(blocked.killed, false, '什么都没杀 ⇒ killed=false')
    assert.equal(blocked.recordsKept, true, '记录契约不变：一律保留')
    assertNoDestructiveCall(runner, '无法判定 ⇒ 绝不 taskkill、也不动计划任务注册')
    await assertRecordsKept(jobDir, res.jobId, call)
    // 带 force：只解除门槛，**绝不谎报成功**（反查本身跑不起来 ⇒ 连杀谁都不知道）
    const forced = await killTool.execute({ jobId: res.jobId, force: true }, { agent: undefined })
    assert.equal(forced.mode, 'unknown', '仍如实回 unknown（force 只解除门槛）')
    assert.equal(forced.forced, true, '必须能看出"是带 force 才做的"')
    assert.equal(forced.needsForce, undefined, '已 force ⇒ 不得再回 needsForce')
    assert.equal(forced.killed, false, '确实没杀成 ⇒ killed=false')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ⑤ kill 之后再 wait：非 0（值 1）⇒ logic:'all' 判失败 ─────────────────────

test('tools: kill 后再 bgjob_wait(logic:"all") ⇒ 判 failed（被终止的任务绝不被读成成功完成）', async () => {
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED, PROBE_GONE] })
  setSchtasksRunner(runner)
  const { res, dispose, workdir, tools } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  try {
    const killResult = await toolOf(tools, 'bgjob_kill').execute({ jobId: res.jobId }, { agent: undefined })
    assert.equal(killResult.ok, true)
    assert.equal(killResult.exitCode, 1, '被终止的真值退出码 = 1（≠ 0 ⇒ wait/notify 判失败）')
    const waitResult = await toolOf(tools, 'bgjob_wait').execute(
      { jobIds: [res.jobId], logic: 'all', timeoutSeconds: 1 }, { agent: undefined },
    )
    console.log('  kill 后 bgjob_wait(logic:all) 返回 =', JSON.stringify(waitResult))
    assert.equal(waitResult.failed, true, '全部成功的合取语义 ⇒ 非 0 退出码必须判 failed')
    assert.equal(waitResult.failedJobId, res.jobId, 'failedJobId 必须指向被终止的那个任务')
    assert.notEqual(waitResult.allDone, true, '被终止 ≠ 成功完成（allDone 绝不得为 true）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ⑥ GUI 源码接线守卫：absent 不再静默（UI 不便单测 ⇒ 验到"接线在不在"这一层）────

test('gui: btnKill 在 $r.ok 为真后再分 $r.mode，absent 有专门提示（源码接线守卫）', async () => {
  // 面板是 WinForms 的 UI（弹窗没法在 node:test 里断言）⇒ 这里只守卫**源码接线**：
  //   ① 不再只有 `if (-not $r.ok)` 一条分支（那正是 absent 被当成功、静默刷新的根因）；
  //   ② absent 分支确实存在，且提醒"要清记录请用删除记录"；
  //   ③ mode 读不到时不瞎报（退回静默刷新 ⇒ 判据只能是字符串比较 + 前置类型检查）；
  //   ④ i18n 键中英双字典齐备（缺键会跨语言回退 ⇒ 抓得到）。
  const guiSource = await fsp.readFile(path.join(import.meta.dirname, '..', 'tools', 'dsh-bgjobs-gui.ps1'), 'utf8')
  const libSource = await fsp.readFile(path.join(import.meta.dirname, '..', 'tools', 'dsh-bgjobs-lib.ps1'), 'utf8')
  const killHandlerStart = guiSource.indexOf('$script:btnKill.Add_Click({')
  assert.notEqual(killHandlerStart, -1, '必须找得到 btnKill 的点击处理块')
  const killHandler = guiSource.slice(killHandlerStart, guiSource.indexOf('$script:btnDelete.Add_Click({', killHandlerStart))
  for (const needle of ["$r.mode", "'absent'", 'msg.kill.absent.hint', '-not $r.ok']) {
    console.log('  期望 btnKill 处理块含：' + needle)
    assert.ok(killHandler.includes(needle), 'btnKill 处理块必须含「' + needle + '」')
  }
  // mode 读不到就不许瞎报：absent 分支必须先做类型/取值判定，不许裸比较
  assert.ok(killHandler.includes('[string]') || killHandler.includes('-eq'), 'absent 分支必须是取值判定（不是无条件弹窗）')
  // i18n：中英双字典都定义了新键（同一行的 if/else 形态 = 双语言）
  const expectedKey = "'msg.kill.absent.hint' ="
  console.log('  期望 i18n 表含：' + expectedKey)
  assert.ok(libSource.includes(expectedKey), 'i18n 文案表必须定义 msg.kill.absent.hint')
  const keyLine = libSource.split(/\r?\n/).find((line) => line.includes(expectedKey))
  assert.ok(keyLine.includes('$script:BgjobsLangZh'), 'msg.kill.absent.hint 必须是中英双分支（缺键会跨语言回退）')
  assert.ok(keyLine.includes('{') && keyLine.includes('} else {'), 'msg.kill.absent.hint 必须同时给出中文与英文文案')
  assert.ok(keyLine.includes('🗑'), '中文文案必须指明用「🗑 删除记录」清记录')
  console.log('  msg.kill.absent.hint 整行 =', keyLine.trim())
})
