// bgjobs tests —— B1 修复：运行中的沙箱 pwsh 任务删/杀无效 ⇒ pid 文件 + taskkill /T /F 树杀。
// ★ 语义（用户裁定，2026-10-07；**边界 2026-10-08 更正**）：**kill 只终止进程、不删记录**
//   （job 目录/索引/注册表全留，并补写非 0 退出码 1（= taskkill /F 在内核里记录的真值）
//   ⇒ wait/notify 表现为失败）；
//   **delete 只删记录**，且只在没有活进程时允许。要彻底清掉 ⇒ 先 kill 再 delete（两步分开）。
//   ★★ 更正：**kill 无活进程时什么都不做、什么都不删**（回 `mode:'absent'` + `killed:false` +
//   note「未发现该任务的活进程…」）—— kill **内部没有 delete 分支**；老话「进程不存在 ⇒ delete
//   语义」的正确读法是**「调用方在无活进程时该去调 delete」**，不是"kill 替它转 delete"。
//   （旧断言 `kill ⇒ mode:'delete'` 已作废，勿改回。）
// 全部经 setSchtasksRunner 注入缝（**绝不真杀进程**），并经 /bgjobs/kill 与 /bgjobs/delete 走真实路径。
// ★ 补充裁定（用户裁定，2026-10-08）：**无法判定**进程状态（探针/反查本身跑不起来 = mode:'unknown'）
//   时，两条路由**默认什么都不做**（只回警告 + `needsForce: true`），只有显式 force
//   （HTTP `?force=1` / JSON body `{force:true}` / CLI `-Force` / GUI 确认框）才越过这道门槛（回 `forced:true`）；
//   `live` / `absent` 的行为**完全不受 force 影响**。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { apply, setSchtasksRunner, setShellResolver, buildPwshRunner, buildProbeScript, buildProcessQueryScript, orderKillSet } from '../lib/index.js'
import { makeWorkdir, makeCtx, attachWebServer, installSuiteHooks, waitFor } from './helpers/common.js'

installSuiteHooks()

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PS_LIB = path.join(REPO_ROOT, 'tools', 'dsh-bgjobs-lib.ps1')
const HOLD_DIR_HELPER = path.join(REPO_ROOT, 'tests', 'helpers', 'hold-dir.js')

/** 探针标记的三种注入输出（与 lib/kill-tree.js 的 PROBE_MARK 同格式）。 */
const PROBE_ALIVE_OWNED = 'BGJOBS-PID 1 1'
const PROBE_ALIVE_FOREIGN = 'BGJOBS-PID 1 0'
const PROBE_GONE = 'BGJOBS-PID 0 0'

const joined = (argv) => argv.map(String).join(' ')
/** 反查查询：命令行里带 `BGJOBS-PROC` 标记（与探针同为 powershell + CIM，靠标记区分）。 */
const isProcessList = (argv) => joined(argv).includes('BGJOBS-PROC')
// ★ 反查脚本同样含 `Win32_Process`（全量列举）⇒ 探针谓词必须**排除**反查，否则用例会互相误判
//（实测踩过：反查被当成 pid 探针，probePidOf 取不到 pid）。
const isProbe = (argv) => joined(argv).includes('Win32_Process') && !isProcessList(argv)
const isTaskkill = (argv) => String(argv[0]).toLowerCase().includes('taskkill')
const indexOfCall = (calls, predicate) => calls.findIndex(predicate)

/** 反查输出的一行：`BGJOBS-PROC <pid> <ppid> <matched 0|1> <b64(cmdline)>`。 */
const procLine = (pid, ppid, matched, cmdline) => 'BGJOBS-PROC ' + pid + ' ' + ppid + ' '
  + (matched ? 1 : 0) + ' ' + Buffer.from(String(cmdline), 'utf8').toString('base64')

/** 探针脚本按 pid 精确过滤（`-Filter 'ProcessId=4242'`）⇒ 取出被探的 pid（拿不到返回 null）。 */
const probePidOf = (argv) => {
  const hit = joined(argv).match(/ProcessId=(\d+)/)
  return hit === null ? null : hit[1]
}

/**
 * 可编排的 fake runner（取代真 schtasks / taskkill / powershell）：
 *   - 带 `Win32_Process` 的调用 = pid 探针：先查 `probes`（按 pid 精确作答，`{ '4242': PROBE_ALIVE_OWNED }`），
 *     没写才按 probeQueue 依次作答（队空后固定用 probe）；
 *   - 带 `BGJOBS-PROC` 的调用 = 反查查询：proclistQueue 依次作答（队空后固定用 proclist）；
 *     `proclistError: true` ⇒ 该调用改回非零退出（模拟"反查本身跑不起来"⇒ 无法判定）；
 *   - 带 `taskkill` 的调用 = 树杀：返回 killExit；
 *   - 其余（schtasks /End、/Delete）= exit 0。
 * 每次调用都记进 calls（含 `.script` = powershell 脚本全文，供形状断言），供顺序断言。
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
    // ★ 顺序要紧：反查脚本同样含 `Win32_Process`（Get-CimInstance Win32_Process 全量列举），
    // 所以必须先认 `BGJOBS-PROC` 标记，否则反查会被误当成 pid 探针（实测踩过）。
    if (isProcessList(argv)) {
      // proclistError：反查脚本本身跑不起来（非零退出）⇒ 调用方**无法判定**有没有活进程
      //（既不能杀、也不能删记录）——这是 processFound === null / detect.state === 'unknown' 的注入缝。
      if (options.proclistError === true) return { exitCode: 1, stdout: '', stderr: 'ERROR: query failed' }
      const out = proclistQueue !== null && proclistQueue.length > 0 ? proclistQueue.shift() : fixedProclist
      return { exitCode: 0, stdout: out, stderr: '' }
    }
    if (isProbe(argv)) {
      // 探针脚本按 pid 精确过滤（`-Filter 'ProcessId=4242'`）⇒ 按 pid 作答，避免"队列顺序"这种脆断言：
      // "杀前命中、杀后仍活"这类同 pid 不同时刻的语义仍用 probeQueue 表达。
      const probedPid = probePidOf(argv)
      if (probedPid !== null && probes[probedPid] !== undefined) {
        return { exitCode: 0, stdout: probes[probedPid], stderr: '' }
      }
      const out = probeQueue !== null && probeQueue.length > 0 ? probeQueue.shift() : fixedProbe
      return { exitCode: 0, stdout: out, stderr: '' }
    }
    if (isTaskkill(argv)) {
      // 按 pid 覆盖退出码（实机语义：最外层根的 /T 已把子根带走 ⇒ 对子根 taskkill 报 128 找不到进程）
      const killedPid = String(argv[2])
      const code = killExitByPid[killedPid] === undefined ? killExit : killExitByPid[killedPid]
      return { exitCode: code, stdout: '', stderr: code === 0 ? '' : (code === 128 ? 'ERROR: 没有找到进程 "' + killedPid + '"。' : 'ERROR: access denied') }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  runner.calls = calls
  return runner
}

/** 索引写入是 fire-and-forget ⇒ 轮询到条目真的消失（不好用固定等长）。 */
async function waitIndexGone(indexFile, jobId) {
  await waitFor(async () => {
    // 索引写回是"截断 + 重写"（非原子）：读者与写者并发时可能读到空/半截 JSON —— 那只是"还没写完"，
    // 按未完成重试（此前直接 JSON.parse 会抛 SyntaxError: Unexpected end of JSON input ⇒ 偶发假失败）。
    let index
    try { index = JSON.parse(await fsp.readFile(indexFile, 'utf8')) } catch { return false }
    return index.jobs.some((entry) => entry.id === jobId) === false
  })
}

/**
 * 用"目录被占住"制造真实的 jobDir 删除失败（EBUSY）：助手进程把 jobDir 作为自己的 CWD。
 * （文件句柄锁在 Win10 1903+ 已不拦删除，见 tests/helpers/hold-dir.js 的注释。）
 * 返回 `{ child }`；用完必须 stopHoldDir 释放，否则后续清理会跟着失败。
 */
async function holdJobDir(jobDir) {
  const child = spawn(process.execPath, [HOLD_DIR_HELPER, jobDir], { stdio: 'ignore', windowsHide: true })
  // 就绪判定：活过一小段且没退出（chdir 失败会立刻非零退出）
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('hold-dir helper 提前退出（code=' + child.exitCode + ' signal=' + child.signalCode + '）')
    }
  }
  return { child }
}

/** 停掉占目录助手并确认真的退出（Windows 上 CWD 释放有延迟，必须等到进程消失）。 */
async function stopHoldDir(hold) {
  if (hold === undefined || hold === null) return
  hold.child.kill()
  const deadline = Date.now() + 10000
  while (hold.child.exitCode === null && hold.child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (hold.child.exitCode === null && hold.child.signalCode === null) hold.child.kill('SIGKILL')
  // 再给系统一点时间释放 CWD 句柄
  await new Promise((resolve) => setTimeout(resolve, 100))
}

/** 提交一个 pwsh 任务（默认保持 running）并可选铺 pid 文件；返回调用器与现场。 */
async function seedJob(options = {}) {
  setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
  const res = await submit.execute({ name: 't', command: 'Start-Sleep -Seconds 30', workdir }, { agent: undefined })
  assert.equal(res.ok, true, '提交应成功')
  const jobDir = path.join(workdir, '.dsh', 'bgjobs', res.jobId)
  if (options.pidFile !== undefined) {
    await fsp.writeFile(path.join(jobDir, options.pidFile), String(options.pid === undefined ? 4242 : options.pid), 'utf8')
  }
  if (options.done === true) {
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    await intervals.find((i) => i.ms === 1000).fn()
  }
  const handler = attachWebServer(ctx, injectCallbacks)().handler
  const call = (url) => new Promise((resolve) => {
    handler({ url }, { writeHead: () => {}, end: (b) => resolve(JSON.parse(b || '{}')) })
  })
  return { res, jobDir, call, dispose, workdir, intervals, tools, handler }
}

/**
 * 带 JSON body 的调用（验证 force 的第二种传参形态 `{ force: true }`）。
 * handler 的第一个参数就是 req：readJsonBody 在构造 Promise 时**同步**注册 data/end 监听，
 * 所以这里异步投递数据，模拟真实请求体到达。
 */
function callWithBody(handler, url, body) {
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      url, method: 'POST',
      on: (event, fn) => { listeners[event] = fn; return req },
      destroy: () => {},
    }
    setTimeout(() => {
      if (typeof listeners.data === 'function') listeners.data(Buffer.from(JSON.stringify(body), 'utf8'))
      if (typeof listeners.end === 'function') listeners.end()
    }, 0)
    handler(req, { writeHead: () => {}, end: (b) => resolve(JSON.parse(b || '{}')) })
  })
}

/** 索引读取容错：写回是"截断 + 重写"（非原子），并发读到半截 JSON 时重试。 */
async function readIndexJobs(indexFile) {
  let jobs = null
  await waitFor(async () => {
    try { jobs = JSON.parse(await fsp.readFile(indexFile, 'utf8')).jobs; return true } catch { return false }
  })
  return jobs
}

/**
 * kill 路径的**契约**断言（用户裁定："kill 只杀进程，不删记录"）：
 * job 目录 / 中央索引 / 注册表条目**都必须还在**。kill 之后要彻底清掉 ⇒ 再调 delete。
 */
async function assertRecordsKept(jobDir, jobId, call) {
  assert.notEqual(await fsp.stat(jobDir).catch(() => null), null, 'kill 不删记录 ⇒ job 目录必须还在')
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  const jobs = await readIndexJobs(indexFile)
  assert.ok(jobs.some((entry) => entry.id === jobId), 'kill 不删记录 ⇒ 中央索引条目必须还在')
  const state = await call('/bgjobs/state')
  assert.ok(state.jobs.some((job) => job.id === jobId), 'kill 不删记录 ⇒ 注册表条目必须还在')
}

/** kill 后 job.json 的「被终止」标记（事后区分"自己退出的非 0"与"被我们终止"）。 */
async function readJobJson(jobDir) {
  return JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
}

// ── ① running + pid 文件 ⇒ /bgjobs/kill 走 taskkill /PID <pid> /T /F ───────

test('kill-tree: kill(running 任务有 run.pid) ⇒ taskkill /PID <pid> /T /F，补写 1 退出码（taskkill 的真值），且**不删记录**', async () => {
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED, PROBE_GONE] })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, true, '存活核验通过 ⇒ ok')
    assert.equal(r.mode, 'kill', '有活进程 ⇒ kill 语义')
    assert.equal(r.killed, true, '确实终止了进程')
    assert.equal(r.recordsKept, true, 'kill 路径的记录契约：一律保留')
    assert.equal(r.killedPid, 4242)
    assert.equal(r.killedFile, 'run.pid')
    assert.equal(r.killedVerified, true, '核验到 pid 消失 ⇒ verified:true')
    const killCall = runner.calls.find(isTaskkill)
    assert.ok(killCall, '必须调用 taskkill')
    assert.ok(String(killCall[0]).toLowerCase().includes('taskkill'))
    assert.deepEqual(killCall.slice(1), ['/PID', '4242', '/T', '/F'], '参数必须是 /PID <pid> /T /F')
    // ★ 追加裁定：kill 只终止进程、不删记录；被终止的任务必须有**非 0 退出码**，不许被读成"成功完成"。
    // ★★ 值 = 1：**不是设计口味，是实测的真值**（2026-10-07，本机 Windows，各 3 次重复）——
    //   退出码**不是系统自动给的**，它就是终止方传给 `TerminateProcess` 的参数；本机
    //   `taskkill /PID <pid> /T /F` 记录的值稳定 = 1（`/F` 不带 `/T` 也是 1）。
    //   所以这里**写死 1 就是"取 taskkill 的真实记录值"**，不许改成"跟着 KILLED_EXIT_CODE 走"的
    //   同义反复断言（那样实现改错也测不出来）。旧的 143 = 128 + 15 是 POSIX 的 SIGTERM 约定，
    //   Windows 根本不会产生这个值。
    const expectedKilledExitCode = 1
    console.log('  期望"被终止"退出码 =', expectedKilledExitCode, '（依据：taskkill /F 在内核里记录的值）')
    assert.equal(expectedKilledExitCode, 1, '依据本身必须是"taskkill 实测记录值 = 1"')
    assert.equal(r.exitCode, expectedKilledExitCode, 'host 侧补写的退出码 = taskkill 的真实记录值 1')
    assert.equal(r.exitCode !== 0, true, '仍必须是非 0（wait/notify 据此判失败）')
    assert.equal(r.exitcodeWritten, true, 'exitcode.txt 必须被补写（runner 被杀来不及写）')
    assert.equal(r.jobJsonUpdated, true, 'job.json 必须落终态')
    assert.equal(String(await fsp.readFile(path.join(jobDir, 'exitcode.txt'), 'utf8')).trim(), '1', 'exitcode.txt = 1（taskkill 记录的真值）')
    const meta = await readJobJson(jobDir)
    assert.equal(meta.exitCode, 1)
    assert.equal(meta.exitCodeSource, 'killed', '事后能区分"自己退出的非 0"与"被我们终止"')
    assert.equal(typeof meta.killedAt, 'number', '须记终止时间')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ② taskkill 非零 / 杀后仍活 ⇒ ok:false（不得 ok；记录一律保留）──────────

test('kill-tree: taskkill 非零 ⇒ 返回 ok:false + error（不假成功；kill 不删任何记录）', async () => {
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED], killExit: 1, proclist: '' })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid' })
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, false, 'taskkill 非零不得返回 ok')
    assert.equal(r.mode, 'kill', '有活进程 ⇒ kill 语义（失败也是 kill 失败）')
    assert.equal(r.killed, false, '没杀掉 ⇒ killed:false（不许谎报已终止）')
    assert.match(r.error, /taskkill/)
    assert.equal(runner.calls.some(isProcessList), true, '核验没过 ⇒ 必须再试一次反查兜底')
    // ★ kill 的契约：记录一律保留 —— 杀不掉时更不能把任务从注册表/索引里抹掉（否则又成了"看不见的孤儿"）。
    await assertRecordsKept(jobDir, res.jobId, call)
    assert.equal(await fsp.readFile(path.join(jobDir, 'exitcode.txt'), 'utf8').catch(() => null), null, '没杀掉 ⇒ 不补写退出码')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: taskkill 成功但核验到仍活（≤2s）⇒ 返回 ok:false + error', async () => {
  const runner = makeKillRunner({ probe: PROBE_ALIVE_OWNED })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid' })
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, false, '仍活不得返回 ok')
    assert.equal(r.mode, 'kill')
    assert.match(r.error, /仍存活/)
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ③ 无 pid 文件（老任务 / bat 引擎）⇒ 按 jobDir/taskName 反查进程树 ────────

test('kill-tree: ③ delete(running + 无 pid 文件 + 反查筛不到进程) ⇒ ok:true + mode:delete（无活进程 ⇒ delete 放行）', async () => {
  const runner = makeKillRunner({ probe: PROBE_ALIVE_OWNED, proclist: '' })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const r = await call('/bgjobs/delete?id=' + res.jobId)
    // ★ 用户裁定：**未发现活进程 ⇒ delete 放行** —— 无论 status 记的是 running 还是 done，
    //   只要探针/反查确认没有本任务的活进程，删记录这件事就不是失败（旧口径在这里回 ok:false
    //   「无法证实已退出」，已作废）。（kill 侧不适用本条：kill 无活进程时**什么都不删**，见 ③b。）
    assert.equal(r.ok, true, '进程不存在 ⇒ 删记录这件事本身是成功的')
    assert.equal(r.mode, 'delete', '本次实际发生的是"只删记录"')
    assert.equal(r.error, undefined, '不得再回 ok:false + error')
    assert.equal(r.killedPids, undefined, '没杀任何进程就不得回传 killedPids')
    assert.equal(runner.calls.some(isTaskkill), false, '反查筛不到 ⇒ 绝不调 taskkill')
    assert.equal(runner.calls.some(isProbe), false, '无 pid 文件连 pid 探针都不该跑')
    assert.equal(runner.calls.some(isProcessList), true, '无 pid 文件必须走反查（先确认有没有活进程）')
    assert.ok(runner.calls.some((argv) => argv.includes('/End')), 'running 仍走 /End（计划任务注册收尾）')
    assert.ok(runner.calls.some((argv) => argv.includes('/Delete')), '仍走 /Delete')
    // delete 路径的清理语义（缺口 A）：注册表/索引/目录三样都要清干净
    assert.equal(r.registryRemoved, true)
    assert.equal(r.indexRemoved, true)
    assert.equal(r.jobDirRemoved, true, '目录删得掉 ⇒ 如实报 true')
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, '目录应被删除')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ③b kill(running + 无 pid 文件 + 反查筛不到进程) ⇒ mode:absent + 「未发现活进程」，且**一个记录都没动**', async () => {
  const runner = makeKillRunner({ proclist: '' })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    // ★★ 新语义（用户裁定，2026-10-08 更正边界）：kill **无活进程时什么都不做、什么都不删**，
    //    也**不再借用 delete 的名字** —— 旧断言 `mode:'delete'`（"kill 转 delete 语义"）已作废，
    //    改钉 `mode:'absent'` + 真值说明「未发现活进程」。
    assert.equal(r.ok, true, '没有进程可杀不是失败（本次请求被如实处理：没活进程）')
    assert.equal(r.mode, 'absent', 'kill 如实标明：未发现本任务的活进程（不是"内部转 delete"）')
    assert.equal(r.killed, false, '没终止任何进程')
    assert.equal(r.recordsKept, true, '记录契约：一律保留')
    // ★ 判据 = **单引号字面量 + 整串相等 + 打印期望值**（不做子串匹配）——文案唯一来源是
    //   lib/core/web.js 的 absent 分支；改口径必须先改这里（否则测试红）。
    const expectedAbsentNote = '未发现该任务的活进程 ⇒ 无可终止；kill 只终止进程，本次未删除任何记录（job 目录/索引/注册表原封不动），要清记录请调用 delete'
    console.log('  期望 kill absent note =', expectedAbsentNote)
    assert.equal(r.note, expectedAbsentNote, '(ii) note 必须整串等于 host 的「未发现活进程」文案')
    // 反查"筛不到"的那条 note 会作为 warning 回传（lib/kill-tree.js 的 killByReverseLookup，running 时附）
    const expectedNoMatchWarning = 'no pid file and no process matched jobDir/taskName —— 未发现该任务的活进程 ⇒ 无可终止（kill 只终止进程，本次未删除任何记录）；要清记录请调用 delete'
    console.log('  期望反查 no-match warning =', expectedNoMatchWarning)
    assert.deepEqual(r.warnings, [expectedNoMatchWarning], 'warnings 必须整串等于反查 no-match 的说明（整串相等）')
    assert.equal(runner.calls.some(isTaskkill), false, '筛不到 ⇒ 绝不调 taskkill')
    assert.equal(runner.calls.some((argv) => argv.includes('/End') || argv.includes('/Delete')), false,
      '无活进程 ⇒ 连计划任务注册都不动（不 /End、不 /Delete）')
    // ★ (i) **记录一个都没动**：job 目录 / 中央索引条目 / 注册表条目三样都在原处。
    await assertRecordsKept(jobDir, res.jobId, call)
    const jobs = await readIndexJobs(indexFile)
    assert.ok(jobs.some((entry) => entry.id === res.jobId), 'kill 不删记录 ⇒ 索引条目必须还在')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ③c kill(有 run.pid 但进程早已退出) ⇒ mode:absent + 「未发现活进程」；记录/计划任务注册一个都没动', async () => {
  // 与 ③b 互补的第二条 absent 路径：pid 文件在、探针答 gone（skipped:'already-gone'，processFound:false）
  // —— 同样**不杀、不删、不动计划任务**（新边界对两条 absent 路径一视同仁）。
  const runner = makeKillRunner({ probe: PROBE_GONE })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, true, '进程早就没了 ⇒ 不是失败')
    assert.equal(r.mode, 'absent', '未发现活进程 ⇒ absent（不是 delete）')
    assert.equal(r.killed, false)
    assert.equal(r.skipped, 'already-gone', '既有字段 skipped 照旧透出（未改名）')
    // ★ 判据同 ③b：单引号字面量 + 整串相等 + 打印期望值（与 host 的 absent note 同源）。
    const expectedAbsentNote = '未发现该任务的活进程 ⇒ 无可终止；kill 只终止进程，本次未删除任何记录（job 目录/索引/注册表原封不动），要清记录请调用 delete'
    console.log('  期望 kill absent note =', expectedAbsentNote)
    assert.equal(r.note, expectedAbsentNote, 'note 必须整串等于 host 的「未发现活进程」文案')
    assert.equal(r.warnings, undefined, 'pid 早已退出 ⇒ 不该有任何 warning')
    assert.equal(runner.calls.some(isTaskkill), false, '探针答 gone ⇒ 绝不 taskkill')
    assert.equal(runner.calls.some((argv) => argv.includes('/End') || argv.includes('/Delete')), false,
      '不 /End、不 /Delete（计划任务注册不是记录，但这里也没有进程被终止，不该动它）')
    await assertRecordsKept(jobDir, res.jobId, call)
    assert.ok((await readIndexJobs(indexFile)).some((entry) => entry.id === res.jobId), '索引条目必须还在')
    assert.equal(await fsp.readFile(path.join(jobDir, 'exitcode.txt'), 'utf8').catch(() => null), null,
      '没杀任何东西 ⇒ 绝不补写退出码（别把"无辜任务"标成被终止）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: kill(无 pid 文件 + 反查到进程) ⇒ 逐个 taskkill /PID <pid> /T /F（先杀根再补刀后代，含命令行不含 jobDir 的后代）', async () => {
  const cmdline = 'C:\\Windows\\System32\\cmd.exe /c ""C:\\work\\.dsh\\bgjobs\\bg-x\\run.bat""'
  const proclist = [
    procLine(9001, 9000, true, cmdline),          // matched：命令行含 jobDir（任务根）
    procLine(9002, 9001, false, 'PING.EXE -n 60 127.0.0.1'), // descendant：命令行不含 jobDir，只能靠父链展开
    procLine(9003, 9002, false, '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4'), // 曾孙：同样不含 jobDir
  ].join('\r\n')
  const runner = makeKillRunner({ proclist })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, true, '反查击杀成功 ⇒ ok')
    assert.equal(r.mode, 'kill', '反查到活进程并杀掉 ⇒ kill 语义')
    assert.equal(r.killed, true)
    assert.deepEqual(r.matchedPids, [9001], '只把命令行直接命中的进程算 matched（现场证据）')
    // ★ 本用例就是"后代命令行不含 jobDir"的复现：9002/9003 的命令行里没有 jobDir/taskName，
    //   仍必须在击杀集里（否则 ping/conhost 变孤儿继续跑，job 目录仍被占住 ⇒ EBUSY）
    assert.deepEqual(r.killedPids, [9001, 9002, 9003], 'matched + 全部后代都要杀（否则 ping 变孤儿继续跑）')
    assert.deepEqual(r.killedProcesses, [
      { pid: 9001, ppid: 9000, matched: true, cmdline },
      { pid: 9002, ppid: 9001, matched: false, cmdline: 'PING.EXE -n 60 127.0.0.1' },
      { pid: 9003, ppid: 9002, matched: false, cmdline: '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4' },
    ], '返回值必须带每个 pid 的命令行片段证据（动手前就打进返回值）')
    assert.ok(!r.killedProcesses[1].cmdline.toLowerCase().includes('bgjobs'), '后代命令行确实不含 jobDir（本用例的复现前提）')
    const killCalls = runner.calls.filter(isTaskkill)
    assert.deepEqual(killCalls.map((argv) => argv.slice(1)), [
      ['/PID', '9001', '/T', '/F'],
      ['/PID', '9002', '/T', '/F'],
      ['/PID', '9003', '/T', '/F'],
    ], '先杀最外层根（/T 带走子树）再逐个补刀后代')
    const probedPids = runner.calls.filter(isProbe).map((argv) => probePidOf(argv))
    assert.deepEqual(probedPids, ['9001', '9002', '9003'], '反查路径只做"存活核验"探针（按 pid），不做归属门禁')
    // 筛选必须限定本任务：脚本里只允许出现 jobDir / taskName / jobId 三个 needle
    const script = runner.calls.find(isProcessList).script
    assert.ok(script.includes("$bgCmdline.Contains('" + jobDir.toLowerCase() + "')"), '按 jobDir 过滤（小写，与 PS 的 ToLowerInvariant 对齐）')
    assert.ok(script.includes("$bgCmdline.Contains('dsh-bgj-" + res.jobId + "')"), '按 taskName 过滤')
    assert.ok(script.includes("$bgCmdline.Contains('" + res.jobId.toLowerCase() + "')"), '按 jobId 过滤（jobId 本身已含 bg- 前缀，勿再拼一次）')
    assert.ok(script.includes('$_.ppid -eq $bgParent.pid'), '必须按 ParentProcessId 展开后代')
    // ★ kill 不删记录 ⇒ 目录/索引/注册表都还在（要清掉请再调 delete）
    await assertRecordsKept(jobDir, res.jobId, call)
    assert.equal(String(await fsp.readFile(path.join(jobDir, 'exitcode.txt'), 'utf8')).trim(), '1', 'kill 成 ⇒ 补写 1（taskkill 的真值）')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: 排序 —— 击杀集按"最外层根 → 内层后代"排序且按 pid 去重（父子都命中时先杀父）', () => {
  const ordered = orderKillSet([
    { pid: 9003, ppid: 9002, matched: false, cmdline: 'conhost' },   // 曾孙
    { pid: 9002, ppid: 9001, matched: true, cmdline: 'cmd run.bat' }, // 子（也命中）
    { pid: 9001, ppid: 9000, matched: true, cmdline: 'wscript launch.vbs' }, // 最外层根
    { pid: 9002, ppid: 9001, matched: true, cmdline: 'cmd run.bat' }, // 重复行 ⇒ 必须去重
    { pid: 9004, ppid: 9001, matched: false, cmdline: 'ping' },       // 另一个后代
  ])
  assert.deepEqual(ordered.map((entry) => entry.pid), [9001, 9002, 9004, 9003],
    'matched 优先 + 每层按深度递增；重复 pid 只出现一次')
  // 父链断掉（父进程早退，认不到祖先）时不许丢进程：按 pid 兜底
  assert.deepEqual(orderKillSet([
    { pid: 9102, ppid: 999999, matched: true, cmdline: 'orphan-child' },
    { pid: 9101, ppid: 999999, matched: true, cmdline: 'orphan' },
  ]).map((entry) => entry.pid), [9101, 9102], '认不到祖先 ⇒ 按 pid 稳定排序，绝不丢')
})

// ── ④ pid 复用防护：命令行不匹配 ⇒ 不杀 + 报错 ────────────────────────────

test('kill-tree: kill(running 任务 pid 归属核验失败) ⇒ 不杀 + 报错，记录原封不动', async () => {
  const runner = makeKillRunner({ probe: PROBE_ALIVE_FOREIGN })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid', pid: 777 })
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, false, '归属核验失败必须报错')
    assert.equal(r.mode, 'kill', '有活进程（只是不属于本任务）⇒ kill 语义；杀不掉 ⇒ ok:false')
    assert.equal(r.killed, false)
    assert.match(r.error, /pid reuse guard/)
    assert.match(r.error, /777/)
    assert.equal(runner.calls.some(isProcessList), false, '归属不明绝不触发反查（否则会把无关进程的后代卷进来）')
    assert.equal(runner.calls.some(isTaskkill), false, '核验失败绝不调 taskkill（不误杀无关进程）')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: delete(done 任务的陈旧 run.pid，pid 已被复用给无关进程) ⇒ 只删记录、如实记 warning', async () => {
  const runner = makeKillRunner({ probe: PROBE_ALIVE_FOREIGN })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid', done: true })
  try {
    const r = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(r.ok, true, 'done 任务不该被陈旧 pid 文件卡住')
    assert.equal(r.mode, 'delete', '本任务的进程不存在（pid 已被复用）⇒ delete 语义')
    assert.equal(runner.calls.some(isTaskkill), false, '不匹配就不杀')
    assert.ok(Array.isArray(r.warnings) && r.warnings.some((line) => /pid reuse guard/.test(line)), '须如实记 warning')
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, '目录应被删除')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ④c delete 遇到活进程必须拒绝（kill 与 delete 彻底分开的核心防线）────────

test('kill-tree: ④c delete(running + pid 文件 + 进程存活且属于本任务) ⇒ 拒绝删除、不杀进程、记录原封不动', async () => {
  const runner = makeKillRunner({ probe: PROBE_ALIVE_OWNED })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  try {
    const r = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(r.ok, false, '还有活进程 ⇒ delete 必须拒绝（绝不删出一个"看不见但还在跑"的孤儿）')
    assert.equal(r.mode, 'kill', '有活进程 ⇒ 该走的是 kill 语义，不是 delete')
    assert.match(String(r.error), /still running/)
    assert.match(String(r.error), /先 kill/, 'error 必须指路：先 kill 再 delete')
    assert.equal(r.livePid, 4242, '如实报"哪个 pid 还活着"')
    assert.equal(runner.calls.some(isTaskkill), false, 'delete 绝不越界杀进程')
    assert.equal(await fsp.stat(jobDir).catch(() => null) === null, false, '拒绝删除 ⇒ 目录必须还在')
    const jobs = await readIndexJobs(path.join(process.env.DSH_HOME, 'bgjobs', 'index.json'))
    assert.ok(jobs.some((entry) => entry.id === res.jobId), '拒绝删除 ⇒ 索引条目必须还在')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ⑤ 顺序：kill = taskkill → /End → /Delete；delete 才删目录（两步分开）─────

test('kill-tree: 顺序 = kill 内 taskkill → /End → /Delete（记录保留）⇒ 再 delete 才删目录', async () => {
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED, PROBE_GONE] })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid' })
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, true)
    assert.equal(r.mode, 'kill')
    const killAt = indexOfCall(runner.calls, isTaskkill)
    const endAt = indexOfCall(runner.calls, (argv) => argv.includes('/End'))
    const deleteAt = indexOfCall(runner.calls, (argv) => argv.includes('/Delete'))
    assert.ok(killAt >= 0 && endAt >= 0 && deleteAt >= 0, '三个动作都必须发生')
    assert.ok(killAt < endAt, 'taskkill 必须在 /End 之前')
    assert.ok(killAt < deleteAt, 'taskkill 必须在 /Delete 之前')
    assert.ok(endAt < deleteAt, '/End 必须在 /Delete 之前（running）')
    // ★ kill 只终止进程：taskkill//End//Delete 都发完了，job 目录仍必须原封不动（删目录是 delete 的事）。
    assert.notEqual(await fsp.stat(jobDir).catch(() => null), null, 'kill 之后目录必须还在')
    // 第二步：delete 只删记录（此时进程已不存在 ⇒ delete 语义放行）。
    const second = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(second.ok, true, 'kill 之后再 delete ⇒ 清记录')
    assert.equal(second.mode, 'delete')
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, 'delete 才让目录消失')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ⑦ 缺口 A：目录删不掉 ⇒ 注册表 / 索引仍必须被清理（delete 路径）──────────

test('kill-tree: ⑦ delete 时 job 目录删不掉（真实 EBUSY：目录被占为 CWD）⇒ 仍清注册表+索引，且诚实回 ok:false + error', async () => {
  const runner = makeKillRunner({ proclist: '' })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ done: true })
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  let hold
  try {
    hold = await holdJobDir(jobDir) // 助手进程把 jobDir 当 CWD ⇒ rmdir 必 EBUSY
    const r = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(r.ok, false, '有东西没删净就必须 ok:false（不静默成 ok）')
    assert.equal(r.mode, 'delete', '进程不存在 ⇒ 本次是 delete 语义（记录删不净 ⇒ ok:false）')
    assert.match(String(r.error), /remove job dir failed/, 'error 必须说清"目录未删净"')
    assert.match(String(r.error), /(EBUSY|locked|busy)/i, 'error 应带上底层失败原因；实际: ' + r.error)
    assert.equal(r.registryRemoved, true, '注册表清理必须执行')
    assert.equal(r.indexRemoved, true, '中央索引清理必须执行')
    assert.equal(r.jobDirRemoved, false, '如实报告目录未删净')
    await waitIndexGone(indexFile, res.jobId)
    assert.notEqual(await fsp.stat(jobDir).catch(() => null), null, 'CWD 未释放 ⇒ 目录确实还在')
    // 释放占位后再删：同一条路径必须能删净 —— 证明上一次不是"半删后卡死"
    await stopHoldDir(hold)
    hold = undefined
    assert.equal(await fsp.rm(jobDir, { recursive: true, force: true }).then(() => true).catch(() => false), true, '释放后目录应可删净')
  } finally {
    await stopHoldDir(hold)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ⑧ 缺口 B：pid 路径失败 ⇒ 再试一次反查兜底 ─────────────────────────────

test('kill-tree: ⑧ 有 run.pid 但 taskkill 后仍活 ⇒ 原路径报错后按 jobDir/taskName 反查兜底（连后代一起清）', async () => {
  const cmdline = 'C:\\Windows\\System32\\cmd.exe /c ""C:\\work\\.dsh\\bgjobs\\bg-x\\run.bat""'
  const runner = makeKillRunner({
    // pid 路径：杀前命中、杀后仍活（同 pid 不同时刻，用 probes 按 pid 固定作答）⇒ 主路径失败
    probes: { 4242: PROBE_ALIVE_OWNED, 9001: PROBE_GONE, 9002: PROBE_GONE },
    // 反查：命中任务根 9001 + 一个命令行不含 jobDir 的后代 9002
    proclist: [
      procLine(9001, 9000, true, cmdline),
      procLine(9002, 9001, false, 'PING.EXE -n 60 127.0.0.1'),
    ].join('\r\n'),
  })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, true, '反查兜底成功 ⇒ 整体不再报失败')
    assert.equal(r.mode, 'kill')
    assert.equal(r.killed, true)
    assert.equal(r.killedPid, 4242, '主路径杀过的 pid 仍如实回传')
    assert.equal(r.killedFile, 'run.pid')
    assert.equal(r.killedVerified, true, '兜底核验通过 ⇒ verified:true')
    assert.deepEqual(r.matchedPids, [9001], '兜底击杀的"根"是反查命中的进程')
    assert.deepEqual(r.killedPids, [9001, 9002], '兜底连后代一起清（后代命令行不含 jobDir 也要杀）')
    assert.deepEqual(r.killedProcesses.map((spec) => spec.pid), [9001, 9002], '证据随返回值回传')
    assert.ok(Array.isArray(r.warnings) && r.warnings.some((line) => /反查进程树兜底/.test(line)), '须如实记 warning（说明主路径失败、用了兜底）')
    const killCalls = runner.calls.filter(isTaskkill)
    assert.deepEqual(killCalls.map((argv) => argv.slice(1)), [
      ['/PID', '4242', '/T', '/F'],   // ① 原始 pid 路径
      ['/PID', '9001', '/T', '/F'],   // ② 反查兜底：最外层根
      ['/PID', '9002', '/T', '/F'],   // ③ 反查兜底：后代
    ], '原路径失败后必须再走一次反查，并把整棵子树杀完')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ⑪ kill 的反查兜底后仍存活 ⇒ ok:false 如实报（列出 survivors），记录【一律保留】', async () => {
  const cmdline = 'C:\\Windows\\System32\\cmd.exe /c ""C:\\work\\.dsh\\bgjobs\\bg-x\\run.bat""'
  const runner = makeKillRunner({
    // 反查命中的根杀不掉（探针永远说它活着）⇒ 不许谎报成功
    probes: { 9001: PROBE_ALIVE_OWNED },
    proclist: procLine(9001, 9000, true, cmdline),
  })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, false, '杀不掉就必须 ok:false（不谎报"整树已退出"）')
    assert.equal(r.mode, 'kill', '有活进程 ⇒ kill 语义')
    assert.equal(r.killed, false, '没杀掉 ⇒ 不许谎报已终止')
    assert.match(String(r.error), /仍存活/, 'error 要说清"taskkill 后仍存活"')
    assert.deepEqual(r.survivors, [9001], '如实列出幸存 pid')
    assert.deepEqual(r.killedPids, [9001], '击杀集仍如实回传')
    // ★ kill 的契约：杀不掉也**不删任何记录**（追加裁定："kill 只杀进程，不删记录"）。
    await assertRecordsKept(jobDir, res.jobId, call)
    assert.equal(await fsp.readFile(path.join(jobDir, 'exitcode.txt'), 'utf8').catch(() => null), null, '没杀掉 ⇒ 不补写退出码')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ⑫ 最外层根的 /T 已带走子根 ⇒ 子根 taskkill 报 128（找不到进程）不得判失败', async () => {
  const runner = makeKillRunner({
    probes: { 9001: PROBE_GONE, 9002: PROBE_GONE, 9003: PROBE_GONE }, // 核验：三个都没了
    proclist: [
      procLine(9001, 9000, true, 'C:\\Windows\\System32\\wscript.exe "C:\\work\\.dsh\\bgjobs\\bg-x\\launch.vbs"'),
      procLine(9002, 9001, true, 'C:\\Windows\\system32\\cmd.exe /c ""C:\\work\\.dsh\\bgjobs\\bg-x\\run.bat""'),
      procLine(9003, 9002, false, 'PING.EXE -n 60 127.0.0.1'),
    ].join('\r\n'),
    // 实机语义：先杀最外层根 9001（/T 把 9002/9003 一起带走）⇒ 后面对它们再杀只会得到 128
    killExitByPid: { 9002: 128, 9003: 128 },
  })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, true, '"非零 ≠ 失败"：核验全部消失 ⇒ 必须 ok:true（实机曾把成功的删除报成失败）')
    assert.equal(r.mode, 'kill')
    assert.deepEqual(r.killedPids, [9001, 9002, 9003], '击杀顺序：最外层根先杀')
    assert.match(String(r.killStderr), /exit 128/, '非零输出仍如实回传，只作证据（不当失败判据）')
    assert.equal(r.survivors, undefined, '没人活下来 ⇒ 不得回传 survivors')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: 反查脚本形状 —— 必须自排除（$PID 及其后代 + 本插件 marker 的巡检进程）', () => {
  const script = buildProcessQueryScript(['C:\\work\\.dsh\\bgjobs\\bg-x', 'dsh-bgj-bg-x'])
  assert.ok(script.includes('$bgSelfPids = @{ [int]$PID = $true }'), '必须先算"自己 + 自己的后代"集合')
  assert.ok(script.includes('$bgSelfPids.ContainsKey([int]$bgProcess.ProcessId)'), '候选循环里必须跳过自己')
  assert.ok(script.includes("$bgCmdline.Contains('bgjobs-proc')"), '带查询 marker 的巡检进程必须排除')
  assert.ok(script.includes("$bgCmdline.Contains('bgjobs-pid')"), '带探针 marker 的巡检进程必须排除')
  // ★ 为什么必须自排除：脚本正文里就写着 needle（`$bgCmdline.Contains('<jobDir>')`），
  //   跑查询的 powershell 必然自命中，连它的 conhost 也会按后代被卷进击杀集（实机抓到过）。
  assert.ok(script.includes("$bgCmdline.Contains('c:\\work\\.dsh\\bgjobs\\bg-x')"), '按 jobDir 过滤（小写）')
})

test('kill-tree: ⑨ delete(无 run.pid 的老任务，status=done、进程早没了) ⇒ 反查筛不到也不报错，索引条目照清', async () => {
  const runner = makeKillRunner({ proclist: '' })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ done: true })
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const r = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(r.ok, true, 'done 任务反查不到进程是常态，不得报错')
    assert.equal(r.mode, 'delete', '进程不存在 ⇒ delete 语义（只删记录）')
    assert.equal(runner.calls.some(isTaskkill), false, '筛不到 ⇒ 绝不杀')
    assert.equal(r.indexRemoved, true)
    // 索引写入是 fire-and-forget ⇒ 轮询到条目真的消失（不好用固定等长）
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, '目录应被删除')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ⑬⑭⑮⑯… 追加裁定：kill 保留记录 + 非 0 退出码；delete 才清记录；无法判定一律如实报，
//    且**默认不动作**（只警告 + needsForce），要动手必须显式 force（?force=1 / -Force / GUI 确认）──

test('kill-tree: ⑬ kill 后 bgjob_wait / 状态表现为**失败**（exitCode 1 = taskkill 的真值），绝不被读成"成功完成"', async () => {
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED, PROBE_GONE] })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir, tools } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  try {
    const r = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(r.ok, true)
    // ★ 判据单引号 + 非子串 + 打印期望值（值 = taskkill 实测记录值，见用例 ① 的依据说明）
    const expectedKilledExitCode = 1
    console.log('  期望"被终止"退出码 =', expectedKilledExitCode, '（依据：taskkill /F 在内核里记录的值）')
    assert.equal(r.exitCode, expectedKilledExitCode, 'kill 返回的退出码必须是 taskkill 的真值')
    assert.equal(r.exitCode !== 0, true, 'kill 后 wait/快照仍须非 0（语义不变）')
    // 状态：注册表快照立刻是 done + 非 0 退出码（host 侧同步，不等 tick）
    const state = await call('/bgjobs/state')
    const snap = state.jobs.find((job) => job.id === res.jobId)
    assert.equal(snap.status, 'done', '被终止 ⇒ 终态（不再显示 running）')
    assert.equal(snap.exitCode, expectedKilledExitCode, '快照必须带非 0 退出码')
    assert.equal(snap.killed, true, '面板可据此区分"被终止"与"自己退出的非 0"')
    // ★★ 来源标记必须还在（值 1 与"任务自己以 1 退出"同值 ⇒ 只有来源字段能分开）
    assert.equal(snap.exitCodeSource, 'killed', 'exitCodeSource:killed 必须保留（唯一来源判据）')
    assert.equal(typeof snap.killedAt, 'number', 'killedAt 必须保留')
    assert.equal(snap.killedBy, 'kill', 'killedBy 必须保留')
    // bgjob_wait：单任务等待必须回非 0 退出码（调用方据此判失败）
    const waitOne = tools.find((t) => t.name === 'bgjob_wait')
    const w1 = await waitOne.execute({ jobId: res.jobId, timeoutSeconds: 5 }, { agent: undefined })
    assert.equal(w1.status, 'done')
    assert.equal(w1.exitCode, expectedKilledExitCode, 'wait 必须回 1（不是 0/成功）')
    // logic:'all' 的成败判据就是 exitCode !== 0 ⇒ 被终止的任务必须算 failed
    const w2 = await waitOne.execute({ jobIds: [res.jobId], timeoutSeconds: 5, logic: 'all' }, { agent: undefined })
    assert.equal(w2.failed, true, '被终止的任务在 all 语义下必须 failed')
    assert.equal(w2.failedJobId, res.jobId)
    assert.equal(w2.allDone, false)
    // 记录仍在（kill 不删记录）
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ⑭ kill 后再 delete ⇒ 记录才被清（两步彻底分开）', async () => {
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED, PROBE_GONE] })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const killed = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(killed.ok, true)
    await assertRecordsKept(jobDir, res.jobId, call)
    // 被杀掉的进程不存在 ⇒ delete 前置判定放行（探针答 gone）
    const deleted = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(deleted.ok, true, 'kill 之后再 delete ⇒ 删记录成功')
    assert.equal(deleted.mode, 'delete')
    assert.equal(deleted.jobDirRemoved, true)
    assert.equal(deleted.registryRemoved, true)
    assert.equal(deleted.indexRemoved, true)
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, '目录才消失')
    const state = await call('/bgjobs/state')
    assert.equal(state.jobs.some((job) => job.id === res.jobId), false, '注册表条目才消失')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── unknown 门槛（用户裁定 2026-10-08）：无法判定进程状态 ⇒ 默认不清理/删除，只警告；仅显式 force 才做 ──
// 判据（**整串相等**，不做子串匹配；与 lib/core/web.js 的 unknownWarning / unknownError 同源）：
// 反查脚本非零退出（makeKillRunner 的 proclistError）⇒ 原始失败文案固定为下面这一串。
const UNKNOWN_REASON = 'process query exit 1: ERROR: query failed'
const KILL_NOTHING_DONE = '未终止任何进程，记录原封不动'
const DELETE_NOTHING_DONE = '未删除任何记录，job 目录/注册表/索引原封不动'
const unknownWarningText = () => '无法判定该任务的进程状态（' + UNKNOWN_REASON + '）：按裁定默认不执行，仅警告'
const unknownErrorText = (what) => '无法判定本任务是否仍有活进程：' + UNKNOWN_REASON
  + ' —— 已按裁定不执行（' + what + '）；如确认要继续，请显式加 force（HTTP ?force=1 / CLI -Force / GUI 确认框）'
const unknownForcedWarningText = () => '无法判定该任务的进程状态：已按显式 force 继续执行（' + UNKNOWN_REASON + '）'
const unknownForcedDeleteWarningText = () => '无法判定该任务的进程状态：已按显式 force 继续执行 delete（只删记录，不杀任何进程）—— ' + UNKNOWN_REASON

/** 非法动作断言：kill 路径不得有任何 taskkill / schtasks /End / /Delete（= "什么都没做"）。 */
function assertNoDestructiveCall(runner, label) {
  const destructive = runner.calls.filter((argv) => isTaskkill(argv)
    || joined(argv).includes('/End') || joined(argv).includes('/Delete'))
  assert.deepEqual(destructive.map((argv) => joined(argv)), [], label)
}

test('kill-tree: ⑮ 无法判定有没有活进程（反查查询本身失败）⇒ kill 默认**什么都不做**：ok:false + needsForce + 警告，记录保留', async () => {
  // 反查脚本跑不起来（进程查询非零退出）⇒ 连"杀谁"都不知道 ⇒ 按裁定默认不动作、只警告，要动手必须显式 force。
  const runner = makeKillRunner({ proclistError: true })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  try {
    const k = await call('/bgjobs/kill?id=' + res.jobId)
    assert.equal(k.ok, false, '无法判定 ⇒ 绝不谎报成功')
    assert.equal(k.mode, 'unknown')
    assert.equal(k.needsForce, true, '必须明确指示需要 force（期望 needsForce=true，实际 ' + k.needsForce + '）')
    assert.equal(k.forced, undefined, '不带 force ⇒ 绝不得出现 forced 标记')
    assert.equal(k.killed, false, '什么都没杀 ⇒ killed=false')
    assert.equal(k.recordsKept, true, '记录契约不变：一律保留')
    assert.equal(k.error, unknownErrorText(KILL_NOTHING_DONE), 'error 必须整串等于「默认不执行 + 如何 force」文案')
    assert.deepEqual(k.warnings, [unknownWarningText()], 'warnings 必须是那条警告（整串相等）')
    assertNoDestructiveCall(runner, '无法判定 ⇒ 绝不 taskkill、也不动计划任务注册（什么都不做）')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ⑯ delete + 无法判定 + 不带 force ⇒ **不执行任何清理**（job 目录/索引/注册表全在）+ needsForce', async () => {
  const runner = makeKillRunner({ proclistError: true })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  try {
    const d = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(d.ok, false, '无法判定 ⇒ 绝不谎报删除成功')
    assert.equal(d.mode, 'unknown')
    assert.equal(d.needsForce, true, '必须明确指示需要 force（期望 needsForce=true，实际 ' + d.needsForce + '）')
    assert.equal(d.forced, undefined, '不带 force ⇒ 绝不得出现 forced 标记')
    assert.equal(d.jobDirRemoved, false, 'job 目录必须原封不动')
    assert.equal(d.registryRemoved, false, '注册表条目必须原封不动')
    assert.equal(d.indexRemoved, false, '中央索引条目必须原封不动')
    assert.equal(d.error, unknownErrorText(DELETE_NOTHING_DONE), 'error 必须整串等于「默认不执行 + 如何 force」文案')
    assert.deepEqual(d.warnings, [unknownWarningText()], 'warnings 必须是那条警告（整串相等）')
    assertNoDestructiveCall(runner, '无法判定 ⇒ 连计划任务注册都不动（不 /End、不 /Delete）')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ⑰ delete + 无法判定 + force（JSON body { force: true }）⇒ **真的删掉**，回 forced:true', async () => {
  const runner = makeKillRunner({ proclistError: true })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir, handler } = await seedJob({})
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    // ★ force 的第二种传参形态：POST + JSON body { force: true }（query ?force=1 由 ⑱ 覆盖）。
    const d = await callWithBody(handler, '/bgjobs/delete?id=' + res.jobId, { force: true })
    assert.equal(d.ok, true, '带 force ⇒ 照常执行（真删）')
    assert.equal(d.mode, 'delete')
    assert.equal(d.forced, true, '必须能看出"是带 force 才做的"（期望 forced=true，实际 ' + d.forced + '）')
    assert.equal(d.needsForce, undefined, '执行了 ⇒ 不得再回 needsForce')
    assert.equal(d.jobDirRemoved, true, 'job 目录必须被删掉')
    assert.equal(d.registryRemoved, true, '注册表条目必须被删掉')
    assert.equal(d.indexRemoved, true, '中央索引条目必须被删掉')
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, 'job 目录才真的消失')
    const state = await call('/bgjobs/state')
    assert.equal(state.jobs.some((job) => job.id === res.jobId), false, '注册表条目才真的消失')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ⑱ kill + 无法判定 + force（query ?force=1）⇒ 门槛解除、照常执行：forced:true 但**绝不谎报成功**', async () => {
  const runner = makeKillRunner({ proclistError: true })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  try {
    const k = await call('/bgjobs/kill?id=' + res.jobId + '&force=1')
    // 反查本身跑不起来 ⇒ 连"杀谁"都不知道：force 只解除门槛，真杀掉才会是 ok:true（这里如实失败）。
    assert.equal(k.ok, false, 'force 只解除门槛：没杀掉就必须如实回 ok:false')
    assert.equal(k.mode, 'unknown')
    assert.equal(k.forced, true, '必须能看出"是带 force 才做的"（期望 forced=true，实际 ' + k.forced + '）')
    assert.equal(k.needsForce, undefined, '已 force ⇒ 不得再回 needsForce')
    assert.equal(k.killed, false, '确实没杀成 ⇒ killed=false')
    assert.equal(k.error, UNKNOWN_REASON, 'error 必须是探针的原始失败（不再带门槛文案）')
    assert.deepEqual(k.warnings, [unknownForcedWarningText()], 'warnings 必须标明"已按 force 继续执行"')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ⑲ 回归钉子（absent）：进程不存在 ⇒ delete 照常删记录，与 force 无关（无 needsForce / 无 forced）', async () => {
  // absent = 无 pid 文件 + 反查筛不到进程（"进程不存在"）⇒ 既有 delete 语义，带不带 force 一个样。
  const runner = makeKillRunner({ proclist: '' })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  try {
    const plain = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(plain.ok, true, 'absent + 不带 force ⇒ 与既有行为一致：照常删记录')
    assert.equal(plain.mode, 'delete')
    assert.equal(plain.needsForce, undefined, 'absent 与 unknown 无关 ⇒ 不得出现 needsForce')
    assert.equal(plain.forced, undefined, 'absent 不需要 force ⇒ 不得出现 forced')
    assert.equal(plain.jobDirRemoved, true)
    assert.equal(plain.registryRemoved, true)
    assert.equal(plain.indexRemoved, true)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, 'absent ⇒ 目录照常删掉')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ⑳ 回归钉子（live）：有活进程 ⇒ delete 一律拒绝，带 force 也撬不开（无 needsForce / 无 forced）', async () => {
  // live 的越界与否由 kill/delete 语义本身决定，绝不被 force 撬开（force 只对 unknown 生效）。
  // 用 probes 按 pid 固定作答（而不是 probeQueue）：两次调用都必须是 live，不能被"队列用尽"改成 gone。
  const runner = makeKillRunner({ probes: { 4242: PROBE_ALIVE_OWNED } })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  try {
    const plain = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(plain.ok, false, 'live + 不带 force ⇒ 拒绝（既有行为）')
    assert.equal(plain.mode, 'kill')
    assert.equal(plain.needsForce, undefined, 'live 不是 unknown ⇒ 不得出现 needsForce')
    assert.equal(plain.forced, undefined, 'live 不受 force 影响 ⇒ 不得出现 forced')
    const forced = await call('/bgjobs/delete?id=' + res.jobId + '&force=1')
    assert.equal(forced.ok, false, 'live + force ⇒ 仍是拒绝（force 撬不开 live 这道门）')
    assert.equal(forced.mode, 'kill')
    assert.equal(forced.forced, undefined, 'force 对 live 无意义 ⇒ 不得出现 forced 标记')
    assert.equal(forced.jobDirRemoved, false)
    assertNoDestructiveCall(runner, 'live ⇒ 绝不 taskkill')
    await assertRecordsKept(jobDir, res.jobId, call)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ㉑ forced 标记**只在带 force 时出现**：同一 unknown 任务两次 delete 的前后对照', async () => {
  const runner = makeKillRunner({ proclistError: true })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    // 第一次：不带 force ⇒ 拦下、无 forced、记录还在。
    const before = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(before.forced, undefined, '第一次（不带 force）⇒ 不得出现 forced')
    assert.equal(before.needsForce, true)
    await assertRecordsKept(jobDir, res.jobId, call)
    // 第二次：带 force ⇒ 才出现 forced:true，且记录此时才消失。
    const after = await call('/bgjobs/delete?id=' + res.jobId + '&force=1')
    assert.equal(after.forced, true, '第二次（带 force）⇒ forced=true（期望 true，实际 ' + after.forced + '）')
    assert.equal(after.ok, true)
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, '记录是在被 force 的那一次才消失的')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ㉒ 真实 HTTP：面板的调用形态（POST 无 body）+ body 传 force（真 framing，不是桩 req）──

test('kill-tree: ㉒ 真实 HTTP 请求：POST 无 body（面板形态）不挂起且默认不执行；body {force:true} 才真删', async () => {
  const runner = makeKillRunner({ proclistError: true })
  setSchtasksRunner(runner)
  const { res, jobDir, dispose, workdir, handler } = await seedJob({})
  // ★ 真起一个 http server，把**真实 req/res** 交给路由 handler —— 面板走的就是 fetch(url,{method:'POST'})
  //   （无 body），而 force 的第二种形态是 JSON body；两者都必须由真实的请求对象驱动才算数
  //   （桩 req 没有 content-length 分帧，读不到"无 body 时 end 会不会来"这个真实风险）。
  const server = http.createServer((req, resp) => { handler(req, resp) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const withTimeout = (p, label) => Promise.race([
    p,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(label + ' 超时（读请求体挂住了？）')), 10000)),
  ])
  try {
    const plainResp = await withTimeout(fetch(base + '/bgjobs/delete?id=' + res.jobId, { method: 'POST' }), 'POST 无 body')
    const plain = await plainResp.json()
    assert.equal(plain.ok, false, '面板形态（POST 无 body、无 force）⇒ 默认不执行')
    assert.equal(plain.mode, 'unknown')
    assert.equal(plain.needsForce, true, '期望 needsForce=true，实际 ' + plain.needsForce)
    assert.equal(plain.forced, undefined, '没带 force ⇒ 不得出现 forced')
    assert.equal(await fsp.stat(jobDir).catch(() => null) === null, false, '记录必须原封不动')
    // body 形态：POST + JSON body { force: true }（真分帧）
    const forcedResp = await withTimeout(fetch(base + '/bgjobs/delete?id=' + res.jobId, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    }), 'POST body force')
    const forced = await forcedResp.json()
    assert.equal(forced.ok, true, 'body {force:true} ⇒ 照常执行（真删）')
    assert.equal(forced.forced, true, '期望 forced=true，实际 ' + forced.forced)
    assert.equal(forced.mode, 'delete')
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, '记录才消失')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ㉓ 面板路径（裁定 ③「确认即 force」）：POST 无 body + 面板拼出的两种 URL ⇒
//    第一次被拦下（error/warnings 俱在 = 面板确认框要显示的文案），确认后带 `?force=1` 才真删 ──

test('kill-tree: ㉓ 面板路径：无 force 被拦（error + warnings 都在）；确认后带 ?force=1 才真删 + forced', async () => {
  const runner = makeKillRunner({ proclistError: true })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir, handler } = await seedJob({})
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  // ★ 真起 http server：面板走的就是 fetch(url, { method: 'POST' })（无 body），且 URL 由
  //   lib/client-src/panel.js 的 requestDelete 拼出 —— 这里复刻**同一拼法**，验的是真实往返。
  const server = http.createServer((req, resp) => { handler(req, resp) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const panelDeleteUrl = (jobId, withForce) => base + '/bgjobs/delete?id=' + encodeURIComponent(jobId) + (withForce ? '&force=1' : '')
  try {
    // ① 面板的**尝试**形态（POST 无 body、不带 force）⇒ 被 unknown 门槛拦下，记录原封不动。
    const blocked = await (await fetch(panelDeleteUrl(res.jobId, false), { method: 'POST' })).json()
    assert.equal(blocked.ok, false, '无法判定 ⇒ 绝不谎报成功')
    assert.equal(blocked.mode, 'unknown')
    assert.equal(blocked.needsForce, true, '面板就是靠这个标记才弹确认框（期望 true，实际 ' + blocked.needsForce + '）')
    assert.equal(blocked.forced, undefined, '用户还没确认（无 force）⇒ 不得出现 forced')
    // ★ 这两段就是面板确认框要**原样显示**的文案 —— 必须真的在返回里（面板此前把它们整个吞掉）。
    assert.equal(blocked.error, unknownErrorText(DELETE_NOTHING_DONE), 'error 必须整串等于「默认不执行 + 如何 force」文案')
    assert.deepEqual(blocked.warnings, [unknownWarningText()], 'warnings 必须是那条警告（整串相等）')
    assert.equal(await fsp.stat(jobDir).catch(() => null) === null, false, '未确认 ⇒ 记录必须原封不动')
    // ② 面板的**确认后**形态（只有一个字节的差别：`&force=1`）⇒ 真删 + `forced:true`。
    const forced = await (await fetch(panelDeleteUrl(res.jobId, true), { method: 'POST' })).json()
    assert.equal(forced.ok, true, '确认（?force=1）⇒ 照常执行（真删）')
    assert.equal(forced.forced, true, '期望 forced=true，实际 ' + forced.forced)
    assert.equal(forced.needsForce, undefined, '已 force ⇒ 不得再回 needsForce')
    assert.equal(forced.mode, 'delete')
    assert.equal(forced.jobDirRemoved, true)
    assert.equal(forced.registryRemoved, true)
    assert.equal(forced.indexRemoved, true)
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, '记录是被 force 的那一次才删掉的')
    const state = await call('/bgjobs/state')
    assert.equal(state.jobs.some((job) => job.id === res.jobId), false, '注册表条目也消失（面板列表里不再有它）')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ㉔㉕ 新边界（kill 与 delete 各自纯粹）的回归钉子：删除不许杀进程、kill 不许删记录 ──────

test('kill-tree: ㉔ 回归钉子：delete 只删记录 —— live ⇒ 拒绝且记录全在（无 taskkill）；进程消失后才删净', async () => {
  // 两次 delete 之间用 probeQueue 让同一个 pid 从 alive 变 gone（同 pid 不同时刻），一条用例钉住两端：
  //   ① live ⇒ 拒绝（delete **不越界杀进程**、也不删任何记录）；② gone ⇒ 才删净（目录/索引/注册表）。
  const runner = makeKillRunner({ probeQueue: [PROBE_ALIVE_OWNED, PROBE_GONE] })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({ pidFile: 'run.pid', pid: 4242 })
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const live = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(live.ok, false, '还有活进程 ⇒ delete 必须拒绝（绝不删出"看不见但还在跑"的孤儿）')
    assert.equal(live.mode, 'kill', 'live ⇒ 该走的是 kill（模式标记沿用，不许改名）')
    assert.equal(runner.calls.some(isTaskkill), false, 'delete **绝不越界杀进程**')
    await assertRecordsKept(jobDir, res.jobId, call)
    const gone = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(gone.ok, true, '没有活进程 ⇒ delete 才放行')
    assert.equal(gone.mode, 'delete', 'delete 只删记录（模式标记沿用，不许改名）')
    assert.equal(gone.jobDirRemoved, true)
    assert.equal(gone.registryRemoved, true)
    assert.equal(gone.indexRemoved, true)
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, '目录这时才被删掉')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

test('kill-tree: ㉕ absent 与 force 无关（钉死新边界）：kill+force 仍「未发现活进程」记录全在；随后 delete+force 才删净', async () => {
  // ⑮⑯⑰⑱ 已覆盖 unknown 门槛在两条路径上的行为（不带 force 什么都不做 / 带 force 才做），本用例补的是
  // 另一面：**absent 不是 unknown** ⇒ force 对它没有任何语义（无 forced / 无 needsForce，行为一模一样）。
  const runner = makeKillRunner({ proclist: '' })
  setSchtasksRunner(runner)
  const { res, jobDir, call, dispose, workdir } = await seedJob({})
  const indexFile = path.join(process.env.DSH_HOME, 'bgjobs', 'index.json')
  try {
    const k = await call('/bgjobs/kill?id=' + res.jobId + '&force=1')
    assert.equal(k.mode, 'absent', 'force 不改 absent 的判定（未发现活进程）')
    assert.equal(k.forced, undefined, 'absent 不是 unknown ⇒ 不得出现 forced')
    assert.equal(k.needsForce, undefined, 'absent 不是 unknown ⇒ 不得出现 needsForce')
    assert.equal(k.killed, false, '仍然没有任何进程被终止')
    await assertRecordsKept(jobDir, res.jobId, call)
    const d = await call('/bgjobs/delete?id=' + res.jobId + '&force=1')
    assert.equal(d.ok, true, '同一任务随后 delete 才删记录（两步分开）')
    assert.equal(d.mode, 'delete')
    assert.equal(d.forced, undefined, 'absent 不需要 force ⇒ delete 侧也不得出现 forced')
    assert.equal(d.needsForce, undefined)
    await waitIndexGone(indexFile, res.jobId)
    assert.equal(await fsp.stat(jobDir).catch(() => null), null, '记录这时才消失')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ⑥ run.ps1 落盘 run.pid + 两处 PS 镜像一致 ─────────────────────────────

test('scripts: buildPwshRunner 生成的 run.ps1 落盘 run.pid（沙箱与非沙箱都写、且不拦用户命令）', () => {
  const baseMeta = {
    workdir: 'C:\\work', logPath: 'C:\\work\\.dsh\\bgjobs\\bg-x\\stdout.log',
    exitcodePath: 'C:\\work\\.dsh\\bgjobs\\bg-x\\exitcode.txt', jsonPath: 'C:\\work\\.dsh\\bgjobs\\bg-x\\job.json',
    taskName: 'dsh-bgj-bg-x', interpreter: 'C:\\fake\\pwsh.exe', sandbox: 'off',
  }
  const plain = buildPwshRunner({ meta: { ...baseMeta } })
  assert.ok(plain.includes("$pidPath = 'C:\\work\\.dsh\\bgjobs\\bg-x\\run.pid'"), '应写 <jobDir>\\run.pid')
  assert.ok(plain.includes('[System.IO.File]::WriteAllText($pidPath, [string]$PID'), '$PID = 本 run.ps1 进程 = schtasks 任务根')
  const sandboxed = buildPwshRunner({
    meta: {
      ...baseMeta, sandbox: 'workspace-write', nodeExe: 'C:\\node\\node.exe',
      sandboxRunnerPath: 'C:\\r\\runner.js', sandboxTempPath: 'C:\\tmp\\sandbox-1',
    },
  })
  assert.ok(sandboxed.includes("$pidPath = 'C:\\work\\.dsh\\bgjobs\\bg-x\\run.pid'"), '沙箱任务（B1 重灾区）也必须写 run.pid')
  const lines = plain.split('\r\n')
  assert.equal(lines[0], '# bgjobs pwsh runner: 重定向 + exitcode + 自删任务计划')
  assert.equal(lines[1], "$pidPath = 'C:\\work\\.dsh\\bgjobs\\bg-x\\run.pid'", 'pid 行紧跟首行')
  assert.match(lines[2], /^try \{ \[System\.IO\.File\]::WriteAllText\(\$pidPath, \[string\]\$PID.*\) \} catch \{ \}$/, '写入必须 try/catch 兜住（写失败不得拦住用户命令）')
  assert.ok(plain.indexOf('$pidPath =') < plain.indexOf('$utf8 = New-Object'), 'pid 落盘必须在 $utf8 定义之前')
})

test('scripts: run.ps1 的 pid 两行与 PS 镜像（tools/dsh-bgjobs-lib.ps1）逐字一致', async () => {
  const psText = await fsp.readFile(PS_LIB, 'utf8')
  const baseMeta = {
    workdir: 'C:\\work', logPath: 'C:\\work\\.dsh\\bgjobs\\bg-x\\stdout.log',
    exitcodePath: 'C:\\work\\.dsh\\bgjobs\\bg-x\\exitcode.txt', jsonPath: 'C:\\work\\.dsh\\bgjobs\\bg-x\\job.json',
    taskName: 'dsh-bgj-bg-x', interpreter: 'C:\\fake\\pwsh.exe',
  }
  const jsLines = buildPwshRunner({ meta: { ...baseMeta } }).split('\r\n')
  const writeLine = jsLines[2]
  assert.equal(jsLines[1], "$pidPath = 'C:\\work\\.dsh\\bgjobs\\bg-x\\run.pid'")
  const psLines = psText.split(/\r?\n/)
  assert.ok(psLines.includes("$pidPath = '__JOBDIR__\\run.pid'"), 'PS 镜像应含 $pidPath 行（__JOBDIR__ 占位符）')
  assert.ok(psLines.includes(writeLine), 'PS 镜像的 WriteAllText 行必须与 JS 侧逐字一致')
  assert.ok(psText.includes(".Replace('__JOBDIR__', $jobDir)"), 'PS 侧必须替换 __JOBDIR__ 占位符')
  assert.ok(psText.includes('$jobDir = Split-Path $Job.meta.jsonPath -Parent'), 'PS 侧 jobDir 必须与 JS 同源（jsonPath 的父目录）')
})

// 用 PS 镜像生成器造 run.ps1（参数经文件/argv 传递，避开 Windows 命令行引号陷阱）。
const MIRROR_BUILD_PS1 = [
  'param([string]$LibPath, [string]$MetaPath, [string]$OutPath)',
  "$ErrorActionPreference = 'Stop'",
  '. $LibPath',
  '$meta = Get-Content -LiteralPath $MetaPath -Raw -Encoding UTF8 | ConvertFrom-Json',
  '$job = [pscustomobject]@{ meta = $meta }',
  '$text = New-BgjobsPwshRunner $job',
  '[System.IO.File]::WriteAllText($OutPath, $text, (New-Object System.Text.UTF8Encoding($false)))',
].join('\r\n') + '\r\n'

/** 找一个可用的 PowerShell（优先 pwsh 7，退 Windows PowerShell 5.1）；找不到返回 null。 */
function findPowerShell() {
  const candidates = [
    'pwsh',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const exe of candidates) {
    const probe = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' })
    if (probe.status === 0) return exe
  }
  return null
}

test('scripts: run.ps1 编码兜底行 —— 同一个 synthetic job 的 JS 产物与 PS 镜像产物逐字节一致（v0.1.95）', async (t) => {
  const psText = await fsp.readFile(PS_LIB, 'utf8')
  const encodingLine = '    try { [Console]::OutputEncoding = $utf8 } catch { }'
  assert.ok(psText.split(/\r?\n/).includes(encodingLine),
    'PS 镜像模板必须含与 JS 侧逐字一致的编码兜底行（含 4 空格缩进）；期望：' + JSON.stringify(encodingLine))
  const meta = {
    workdir: 'C:\\work', logPath: 'C:\\work\\.dsh\\bgjobs\\bg-x\\stdout.log',
    exitcodePath: 'C:\\work\\.dsh\\bgjobs\\bg-x\\exitcode.txt', jsonPath: 'C:\\work\\.dsh\\bgjobs\\bg-x\\job.json',
    taskName: 'dsh-bgj-bg-x', interpreter: 'C:\\fake\\pwsh.exe',
  }
  const jsText = buildPwshRunner({ meta })
  assert.ok(jsText.includes(encodingLine), 'JS 侧产物必须含该行（缩进必须与镜像一致）')
  const shell = findPowerShell()
  if (shell === null) { t.skip('未找到 pwsh / Windows PowerShell，跳过实机镜像比对'); return }
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-mirror-'))
  try {
    const metaPath = path.join(tmpDir, 'meta.json')
    const buildPath = path.join(tmpDir, 'build-mirror.ps1')
    const mirrorPath = path.join(tmpDir, 'mirror-run.ps1')
    await fsp.writeFile(metaPath, JSON.stringify(meta), 'utf8')
    await fsp.writeFile(buildPath, MIRROR_BUILD_PS1, 'utf8')
    const res = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', buildPath,
      '-LibPath', PS_LIB, '-MetaPath', metaPath, '-OutPath', mirrorPath], { encoding: 'utf8' })
    assert.equal(res.status, 0, 'PS 镜像生成器必须跑通：' + (res.stderr || res.stdout))
    const mirrorBytes = await fsp.readFile(mirrorPath)
    const jsBytes = Buffer.from(jsText, 'utf8')
    // 判据先打印期望/实际长度，便于读数对账（逐字节一致 ⇒ 长度必然相等）
    console.log(`[mirror] js=${jsBytes.length} bytes / ps=${mirrorBytes.length} bytes / byte-equal=${jsBytes.equals(mirrorBytes)}`)
    assert.ok(mirrorBytes.equals(jsBytes),
      `两处产物必须逐字节一致：js=${jsBytes.length} 字节、ps=${mirrorBytes.length} 字节`)
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ⑩ 探针脚本形状（实机验收抓到的真回归）────────────────────────────────

test('kill-tree: 探针脚本形状 —— if/else 之间不得出现分号（否则 PS 把 else 当命令、探针永远 unknown）', () => {
  const script = buildProbeScript(
    4242,
    ['C:\\work\\.dsh\\bgjobs\\bg-x', 'dsh-bgj-bg-x'],
  )
  assert.doesNotMatch(script, /\}\s*;\s*else\b/, '`}; else {` 会让探针 exit 1 且零输出 ⇒ pid 复用防护静默失效')
  assert.match(script, /\} else \{/, 'if 分支与 else 之间只能是空格')
  assert.ok(script.includes('Get-CimInstance Win32_Process -Filter \'ProcessId=4242\''), '按 pid 精确过滤')
  assert.ok(script.includes("$bgCmdline.Contains('c:\\work\\.dsh\\bgjobs\\bg-x')"), 'needle 一律小写（与 PS 的 ToLowerInvariant 对齐）')
  assert.ok(script.includes("$bgCmdline.Contains('dsh-bgj-bg-x')"), '可多个 needle（jobDir + taskName）')
  // 无 needle ⇒ ownerExpr 退化为 $false，形状仍合法
  const bare = buildProbeScript(7, [])
  assert.doesNotMatch(bare, /\}\s*;\s*else\b/)
  assert.ok(bare.includes('$bgOwned = if ($false) { 1 } else { 0 }'))
  // 路径里的单引号必须翻倍转义（否则脚本语法错）
  assert.ok(buildProbeScript(1, ["C:\\it's\\here"]).includes("'c:\\it''s\\here'"))
})
