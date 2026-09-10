// bgjobs tests —— webServer 路由 / 中央索引 / 磁盘回退（v0.1.61 自 tests/index.test.js 拆分）。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { guiScriptPath, setGuiExec } from '../lib/gui-launch.js'
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

test('webServer: /bgjobs/state 返回 jobs 列表，其他路径 404', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, injectCallbacks } = makeCtx({
    services: { workspaceRegistry: { list: () => [] } },
  })
  const dispose = apply(ctx)
  try {
    const getJobs = attachWebServer(ctx, injectCallbacks)
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    let body = ''
    let status = 0
    await getJobs().handler({ url: '/bgjobs/state' }, { writeHead: (code) => { status = code }, end: (b) => { body = b } })
    assert.equal(status, 200)
    const parsed = JSON.parse(body)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.jobs.length, 1)
    assert.equal(parsed.jobs[0].id, res.jobId)
    // 字段显示用：command 与 createdAt 必须在快照里（面板可选显示命令/开始时间）。
    assert.equal(parsed.jobs[0].command, 'echo x', '快照含 command')
    assert.equal(typeof parsed.jobs[0].createdAt, 'number', '快照含 createdAt（数值）')
    // 其他路径 404
    let status404 = 0
    await getJobs().handler({ url: '/other' }, { writeHead: (code) => { status404 = code }, end: () => {} })
    assert.equal(status404, 404)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('webServer: /bgjobs/log 按需读日志（注册表命中/磁盘兜底/空日志/未知 id）', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const { ctx, tools, intervals, injectCallbacks } = makeCtx({
      services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
    })
    const dispose = apply(ctx)
    try {
      const getJobs = attachWebServer(ctx, injectCallbacks)
      const submit = tools.find((t) => t.name === 'bgjob_submit')
      const call = (url) => new Promise((resolve) => {
        let body = ''
        getJobs().handler({ url }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
      })
      // ① 注册表命中的任务：日志文件有内容 → 返回日志尾
      const live = await submit.execute({ name: 'live', command: 'echo live', workdir }, { agent: undefined })
      await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + live.jobId + '\\stdout.log', 'line1\nlazy-loaded-line\n', 'utf8')
      await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + live.jobId + '\\exitcode.txt', '0', 'utf8')
      await intervals.find((i) => i.ms === 1000).fn() // 完成 → done
      let r = await call('/bgjobs/log?id=' + live.jobId)
      assert.equal(r.ok, true)
      assert.ok(r.text.includes('lazy-loaded-line'), '/bgjobs/log 应返回日志内容')
      // ② 仅磁盘（不在注册表）：中央索引定位 → 返回日志
      const diskId = 'bg-log-disk'
      const jobDir = workdir + '\\.dsh\\bgjobs\\' + diskId
      await fsp.mkdir(jobDir, { recursive: true })
      await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
        id: diskId, name: 'disk', workdir, jobDir,
        logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
        jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-disk',
        command: 'echo x', status: 'done', exitCode: 0, finishedAt: Date.now(), createdAt: Date.now(),
      }), 'utf8')
      await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'disk-output\n', 'utf8')
      await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: diskId, jobDir, workdir, name: 'disk', createdAt: Date.now() }] }, home)
      r = await call('/bgjobs/log?id=' + diskId)
      assert.equal(r.ok, true)
      assert.ok(r.text.includes('disk-output'), '磁盘兜底应返回日志内容')
      // ③ 存在但无日志文件 → ok:true 且 text 为空串
      const emptyId = 'bg-log-empty'
      const emptyDir = workdir + '\\.dsh\\bgjobs\\' + emptyId
      await fsp.mkdir(emptyDir, { recursive: true })
      await fsp.writeFile(path.join(emptyDir, 'job.json'), JSON.stringify({
        id: emptyId, name: 'empty', workdir, jobDir: emptyDir,
        logPath: emptyDir + '\\stdout.log', exitcodePath: emptyDir + '\\exitcode.txt',
        jsonPath: emptyDir + '\\job.json', taskName: 'dsh-bgj-empty',
        command: 'echo x', status: 'done', exitCode: 0, finishedAt: Date.now(), createdAt: Date.now(),
      }), 'utf8')
      await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: emptyId, jobDir: emptyDir, workdir, name: 'empty', createdAt: Date.now() }] }, home)
      r = await call('/bgjobs/log?id=' + emptyId)
      assert.equal(r.ok, true)
      assert.equal(r.text, '', '无日志文件应返回空 text')
      // ④ 未知 id → not found
      r = await call('/bgjobs/log?id=nonexistent')
      assert.equal(r.ok, false)
      assert.equal(r.error, 'not found')
    } finally {
      dispose()
      await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('webServer: /bgjobs/delete 删除单个任务（目录+任务计划+索引）', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const { ctx, tools, intervals, injectCallbacks } = makeCtx({
      services: { workspaceRegistry: { list: () => [] } },
    })
    const dispose = apply(ctx)
    const getJobs = attachWebServer(ctx, injectCallbacks)
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    await waitFor(async () => (await readBgjobsIndex(home)).jobs.length === 1)
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    const call = (url) => new Promise((resolve) => {
      let body = ''
      getJobs().handler({ url }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
    })
    const r = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(r.ok, true)
    assert.equal(r.removed, res.jobId)
    // 目录删除
    assert.ok(!(await fsp.stat(jobDir).catch(() => null)), 'job 目录应被删除')
    // running 任务：/End + /Delete 都调过
    assert.ok(calls.some((argv) => argv.includes('/End')))
    assert.ok(calls.some((argv) => argv.includes('/Delete')))
    // 索引移除（fire-and-forget，等待）
    await waitFor(async () => (await readBgjobsIndex(home)).jobs.length === 0)
    // 再次删除 → not found
    const again = await call('/bgjobs/delete?id=' + res.jobId)
    assert.equal(again.ok, false)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('webServer: /bgjobs/cleanup 一键清理 done 任务（含异常退出），保留 running', async () => {
  const calls = []
  setSchtasksRunner(makeFakeRunner(calls))
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const { ctx, tools, intervals, injectCallbacks } = makeCtx({
      services: { workspaceRegistry: { list: () => [] } },
    })
    const dispose = apply(ctx)
    const getJobs = attachWebServer(ctx, injectCallbacks)
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    // 提交 3 个任务
    const a = await submit.execute({ name: 'a', command: 'echo a', workdir }, { agent: undefined })
    const b = await submit.execute({ name: 'b', command: 'echo b', workdir }, { agent: undefined })
    const c = await submit.execute({ name: 'c', command: 'echo c', workdir }, { agent: undefined })
    const tick = intervals.find((i) => i.ms === 1000).fn
    // a,b 完成（a 正常、b 异常）；c 保持 running
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + a.jobId + '\\exitcode.txt', '0', 'utf8')
    await fsp.writeFile(workdir + '\\.dsh\\bgjobs\\' + b.jobId + '\\exitcode.txt', '5', 'utf8')
    await tick()
    const call = (url) => new Promise((resolve) => {
      let body = ''
      getJobs().handler({ url }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
    })
    const r = await call('/bgjobs/cleanup')
    assert.equal(r.ok, true)
    assert.deepEqual(r.removed.sort(), [a.jobId, b.jobId].sort())
    // c 仍在
    const state = await call('/bgjobs/state')
    assert.equal(state.jobs.length, 1)
    assert.equal(state.jobs[0].id, c.jobId)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

/** 等待条件成立（轮询，最多 ~500ms），用于 fire-and-forget 的索引写入。 */

test('索引: resolveBgjobsHome 优先 DSH_HOME，缺省 ~/.dsh', async () => {
  const home = await makeDshHome()
  try {
    assert.equal(resolveBgjobsHome(), path.resolve(home))
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('索引: read/write/update 基本读写', async () => {
  const home = await makeDshHome()
  try {
    assert.deepEqual(await readBgjobsIndex(home), { version: 1, updatedAt: 0, jobs: [] })
    await updateBgjobsIndex((jobs) => jobs.push({ id: 'bg-1', jobDir: 'C:\\d' }), home)
    const idx = await readBgjobsIndex(home)
    assert.equal(idx.jobs.length, 1)
    assert.equal(idx.jobs[0].id, 'bg-1')
    await updateBgjobsIndex((jobs) => jobs.push({ id: 'bg-2', jobDir: 'C:\\e' }), home)
    assert.equal((await readBgjobsIndex(home)).jobs.length, 2)
    // upsert 语义：同 id 覆盖而非重复
    await updateBgjobsIndex((jobs) => {
      const at = jobs.findIndex((j) => j.id === 'bg-1')
      if (at >= 0) jobs[at] = { ...jobs[at], name: 'renamed' }
      else jobs.push({ id: 'bg-1', name: 'renamed' })
    }, home)
    const after = await readBgjobsIndex(home)
    assert.equal(after.jobs.filter((j) => j.id === 'bg-1').length, 1)
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('索引: 损坏文件读为空且不抛错', async () => {
  const home = await makeDshHome()
  try {
    const p = bgjobsIndexPath(home)
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, 'not-json{{{', 'utf8')
    const idx = await readBgjobsIndex(home)
    assert.deepEqual(idx, { version: 1, updatedAt: 0, jobs: [] })
    // 非预期结构（jobs 不是数组）同样容错
    await fsp.writeFile(p, JSON.stringify({ jobs: 'oops' }), 'utf8')
    assert.deepEqual(await readBgjobsIndex(home), { version: 1, updatedAt: 0, jobs: [] })
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('索引: rebuildBgjobsIndex 扫描工作区重建', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobsRoot = workdir + '\\.dsh\\bgjobs'
    await fsp.mkdir(path.join(jobsRoot, 'bg-a'), { recursive: true })
    await fsp.writeFile(path.join(jobsRoot, 'bg-a', 'job.json'), JSON.stringify({
      id: 'bg-a', name: 'a', workdir, jobDir: jobsRoot + '\\bg-a',
      logPath: jobsRoot + '\\bg-a\\stdout.log',
      exitcodePath: jobsRoot + '\\bg-a\\exitcode.txt',
      jsonPath: jobsRoot + '\\bg-a\\job.json',
      taskName: 'dsh-bgj-a', command: 'echo a', status: 'running', createdAt: 1000,
    }), 'utf8')
    await fsp.mkdir(path.join(jobsRoot, 'bg-b'), { recursive: true })
    await fsp.writeFile(path.join(jobsRoot, 'bg-b', 'job.json'), JSON.stringify({
      id: 'bg-b', name: 'b', workdir, jobDir: jobsRoot + '\\bg-b',
      logPath: jobsRoot + '\\bg-b\\stdout.log',
      exitcodePath: jobsRoot + '\\bg-b\\exitcode.txt',
      jsonPath: jobsRoot + '\\bg-b\\job.json',
      taskName: 'dsh-bgj-b', command: 'echo b', status: 'running', createdAt: 2000,
    }), 'utf8')
    // 非任务目录：无 job.json，应跳过
    await fsp.mkdir(path.join(jobsRoot, 'not-a-job'), { recursive: true })
    const idx = await rebuildBgjobsIndex([workdir], home)
    assert.equal(idx.jobs.length, 2)
    assert.equal(idx.jobs[0].id, 'bg-a')
    assert.equal(idx.jobs[0].jobDir, jobsRoot + '\\bg-a')
    // 落盘可读
    const fromDisk = await readBgjobsIndex(home)
    assert.equal(fromDisk.jobs.length, 2)
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('索引: submitJob 成功写入索引；完成不删条目', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const { ctx, tools, intervals, services } = makeCtx({
      services: { workspaceRegistry: { list: () => [] } },
    })
    const dispose = apply(ctx)
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    // 提交后索引含该 job（fire-and-forget，等待落盘）
    await waitFor(async () => (await readBgjobsIndex(home)).jobs.length === 1)
    const idx = await readBgjobsIndex(home)
    assert.equal(idx.jobs.length, 1)
    assert.equal(idx.jobs[0].id, res.jobId)
    assert.equal(idx.jobs[0].workdir, workdir)
    // 任务完成后索引条目仍在（地图不删，状态实时读 job.json）
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + res.jobId
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '0', 'utf8')
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    const after = await readBgjobsIndex(home)
    assert.equal(after.jobs.length, 1, '完成不删索引条目')
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('索引: recover 兼收近期与超期任务（不按时间剪枝）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobsRoot = workdir + '\\.dsh\\bgjobs'
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
    const now = Date.now()
    await writeJob('bg-fresh', 'done', now - 60 * 60 * 1000) // 1h 前：保留 + 入索引
    await writeJob('bg-old', 'done', now - 25 * 60 * 60 * 1000) // 25h 前：同样保留 + 入索引
    const { ctx, intervals } = makeCtx({
      services: { workspaceRegistry: { list: () => [{ path: workdir }] } },
    })
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick() // recover 挂接；所有任务是磁盘目录都入索引
    await waitFor(async () => (await readBgjobsIndex(home)).jobs.length === 2)
    const idx = await readBgjobsIndex(home)
    assert.equal(idx.jobs.length, 2, '近期与超期任务均入索引（不按时间剪枝）')
    assert.ok(idx.jobs.some((j) => j.id === 'bg-fresh') && idx.jobs.some((j) => j.id === 'bg-old'))
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── bgjob_status 磁盘回退（会话重启后旧 id 不再被追踪的假象修复）──


test('bgjob_status: 内存注册表命中走内存路径（回归）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [] } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const status = tools.find((t) => t.name === 'bgjob_status')
    const res = await submit.execute({ name: 't', command: 'echo x', workdir }, { agent: undefined })
    const st = await status.execute({ jobId: res.jobId })
    assert.equal(st.error, undefined)
    assert.equal(st.id, res.jobId)
    assert.equal(st.status, 'running')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_status: 磁盘回退（索引）—— 重启后旧 running 任务返回 running 而非 not found', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-old-running'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    const meta = {
      id: jobId, name: 'old-r', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-old-r',
      command: 'ping -n 9 127.0.0.1', status: 'running', createdAt: Date.now(),
    }
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(meta), 'utf8')
    await fsp.writeFile(path.join(jobDir, 'stdout.log'), 'line1\nline2\n', 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'old-r', createdAt: meta.createdAt }] }, home)
    // 不提供 workspaceRegistry：只能走中央索引定位。
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.error, undefined)
    assert.equal(st.id, jobId)
    assert.equal(st.name, 'old-r')
    assert.equal(st.status, 'running')
    assert.equal(st.exitCode, null)
    assert.equal(st.logPath, meta.logPath)
    assert.ok(st.tail.includes('line2'))
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_status: 磁盘回退 —— DSH 离线期间任务结束（exitcode.txt）→ done + 退出码', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-old-done'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    const meta = {
      id: jobId, name: 'old-d', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-old-d',
      command: 'exit 3', status: 'running', createdAt: Date.now(),
    }
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(meta), 'utf8')
    await fsp.writeFile(path.join(jobDir, 'exitcode.txt'), '3', 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'old-d', createdAt: meta.createdAt }] }, home)
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.status, 'done')
    assert.equal(st.exitCode, 3)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_status: 磁盘回退 —— job.json 已落盘 done 终态直接返回', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-final'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'f', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-f',
      command: 'echo done', status: 'done', exitCode: 0, finishedAt: Date.now(), createdAt: Date.now(),
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'f', createdAt: Date.now() }] }, home)
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.status, 'done')
    assert.equal(st.exitCode, 0)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_status: 磁盘回退 —— 索引缺失时按工作区扫描定位', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-scan'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 's', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-s',
      command: 'echo s', status: 'running', createdAt: Date.now(),
    }), 'utf8')
    // 不写中央索引；只提供 workspaceRegistry 兜底扫描。
    const { ctx, tools } = makeCtx({ services: { workspaceRegistry: { list: () => [{ path: workdir }] } } })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.error, undefined)
    assert.equal(st.status, 'running')
    assert.equal(st.name, 's')
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_status: 磁盘回退只读，不触发任何 schtasks（不终止任务）', async () => {
  const home = await makeDshHome()
  try {
    const workdir = await makeWorkdir()
    const jobId = 'bg-nokill'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'k', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-k',
      command: 'ping -n 9 127.0.0.1', status: 'running', createdAt: Date.now(),
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'k', createdAt: Date.now() }] }, home)
    const calls = []
    setSchtasksRunner(makeFakeRunner(calls))
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId })
    assert.equal(st.status, 'running', 'running 任务被如实返回，不受查询影响')
    assert.deepEqual(calls, [], '状态查询不得调用 schtasks（/End//Delete 等终止逻辑）')
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})


test('bgjob_status: 磁盘回退 —— 未知 id 仍返回 job not found', async () => {
  const home = await makeDshHome()
  try {
    const { ctx, tools } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    const status = tools.find((t) => t.name === 'bgjob_status')
    const st = await status.execute({ jobId: 'bg-nonexistent' })
    assert.ok(st.error && st.error.includes('not found'))
    dispose()
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 沙箱联动（v0.1.29）──

/** 写 full access 开关（false 时受限会话宽请求须审批 / 无服务须拒绝）。 */

// ── UI 偏好 + GUI 启动路由（v0.1.65）──

test('webServer: /bgjobs/uiprefs 缺省 false；POST 后 GET 与磁盘回读一致；缺参 400', async () => {
  const home = await makeDshHome()
  try {
    const { ctx, injectCallbacks } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    try {
      const getJobs = attachWebServer(ctx, injectCallbacks)
      const call = (url, method) => new Promise((resolve) => {
        let body = ''
        getJobs().handler({ url, method: method || 'GET' }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
      })
      let r = await call('/bgjobs/uiprefs')
      assert.equal(r.ok, true)
      assert.equal(r.sidebarEntry, false, '无文件/旧版升级缺省 false（入口默认隐藏）')
      r = await call('/bgjobs/uiprefs?sidebarEntry=1', 'POST')
      assert.equal(r.ok, true)
      assert.equal(r.sidebarEntry, true)
      r = await call('/bgjobs/uiprefs')
      assert.equal(r.sidebarEntry, true, 'POST 后 GET 回读缓存')
      const onDisk = JSON.parse(await fsp.readFile(path.join(home, 'bgjobs', 'ui-prefs.json'), 'utf8'))
      assert.equal(onDisk.sidebarEntry, true, '偏好应落盘 ui-prefs.json')
      let status400 = 0
      await getJobs().handler({ url: '/bgjobs/uiprefs', method: 'POST' }, { writeHead: (c) => { status400 = c }, end: () => {} })
      assert.equal(status400, 400, 'POST 缺 sidebarEntry 参数应 400')
    } finally {
      dispose()
    }
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 字段显示偏好（v0.1.70）：display 三态 + 一键恢复默认 + 非法值回落 ──
test('webServer: /bgjobs/uiprefs display 默认/持久化/一键恢复默认/非法值回落', async () => {
  const home = await makeDshHome()
  try {
    const { ctx, injectCallbacks } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    try {
      const getJobs = attachWebServer(ctx, injectCallbacks)
      const callWith = (url, method, body) => new Promise((resolve) => {
        const req = {
          url, method: method || 'GET',
          on: (ev, cb) => {
            if (ev === 'data' && body !== undefined) cb(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
            if (ev === 'end') cb()
          },
          destroy: () => {},
        }
        getJobs().handler(req, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
      })
      const call = (url, method) => callWith(url, method)

      // 默认：name/status/workdir=list，其余 hidden；含 defaultDisplay
      let r = await call('/bgjobs/uiprefs')
      assert.equal(r.ok, true)
      assert.deepEqual(r.display, { id: 'hidden', name: 'list', status: 'list', exitCode: 'hidden', workdir: 'list', command: 'hidden', createdAt: 'hidden', finishedAt: 'hidden' }, '缺省 display = 默认配置')
      assert.deepEqual(r.defaultDisplay, r.display, 'defaultDisplay 与默认一致')

      // JSON body 修改单字段：仅该字段变化，其余保持
      r = await callWith('/bgjobs/uiprefs', 'POST', { display: { id: 'detail' } })
      assert.equal(r.display.id, 'detail', 'POST body 改 id=detail')
      assert.equal(r.display.name, 'list', '未提供的字段保持默认')

      // 落盘 + 回读一致
      const onDisk = JSON.parse(await fsp.readFile(path.join(home, 'bgjobs', 'ui-prefs.json'), 'utf8'))
      assert.equal(onDisk.display.id, 'detail', 'display 应落盘 ui-prefs.json')
      r = await call('/bgjobs/uiprefs')
      assert.equal(r.display.id, 'detail', 'GET 回读缓存一致')

      // 非法值 → 忽略该项（保持原值，不覆盖）；同请求内合法值仍生效
      r = await callWith('/bgjobs/uiprefs', 'POST', { display: { id: 'bogus', status: 'detail' } })
      assert.equal(r.display.id, 'detail', '非法值被忽略（保持原值）')
      assert.equal(r.display.status, 'detail', '同请求内合法值仍生效')

      // 一键恢复默认
      r = await call('/bgjobs/uiprefs?action=resetDisplay', 'POST')
      assert.equal(r.ok, true)
      assert.equal(r.display.status, 'list', '恢复默认：status 回到 list')
      assert.equal(r.display.name, 'list', '恢复默认：name 回到 list')
      assert.equal(r.display.workdir, 'list', '恢复默认：workdir 回到 list')
      assert.equal(r.display.id, 'hidden', '恢复默认：id 回到 hidden')
      r = await call('/bgjobs/uiprefs')
      assert.deepEqual(r.display, r.defaultDisplay, 'GET 回读等于默认')

      // 旧 query 形式仍可用（向后兼容），且不覆盖 display
      r = await call('/bgjobs/uiprefs?sidebarEntry=1', 'POST')
      assert.equal(r.sidebarEntry, true, '旧 sidebarEntry query 仍生效')
      assert.equal(r.display.name, 'list', 'sidebarEntry POST 不影响 display')

      // 界面元素显隐（v0.1.71）：默认全显示；POST body {elements} 改单个；一键恢复同时重置
      r = await call('/bgjobs/uiprefs')
      assert.deepEqual(r.elements, { settingsButton: true, mcpSettingsButton: true, onlySession: true, fullAccess: true, groupHeader: true, notify: true }, '缺省 elements = 全显示')
      assert.deepEqual(r.defaultElements, r.elements, 'defaultElements 与默认一致')
      r = await callWith('/bgjobs/uiprefs', 'POST', { elements: { notify: false } })
      assert.equal(r.elements.notify, false, 'POST body 改 elements.notify=false')
      assert.equal(r.elements.onlySession, true, '未提供的元素保持原值')
      assert.equal(r.display.name, 'list', 'elements POST 不影响 display')
      const onDisk2 = JSON.parse(await fsp.readFile(path.join(home, 'bgjobs', 'ui-prefs.json'), 'utf8'))
      assert.equal(onDisk2.elements.notify, false, 'elements 应落盘 ui-prefs.json')
      r = await callWith('/bgjobs/uiprefs', 'POST', { elements: { notify: 'bogus' } })
      assert.equal(r.elements.notify, false, '非布尔值应被忽略（保持原值）')
      // 齿轮设置入口也可单独隐藏（v0.1.72）
      r = await callWith('/bgjobs/uiprefs', 'POST', { elements: { settingsButton: false } })
      assert.equal(r.elements.settingsButton, false, '可隐藏设置入口齿轮')
      // MCP 设置入口（数据齿轮）是独立开关，同样可单独隐藏
      r = await callWith('/bgjobs/uiprefs', 'POST', { elements: { mcpSettingsButton: false } })
      assert.equal(r.elements.mcpSettingsButton, false, '可单独隐藏 MCP 设置入口')
      assert.equal(r.elements.settingsButton, false, '改 MCP 入口不影响设置入口齿轮的现值')
      r = await call('/bgjobs/uiprefs?action=resetDisplay', 'POST')
      assert.equal(r.elements.settingsButton, true, '一键恢复默认恢复设置入口齿轮')
      assert.equal(r.elements.mcpSettingsButton, true, '一键恢复默认恢复 MCP 设置入口')
      assert.equal(r.elements.notify, true, '一键恢复默认同时重置 elements')
      assert.equal(r.display.name, 'list', '一键恢复默认重置 display')
    } finally {
      dispose()
    }
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('webServer: /bgjobs/gui GET 报工具脚本信息与版本', async () => {
  const home = await makeDshHome()
  try {
    const { ctx, injectCallbacks } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    try {
      const getJobs = attachWebServer(ctx, injectCallbacks)
      const call = (url) => new Promise((resolve) => {
        let body = ''
        getJobs().handler({ url }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
      })
      const info = await call('/bgjobs/gui')
      assert.equal(info.ok, true)
      assert.equal(info.path, guiScriptPath())
      assert.ok(info.path.replace(/\\/g, '/').endsWith('tools/dsh-bgjobs-gui.ps1'))
      assert.equal(info.exists, true)
      assert.equal(typeof info.version, 'string')
      assert.match(info.version, /^\d+\.\d+\.\d+/)
    } finally {
      dispose()
    }
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('webServer: /bgjobs/gui POST open —— schtasks 一次性任务拉起（脱离宿主 job、任务调用成功即 ok）', async () => {
  const home = await makeDshHome()
  const calls = []
  setShellResolver(async () => ({ exe: 'C:\\Fake\\pwsh.exe', engine: 'pwsh' }))
  try {
    setSchtasksRunner((argv) => { calls.push(argv); return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }) })
    const { ctx, injectCallbacks } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    try {
      const getJobs = attachWebServer(ctx, injectCallbacks)
      const call = (url) => new Promise((resolve) => {
        let body = ''
        getJobs().handler({ url, method: 'POST' }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
      })
      const r = await call('/bgjobs/gui?action=open')
      assert.equal(r.ok, true)
      assert.equal(r.launcher, 'schtasks')
      const create = calls.find((a) => a[1] === '/Create')
      assert.ok(create, '应有 schtasks /Create')
      assert.equal(create[3], 'dsh-bgj-gui', '固定任务名 dsh-bgj-gui（/F 覆盖，不堆积）')
      // /TR 只带 cmd.exe /c <短路径批处理>（schtasks /TR 有长度上限，深路径安装必须经批处理承载长命令）
      const tr = create[create.indexOf('/TR') + 1]
      assert.ok(tr.includes('cmd.exe') && tr.includes('/c'), '/TR 应经 cmd.exe /c 跑批处理')
      const batch = path.join(os.tmpdir(), 'bgjobs-gui-launch.cmd')
      assert.ok(tr.includes(batch), '/TR 指向 %TEMP% 短路径批处理')
      const batchText = readFileSync(batch, 'utf8')
      assert.ok(batchText.includes('start ""'), '批处理用 start 起 GUI（独立控制台）')
      assert.ok(batchText.includes('"C:\\Fake\\pwsh.exe"'), '批处理目标为解析到的 pwsh')
      assert.ok(batchText.includes('-NoProfile') && batchText.includes('-File'))
      assert.ok(batchText.includes('-WindowStyle Hidden'), '控制台创建即隐藏')
      assert.ok(batchText.includes(guiScriptPath()), '批处理目标文件为 GUI 脚本')
      assert.ok(create.includes('/SC') && create.includes('ONCE') && create.includes('/F'))
      assert.ok(calls.some((a) => a[1] === '/Run' && a[3] === 'dsh-bgj-gui'), '应有 /Run 立即触发')
      assert.ok(calls.some((a) => a[1] === '/Change' && a.includes('/DISABLE')), '触发后立即 /DISABLE 防整分双跑')
      await fsp.rm(batch, { force: true }).catch(() => {})
    } finally {
      dispose()
    }
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('webServer: /bgjobs/gui POST open —— schtasks /Create / /Run 失败 → ok:false 透出', async () => {
  const home = await makeDshHome()
  setShellResolver(async () => ({ exe: 'C:\\Fake\\pwsh.exe', engine: 'pwsh' }))
  try {
    const { ctx, injectCallbacks } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    try {
      const getJobs = attachWebServer(ctx, injectCallbacks)
      const call = () => new Promise((resolve) => {
        let body = ''
        getJobs().handler({ url: '/bgjobs/gui?action=open', method: 'POST' }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
      })
      // ① /Create 失败 → 透出 stderr
      setSchtasksRunner(() => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'access is denied' }))
      let r = await call()
      assert.equal(r.ok, false)
      assert.ok(r.error && r.error.includes('create failed') && r.error.includes('access is denied'), 'create 失败应透出：' + r.error)
      // ② /Create 成功、/Run 失败 → 透出
      let n = 0
      setSchtasksRunner(() => Promise.resolve(++n === 1 ? { exitCode: 0, stdout: '', stderr: '' } : { exitCode: 2, stdout: '', stderr: 'run error' }))
      r = await call()
      assert.equal(r.ok, false)
      assert.ok(r.error && r.error.includes('run failed') && r.error.includes('run error'), 'run 失败应透出：' + r.error)
    } finally {
      dispose()
    }
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('webServer: /bgjobs/gui POST reveal —— powershell Invoke-Item 目录打开（第一方原语）', async () => {
  const home = await makeDshHome()
  const execCalls = []
  try {
    setGuiExec((file, args, options, cb) => {
      execCalls.push({ file, args, options })
      cb(null, '', '')
    })
    const { ctx, injectCallbacks } = makeCtx({ services: {} })
    const dispose = apply(ctx)
    try {
      const getJobs = attachWebServer(ctx, injectCallbacks)
      const call = (url) => new Promise((resolve) => {
        let body = ''
        getJobs().handler({ url, method: 'POST' }, { writeHead: () => {}, end: (b) => { resolve(JSON.parse(b || '{}')) } })
      })
      const r = await call('/bgjobs/gui?action=reveal')
      assert.equal(r.ok, true)
      assert.equal(execCalls.length, 1)
      const ec = execCalls[0]
      assert.ok(String(ec.file).toLowerCase().endsWith('powershell.exe'))
      assert.ok(ec.args.includes('-NoProfile'))
      const cmd = ec.args.find((a) => String(a).startsWith('Invoke-Item'))
      assert.ok(cmd, '命令应为 Invoke-Item -LiteralPath')
      assert.ok(cmd.includes('tools'), '打开的是 tools 目录（脚本父目录）')
      assert.equal(ec.options.windowsHide, true)
      // 失败：execFile error → ok:false 透出
      setGuiExec((file, args, options, cb) => cb(new Error('denied'), '', 'access denied'))
      const r2 = await call('/bgjobs/gui?action=reveal')
      assert.equal(r2.ok, false)
      assert.ok(r2.error && (r2.error.includes('denied') || r2.error.includes('access denied')), 'exec 错误应透出：' + r2.error)
    } finally {
      dispose()
    }
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
