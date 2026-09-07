// bgjobs tests —— 完成通知创建者（v0.1.61 自 tests/index.test.js 拆分）。
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

test('shouldNotifyForExit: off/on-completion/on-fail/on-exit 矩阵', () => {
  assert.equal(shouldNotifyForExit(undefined, 0), false)
  assert.equal(shouldNotifyForExit('off', 0), false)
  assert.equal(shouldNotifyForExit('off', 5), false)
  assert.equal(shouldNotifyForExit('on-completion', 0), true)
  assert.equal(shouldNotifyForExit('on-completion', 5), false)
  assert.equal(shouldNotifyForExit('on-completion', null), false)
  assert.equal(shouldNotifyForExit('on-fail', 0), false)
  assert.equal(shouldNotifyForExit('on-fail', 5), true)
  assert.equal(shouldNotifyForExit('on-exit', 0), true)
  assert.equal(shouldNotifyForExit('on-exit', 5), true)
  assert.equal(shouldNotifyForExit('on-exit', null), false)
})


test('tools schema: bgjob_submit/bgjob_submit_pwsh 含 notify/notify_mode 枚举，缺省 off/wakeup', () => {
  const { ctx, tools } = makeCtx({ services: {} })
  const dispose = apply(ctx)
  for (const name of ['bgjob_submit', 'bgjob_submit_pwsh']) {
    const tool = tools.find((t) => t.name === name)
    const props = tool.parameters.properties
    assert.deepEqual(props.notify.enum, ['off', 'on-completion', 'on-fail', 'on-exit'])
    assert.equal(props.notify.default, 'off')
    assert.deepEqual(props.notify_mode.enum, ['wakeup', 'quiet', 'always'])
    assert.equal(props.notify_mode.default, 'wakeup')
    assert.deepEqual(tool.parameters.required, ['name', 'command', 'workdir'])
  }
  dispose()
})


test('notify 缺省 off：任务完成不注入会话、job.json 无 notify/notifiedAt', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    const jobDir = await submitAndFinish(submit, { name: 't', command: 'echo x', workdir }, exec, workdir, 0, tick)
    assert.equal(handle.calls.followup.length, 0)
    assert.equal(handle.calls.inject.length, 0)
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.notify, undefined)
    assert.equal(meta.notifiedAt, undefined)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('notify=on-exit + wakeup + 空闲 → followup 唤醒，消息含任务名与退出码，notifiedAt 落盘', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    const jobDir = await submitAndFinish(submit, { name: 't', command: 'echo x', workdir, notify: 'on-exit' }, exec, workdir, 3, tick)
    assert.equal(handle.calls.followup.length, 1)
    assert.equal(handle.calls.inject.length, 0)
    const msg = handle.calls.followup[0]
    assert.equal(msg.role, 'user')
    assert.equal(msg.source.kind, 'plugin')
    assert.equal(msg.source.plugin, 'bgjobs')
    assert.ok(msg.content[0].text.includes('后台任务「t」已结束（exit code 3）'))
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.notify, 'on-exit')
    assert.equal(meta.notifiedAt !== undefined, true, '通知后应落盘 notifiedAt')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('notify=on-exit + wakeup + 忙碌 → inject 排入收件箱（不唤醒）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'running')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit_pwsh')
    setShellResolver(async () => ({ exe: 'C:\\pwsh\\pwsh.exe', engine: 'pwsh' }))
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    await submitAndFinish(submit, { name: 't', command: 'Write-Output ok', workdir, notify: 'on-exit' }, exec, workdir, 0, tick)
    assert.equal(handle.calls.followup.length, 0, '忙碌会话不得唤醒')
    assert.equal(handle.calls.inject.length, 1)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('notify_mode=quiet + 空闲 → 仅 inject，不唤醒', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    await submitAndFinish(submit, { name: 't', command: 'echo x', workdir, notify: 'on-exit', notify_mode: 'quiet' }, exec, workdir, 0, tick)
    assert.equal(handle.calls.followup.length, 0)
    assert.equal(handle.calls.inject.length, 1)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('notify_mode=always + 空闲 → 无视预算恒 followup', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    for (let i = 0; i < 4; i++) {
      await submitAndFinish(submit, { name: 'n' + i, command: 'echo x', workdir, notify: 'on-exit', notify_mode: 'always' }, exec, workdir, 0, tick)
    }
    assert.equal(handle.calls.followup.length, 4)
    assert.equal(handle.calls.inject.length, 0)
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('wakeup 预算：连续 2 次唤醒后降级 inject；用户领走消息后重置', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals, onCallbacks } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    const finish = (name) => submitAndFinish(submit, { name, command: 'echo x', workdir, notify: 'on-exit' }, exec, workdir, 0, tick)
    await finish('a')
    await finish('b')
    assert.equal(handle.calls.followup.length, 2, '预算内应唤醒')
    assert.equal(handle.calls.inject.length, 0)
    await finish('c')
    assert.equal(handle.calls.followup.length, 2, '超预算应停止唤醒')
    assert.equal(handle.calls.inject.length, 1)
    // 用户领走收件箱消息 → 重置预算
    const claimed = onCallbacks.find((c) => c.event === 'agent/inbox/claimed')
    assert.ok(claimed, 'apply 应注册 agent/inbox/claimed 监听')
    claimed.fn({ agent: { id: 's1' }, message: { source: { kind: 'user' } } })
    await finish('d')
    assert.equal(handle.calls.followup.length, 3, '用户消息后应恢复唤醒')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('notify=on-completion + 非零退出 → 不通知；on-fail + 非零 → 通知', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const handle = agentHandle('s1', 'idle')
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    await submitAndFinish(submit, { name: 'ok', command: 'echo x', workdir, notify: 'on-completion' }, exec, workdir, 5, tick)
    assert.equal(handle.calls.followup.length, 0, 'on-completion + exit≠0 不通知')
    await submitAndFinish(submit, { name: 'fail', command: 'echo x', workdir, notify: 'on-fail' }, exec, workdir, 5, tick)
    assert.equal(handle.calls.followup.length, 1, 'on-fail + exit≠0 通知')
    assert.ok(handle.calls.followup[0].content[0].text.includes('已结束（exit code 5）'))
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('notify: 无 agents 服务 → 静默不抛错（toast 兜底）', async () => {
  setSchtasksRunner(makeFakeRunner([]))
  const workdir = await makeWorkdir()
  const { ctx, tools, intervals } = makeCtx({ services: {} }) // 无 agents
  const dispose = apply(ctx)
  try {
    const submit = tools.find((t) => t.name === 'bgjob_submit')
    const exec = { agent: { session: { id: 's1' } } }
    const tick = intervals.find((i) => i.ms === 1000).fn
    const jobDir = await submitAndFinish(submit, { name: 't', command: 'echo x', workdir, notify: 'on-exit' }, exec, workdir, 0, tick)
    const meta = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(meta.status, 'done', '通知尽力而为，不得破坏完成迁移')
  } finally {
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
})


test('notify: 重启恢复已通知（notifiedAt）的 done 任务 → 不重复通知', async () => {
  const home = await makeDshHome()
  try {
    setSchtasksRunner(makeFakeRunner([]))
    const handle = agentHandle('s1', 'idle')
    const workdir = await makeWorkdir()
    const jobId = 'bg-notified'
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    await fsp.mkdir(jobDir, { recursive: true })
    const notifiedAt = Date.now()
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
      id: jobId, name: 'n', workdir, jobDir,
      logPath: jobDir + '\\stdout.log', exitcodePath: jobDir + '\\exitcode.txt',
      jsonPath: jobDir + '\\job.json', taskName: 'dsh-bgj-n', command: 'echo x',
      status: 'done', exitCode: 0, finishedAt: notifiedAt, notifiedAt, createdAt: notifiedAt - 1000,
      notify: 'on-exit', createdBySession: 's1',
    }), 'utf8')
    await writeBgjobsIndex({ version: 1, updatedAt: Date.now(), jobs: [{ id: jobId, jobDir, workdir, name: 'n', createdAt: notifiedAt - 1000 }] }, home)
    const { ctx, intervals } = makeCtx({ services: { agents: { get: () => handle } } })
    const dispose = apply(ctx)
    const tick = intervals.find((i) => i.ms === 1000).fn
    await tick()
    assert.equal(handle.calls.followup.length, 0, '已通知任务重启后不得重复通知')
    assert.equal(handle.calls.inject.length, 0)
    dispose()
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
  } finally {
    delete process.env.DSH_HOME
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── bgjob_wait（v0.1.51）：等任务结束立即返回 ──

