// bgjobs tests —— 工具注册契约与 guidance（v0.1.61 自 tests/index.test.js 拆分）。
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

test('apply: 注册九个工具，output 结构合法', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  assert.equal(tools.length, 9)
  for (const tool of tools) {
    assert.ok(tool.output, `${tool.name} 必须声明 output`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.deepEqual(tools.map((t) => t.name).sort(), ['bgjob_list', 'bgjob_mcp_tools', 'bgjob_pending_list', 'bgjob_status', 'bgjob_submit', 'bgjob_submit_mcp', 'bgjob_submit_pwsh', 'bgjob_wait', 'bgjob_wait_all'])
  dispose()
})


test('apply: presentCall 返回 generic 卡片', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  const submit = tools.find((t) => t.name === 'bgjob_submit')
  assert.deepEqual(submit.presentCall({ name: 'sim' }), {
    card: 'generic', title: '提交后台任务', kind: 'execute', rawInput: 'sim',
  })
  dispose()
})


test('guidance: buildBgjobsGuidance 提及各工具与关键注意事项', () => {
  const text = buildBgjobsGuidance()
  assert.ok(text.includes('bgjob_submit'))
  assert.ok(text.includes('bgjob_submit_pwsh'))
  assert.ok(text.includes('bgjob_status'))
  assert.ok(text.includes('bgjob_wait'))
  assert.ok(text.includes('bgjob_wait_all'))
  assert.ok(text.includes('bgjob_list'))
  assert.ok(text.includes('bgjob_pending_list'))
  assert.ok(text.includes('bat 语法'))
  assert.ok(text.includes('PowerShell'))
  assert.ok(text.includes('workdir'))
  assert.ok(text.includes('Toast'))
  // v0.1.82：禁阻塞式等待 / 让路机制 / wait_all 合取语义 / 补齐 MCP 两工具
  assert.ok(text.includes('sleep'), 'guidance 应明确禁止系统 sleep 等待')
  assert.ok(text.includes('stoppedBy'), 'guidance 应说明让路（stoppedBy message）的行为')
  assert.ok(text.includes('bgjob_submit_mcp'))
  assert.ok(text.includes('bgjob_mcp_tools'))
  assert.ok(text.includes('allDone') && text.includes('failed'), 'guidance 应写明 wait_all 的合取语义 + 失败短路')
})


test('guidance: bgjob_wait / bgjob_wait_all 工具描述含禁 sleep 与让路说明（防与 guidance 漂移）', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  for (const name of ['bgjob_wait', 'bgjob_wait_all']) {
    const t = tools.find((x) => x.name === name)
    assert.ok(t, name + ' 应已注册')
    assert.ok(t.description.includes('sleep'), name + ' 描述应禁止前台 sleep')
    assert.ok(t.description.includes('stoppedBy'), name + ' 描述应说明让路行为')
  }
  const waitAll = tools.find((x) => x.name === 'bgjob_wait_all')
  assert.ok(waitAll.description.includes('failed'), 'bgjob_wait_all 描述应写明失败短路')
  assert.ok(waitAll.output.schema.properties.failed, 'bgjob_wait_all 输出 schema 应含 failed')
  assert.ok(waitAll.output.schema.properties.failedJobId, 'bgjob_wait_all 输出 schema 应含 failedJobId')
  assert.ok(waitAll.output.schema.properties.pending, 'bgjob_wait_all 输出 schema 应含 pending')
  dispose()
})


test('guidance: apply 注册 tool:bgjobs system prompt section', () => {
  const { ctx, sections } = makeCtx()
  const dispose = apply(ctx)
  const sec = sections.find((s) => s.name === 'tool:bgjobs')
  assert.ok(sec, 'apply 应注册 tool:bgjobs section')
  assert.equal(sec.order, 150)
  assert.ok(sec.text.includes('bgjob_submit'))
  assert.ok(sec.text.includes('bgjob_submit_pwsh'))
  dispose()
})

// ── 提交路径 ──

