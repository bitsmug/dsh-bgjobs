// bgjobs tests —— 共享测试工具与套件隔离（v0.1.61 自 tests/index.test.js 拆分）。
// 每个 *.test.js 顶部调用 installSuiteHooks()；所有 helper 从此导入。

import { beforeEach, after } from 'node:test'
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
} from '../../lib/index.js'

export {
  makeDshHome, makeWorkdir, makeCtx, makeFakeRunner, attachWebServer,
  runningPlugin, waitFor, setFullAccessEnabled, restrictedPolicy, fullPolicy,
  agentHandle, submitAndFinish, scheduleExitWrite,
}

/** 每个测试文件顶部调用一次：铺隔离 DSH home（含 legacy full access ON），用例间重置。 */
export function installSuiteHooks() {
  let suiteHome = null
  beforeEach(async () => {
    if (suiteHome) await fsp.rm(suiteHome, { recursive: true, force: true }).catch(() => {})
    const raw = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-suite-'))
    suiteHome = await fsp.realpath(raw).catch(() => raw)
    process.env.DSH_HOME = suiteHome
    await fsp.mkdir(path.join(suiteHome, 'bgjobs'), { recursive: true })
    await fsp.writeFile(path.join(suiteHome, 'bgjobs', 'fullaccess.json'), JSON.stringify({ enabled: true }), 'utf8')
  })
  after(async () => {
    if (suiteHome) await fsp.rm(suiteHome, { recursive: true, force: true }).catch(() => {})
    delete process.env.DSH_HOME
  })
}

// —— 共享 helper 定义（保持原相对顺序）——

async function makeDshHome() {
  const raw = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-home-'))
  // 归一化：去掉 Windows 扩展长度前缀（\\?\），否则 fs.watch 拿到的路径与文件通知
  // API 返回的路径不一致，node 24/libuv 会触发 src\win\fs-event.c 断言崩溃。
  const dir = await fsp.realpath(raw).catch(() => raw)
  process.env.DSH_HOME = dir
  // legacy 语义：该 home 下提交默认 full access 放行（沙箱联动用例显式写 enabled=false）。
  await fsp.mkdir(path.join(dir, 'bgjobs'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'bgjobs', 'fullaccess.json'), JSON.stringify({ enabled: true }), 'utf8')
  return dir
}

// ── 套件级 DSH_HOME 隔离 ──
// recover 现按中央索引恢复（全局地图）：未隔离 DSH_HOME 的用例会读到真实的 ~/.dsh 索引
// （任务挂进注册表、计数断言被污染、剪枝还可能改动真实索引）。每个用例前重置一个全新
// 临时 home；makeDshHome 用例用自己的 home 并在 finally 删除 env，beforeEach 会在下一
// 个用例前重新铺好隔离 home。

let suiteHome = null
beforeEach(async () => {
  if (suiteHome) await fsp.rm(suiteHome, { recursive: true, force: true }).catch(() => {})
  const raw = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-suite-'))
  // 归一化路径，去掉 Windows \\?\ 前缀，避免 fs.watch 断言（同 makeDshHome/makeWorkdir）。
  suiteHome = await fsp.realpath(raw).catch(() => raw)
  process.env.DSH_HOME = suiteHome
  // 套件默认 full access ON（沙箱联动功能 v0.1.29 之前的 legacy 语义）：
  // 无 sandboxPolicy 服务的用例照旧放行；需验证「拒绝/审批/继承」的用例自行写 enabled=false。
  await fsp.mkdir(path.join(suiteHome, 'bgjobs'), { recursive: true })
  await fsp.writeFile(path.join(suiteHome, 'bgjobs', 'fullaccess.json'), JSON.stringify({ enabled: true }), 'utf8')
})
after(async () => {
  if (suiteHome) await fsp.rm(suiteHome, { recursive: true, force: true }).catch(() => {})
  delete process.env.DSH_HOME
})

/** 建一个临时 workdir。 */

async function makeWorkdir() {
  const raw = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-test-'))
  // 归一化路径，去掉 Windows \\?\ 前缀（避免 fs.watch 断言崩溃）。
  return fsp.realpath(raw).catch(() => raw)
}

/** 构造一个 apply 可用的 mock ctx。 */

function makeCtx(overrides = {}) {
  const services = new Map(Object.entries(overrides.services || {}))
  const tools = []
  const intervals = []
  const injectCallbacks = new Map()
  const sections = []
  const onCallbacks = [] // ctx.on 事件监听（{ event, fn }）；测试可手动触发
  const ctx = {
    get(name) { return services.get(name) },
    interval(fn, ms) {
      const entry = { fn, ms, disposed: false }
      intervals.push(entry)
      return () => { entry.disposed = true }
    },
    on(event, fn) {
      onCallbacks.push({ event, fn })
      return () => {}
    },
    inject(names, cb) {
      injectCallbacks.set(names[0], cb)
      return () => {}
    },
    tools: { register(def) { tools.push(def); return () => {} } },
    systemPrompt: { section(def) { sections.push(def); return () => {} } },
  }
  return { ctx, tools, intervals, services, injectCallbacks, sections, onCallbacks }
}

/** 默认 fake schtasks：全部成功，记录调用。 */

function makeFakeRunner(log) {
  return async (argv, _cwd) => {
    log.push(argv)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

/** 挂 webServer，返回注册到的路由定义。 */

function attachWebServer(ctx, injectCallbacks) {
  let registered
  const webServer = { register: (def) => { registered = def; return () => {} } }
  injectCallbacks.get('webServer')({ webServer })
  return () => registered
}

// ── 单元测试：纯函数 ──


async function runningPlugin(workdir, exec) {
  const { ctx, tools, intervals, services, injectCallbacks } = makeCtx({
    services: { workspaceRegistry: { list: () => [] } },
  })
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  const res = await submit.execute({ name: 't', command: 'echo x', workdir }, exec)
  const tick = intervals.find((i) => i.ms === 1000).fn
  return { ctx, dispose, res, tick, services, tools, injectCallbacks }
}


async function waitFor(cond, ms = 500) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail('waitFor timed out')
}

// ── 中央索引 ──


async function setFullAccessEnabled(enabled) {
  await fsp.mkdir(path.join(process.env.DSH_HOME, 'bgjobs'), { recursive: true })
  await fsp.writeFile(
    path.join(process.env.DSH_HOME, 'bgjobs', 'fullaccess.json'),
    JSON.stringify({ enabled }), 'utf8',
  )
}

/** pwsh 引擎可用的 mock 集合：shell + runner 可换，restricted session 策略 + approval。 */

function restrictedPolicy(workdir) {
  return { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workdir }) } }
}

function fullPolicy(workdir) {
  return { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workdir }) } }
}


function agentHandle(sid, status) {
  const calls = { followup: [], inject: [] }
  return {
    id: sid,
    status,
    followup: (m) => { calls.followup.push(m) },
    inject: (m) => { calls.inject.push(m) },
    calls,
  }
}

/** 提交并让任务完成：写 exitcode 后跑一次 tick，返回 job 目录。 */

async function submitAndFinish(tool, args, exec, workdir, exitCode, tick) {
  const res = await tool.execute(args, exec)
  assert.equal(res.ok, true)
  const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
  await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), String(exitCode), 'utf8')
  await tick()
  return jobDir
}


function scheduleExitWrite(jobsRoot, code, delayMs) {
  const started = Date.now()
  let wrote = false
  const timer = setInterval(() => {
    fsp.readdir(jobsRoot)
      .then(async (names) => {
        if (wrote) return
        const dir = names.find((n) => n.startsWith('bg-'))
        if (!dir) return
        const ec = path.join(jobsRoot, dir, 'exitcode.txt')
        const exists = await fsp.access(ec).then(() => true).catch(() => false)
        if (!exists && Date.now() - started >= delayMs) {
          wrote = true
          await fsp.writeFile(ec, String(code), 'utf8')
        }
      })
      .catch(() => {})
  }, 20)
  return { stop: () => clearInterval(timer), get wrote() { return wrote } }
}

