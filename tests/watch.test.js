// bgjobs tests —— tick / 完成检测 / 恢复 / 保留（v0.1.61 自 tests/index.test.js 拆分）。
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

test('tick: 日志增量读 + exitcode 未出现时保持 running', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { dispose, res, tick, ctx, injectCallbacks } = await runningPlugin(workdir)
  try {
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'hello\nworld\n', 'utf8')
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    const req = { url: '/bgjobs/state' }
    let body = ''
    const httpRes = { writeHead: () => {}, end: (b) => { body = b } }
    await getJobs().handler(req, httpRes)
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].status, 'running')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('tick: exitcode 出现 → done、落盘、兜底删除任务计划；tail 含最后写入的行', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const { ctx, dispose, res, tick, injectCallbacks } = await runningPlugin(workdir)
  try {
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'final-line\n', 'utf8')
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    await tick()
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done')
    assert.equal(meta.exitCode, 0)
    assert.ok(calls.some((argv) => argv.includes('/Delete')), 'done 后应 fire-and-forget /Delete')
    // 完成检测（含 checkCompletion 内的补读）后，tail 应包含日志最后写入的行。
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].status, 'done')
    assert.ok(jobs[0].tail.includes('final-line'), '完成时 tail 应包含日志最后一行')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('完成迁移：不再注入会话消息（v0.1.8 起改 UI toast，host 侧不调 agents）', async () => {
  const calls = []
  let agentsCalled = 0
  setSchtasksRunner(makeFakeRunner(calls))
  const workdir = await makeWorkdir()
  const exec = { agent: { session: { id: 'sess-1' } } }
  const { ctx, dispose, res, tick, services } = await runningPlugin(workdir, exec)
  try {
    services.set('agents', {
      get: () => { agentsCalled++ ; return { session: { id: 'sess-1' }, followup: () => { agentsCalled++ } } },
    })
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '3', 'utf8')
    await tick()
    assert.equal(agentsCalled, 0, 'host 侧完成迁移不应调 agents（通知改由 client 轮询弹 toast）')
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done', '完成迁移仍正常落盘 job.json')
    assert.equal(meta.exitCode, 3)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('完成迁移：无 agents 服务时静默不抛错', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, dispose, res, tick, services } = await runningPlugin(workdir) // exec 缺省 → 无 session
  try {
    // 不设置 agents 服务：host 侧完全不触碰，完成迁移不受影响。
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    await assert.doesNotReject(tick())
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 恢复 ──


test('recover: 重挂 running 任务并在 exitcode 出现后迁移 done', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const jobsRoot = workdir + '\\.dsh\\bgjobs'
  await fsp.mkdir(path.join(jobsRoot, 'bg-running'), { recursive: true })
  await fsp.writeFile(path.join(jobsRoot, 'bg-running', 'job.json'), JSON.stringify({
    id: 'bg-running', name: 'r', workdir, jobDir: jobsRoot + '\\bg-running',
    logPath: jobsRoot + '\\bg-running\\stdout.log',
    exitcodePath: jobsRoot + '\\bg-running\\exitcode.txt',
    jsonPath: jobsRoot + '\\bg-running\\job.json',
    taskName: 'dsh-bgj-r', command: 'echo r', status: 'running', createdAt: Date.now(),
  }), 'utf8')
  // 模拟 DSH 离线期间任务已结束：exitcode 在首次 tick 前就绪。
  await fsp.writeFile(path.join(jobsRoot, 'bg-running', 'exitcode.txt'), '7', 'utf8')
  const { ctx, intervals } = makeCtx({
    services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
  })
  const dispose = apply(ctx)
  try {
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const meta = JSON.parse(await fsp.readFile(path.join(jobsRoot, 'bg-running', 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done')
    assert.equal(meta.exitCode, 7)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('recover: workspaceRegistry 未就绪时 tick 不抛错（持续重试）', async () => {
  const workdir = await makeWorkdir()
  const { ctx, intervals } = makeCtx({ services: {} }) // 无 workspaceRegistry
  const dispose = apply(ctx)
  try {
    const tick = intervals.find((i) => i.ms === 1000).fn
    await assert.doesNotReject(tick())
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('recover: 任务 workdir 不在当前工作区也能恢复（中央索引）', async () => {
  const home = await makeDshHome()
  try {
    const workdirA = await makeWorkdir() // 任务所在工作区
    const workdirB = await makeWorkdir() // 当前会话工作区（不含任务）
    const jobId = 'bg-cross-ws'
    const jobDir = workdirA + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'cross', workdir: workdirA, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-cross',
      command: 'echo x', status: 'running', createdAt: Date.now(),
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir: workdirA, name: 'cross', createdAt: Date.now() }] }, home)
    // 当前会话的工作区是 workdirB，与任务 workdir 不同——只能经中央索引恢复。
    const { ctx, intervals, injectCallbacks } = makeCtx({
      services: { workspaceRegistry: { list: () => [{ path: workdirB }] } },
    })
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1, '跨工作区任务应经中央索引恢复')
    assert.equal(jobs[0].id, jobId)
    assert.equal(jobs[0].status, 'running')
    dispose()
    await fsp.rm(workdirA, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(workdirB, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('recover: 无 workspaceRegistry 时按中央索引恢复成功', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-no-ws'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'nows', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-nows',
      command: 'echo x', status: 'done', exitCode: 0, finishedAt: Date.now(), createdAt: Date.now(),
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'nows', createdAt: Date.now() }] }, home)
    const { ctx, intervals, injectCallbacks } = makeCtx({ services: {} }) // 无 workspaceRegistry
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await assert.doesNotReject(tick())
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1, '无 workspaceRegistry 也应从索引恢复')
    assert.equal(jobs[0].id, jobId)
    assert.equal(jobs[0].status, 'done')
    assert.equal(jobs[0].exitCode, 0)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('recover: done 任务重挂后 tail 从磁盘回填（面板不再显示等待输出）', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobsRoot = workdir + '\\.dsh\\bgjobs'
    const mk = async (id, withLog) => {
      const jobDir = jobsRoot + '\\' + id
      await fsp.mkdir(jobDir, { recursive: true })
      await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
        id, name: id, workdir, jobDir,
        logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
        jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-' + id,
        command: 'echo x', status: 'done', exitCode: 0,
        finishedAt: Date.now(), createdAt: Date.now(),
      }), 'utf8')
      if (withLog) await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'line1\nfinal-line\n', 'utf8')
    }
    await mk('bg-done-log', true)
    await mk('bg-done-empty', false)
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [
      { id: 'bg-done-log', jobDir: jobsRoot + '\\bg-done-log', workdir, name: 'bg-done-log', createdAt: Date.now() },
      { id: 'bg-done-empty', jobDir: jobsRoot + '\\bg-done-empty', workdir, name: 'bg-done-empty', createdAt: Date.now() },
    ] }, home)
    const { ctx, intervals, injectCallbacks } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    try {
      const tick = intervals.find((i) => i.ms === 1000).fn
      await tick()
      const getJobs = attachWebServer(ctx, injectCallbacks)
      let body = ''
      await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
      const jobs = JSON.parse(body).jobs
      assert.equal(jobs.length, 2, '两个 done 任务都应从中央索引恢复')
      const withLog = jobs.find((j) => j.id === 'bg-done-log')
      const empty = jobs.find((j) => j.id === 'bg-done-empty')
      assert.equal(withLog.status, 'done')
      assert.ok(withLog.tail.includes('final-line'), '恢复的 done 任务 tail 应从磁盘回填')
      assert.equal(empty.status, 'done')
      assert.equal(empty.tail, '', '无日志文件的 done 任务 tail 保持空')
    } finally {
      dispose()
      await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('recover: 索引缺失时工作区扫描兜底', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-scan-fallback'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'scan', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-scan',
      command: 'echo x', status: 'running', createdAt: Date.now(),
    }), 'utf8')
    // 不写中央索引：仅靠工作区扫描兜底。
    const { ctx, intervals, injectCallbacks } = makeCtx({
      services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
    })
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1, '索引缺失时应由工作区扫描兜底')
    assert.equal(jobs[0].id, jobId)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 保留策略：已完成任务不按时间剪枝（面板与索引保留，直到手动删除/一键清理）──


test('保留: 已完成任务不被时间剪枝（近期与超过24h都保留）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const jobsRoot = workdir + '\\.dsh\\bgjobs'
  const now = Date.now()
  const writeJob = async (id, status, finishedAt) => {
    await fsp.mkdir(path.join(jobsRoot, id), { recursive: true })
    await fsp.writeFile(path.join(jobsRoot, id, 'job.json'), JSON.stringify({
      id, name: id, workdir, jobDir: jobsRoot + '\\' + id,
      logPath: jobsRoot + '\\' + id + '\\stdout.log',
      exitcodePath: jobsRoot + '\\' + id + '\\exitcode.txt',
      jsonPath: jobsRoot + '\\' + id + '\\job.json',
      taskName: 'dsh-bgj-' + id, command: 'echo x', status,
      exitCode: status === 'done' ? 0 : undefined,
      finishedAt, createdAt: finishedAt - 1000,
    }), 'utf8')
  }
  await writeJob('bg-fresh', 'done', now - 60 * 60 * 1000) // 1h 前
  await writeJob('bg-old', 'done', now - 25 * 60 * 60 * 1000) // 25h 前
  const { ctx, intervals, injectCallbacks } = makeCtx({
    services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
  })
  const dispose = apply(ctx)
  try {
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 2, '已完成任务应一直保留（不按时间剪枝）')
    assert.ok(jobs.some((j) => j.id === 'bg-fresh') && jobs.some((j) => j.id === 'bg-old'), '近期与超期 done 均保留')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('state 视图含 finishedAt：面板可据此区分"超 24h 清理"范围', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({
    services: { workspaceRegistry: { list: () => [] } },
  })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const getJobs = attachWebServer(ctx, injectCallbacks)
    let body = ''
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: () => {}, end: (b) => { body = b } })
    const jobs = JSON.parse(body).jobs
    assert.equal(jobs.length, 1)
    const done = jobs[0]
    assert.equal(done.status, 'done')
    assert.equal(typeof done.finishedAt, 'number', 'done 任务视图应携带 finishedAt（时间戳）')
    assert.ok(done.finishedAt <= Date.now())
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── webServer 路由 ──

