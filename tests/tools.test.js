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

test('apply: 注册十一个工具，output 结构合法', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  assert.equal(tools.length, 11)
  for (const tool of tools) {
    assert.ok(tool.output, `${tool.name} 必须声明 output`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.deepEqual(tools.map((t) => t.name).sort(), ['bgjob_config', 'bgjob_delete', 'bgjob_kill', 'bgjob_list', 'bgjob_mcp_tools', 'bgjob_pending_list', 'bgjob_status', 'bgjob_submit', 'bgjob_submit_mcp', 'bgjob_submit_pwsh', 'bgjob_wait'])
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
  assert.ok(text.includes('logic'), 'guidance 应说明 bgjob_wait 的 logic 模式（any/all）')
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
  assert.ok(text.includes('allDone') && text.includes('failed'), 'guidance 应写明 logic=all 的合取语义 + 失败短路')
})


test('guidance: bgjob_wait 工具描述含禁 sleep、让路说明与 logic 两种模式（防与 guidance 漂移）', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  const t = tools.find((x) => x.name === 'bgjob_wait')
  assert.ok(t, 'bgjob_wait 应已注册')
  assert.ok(t.description.includes('sleep'), '描述应禁止前台 sleep')
  assert.ok(t.description.includes('stoppedBy'), '描述应说明让路行为')
  assert.ok(t.description.includes('failed') && t.description.includes('allDone'), '描述应写明 logic=all 的合取语义 + 失败短路')
  // v0.1.83：原 bgjob_wait_all 合并为 logic 参数
  const logic = t.parameters.properties.logic
  assert.ok(logic, 'bgjob_wait 参数应含 logic')
  assert.deepEqual(logic.enum, ['any', 'all'])
  assert.equal(logic.default, 'any', '缺省必须仍是 any')
  assert.ok(t.output.schema.properties.failed, '输出 schema 应含 failed')
  assert.ok(t.output.schema.properties.failedJobId, '输出 schema 应含 failedJobId')
  assert.ok(t.output.schema.properties.pending, '输出 schema 应含 pending')
  assert.ok(t.output.schema.properties.allDone, '输出 schema 应含 allDone')
  dispose()
})


test('tools: 超时参数缺省不限时、可传任意正数（v0.1.84 去掉 600 秒上限）', () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  const wait = tools.find((t) => t.name === 'bgjob_wait')
  assert.equal(wait.parameters.properties.timeoutSeconds.default, undefined, '缺省不再是 120（缺省 = 不限时）')
  assert.ok(!/1–600/.test(wait.parameters.properties.timeoutSeconds.description), 'wait 的 timeoutSeconds 不应再写 1–600')
  assert.ok(wait.parameters.properties.timeoutSeconds.description.includes('不限时'), 'wait 描述应写明缺省不限时')
  const mcpSubmit = tools.find((t) => t.name === 'bgjob_submit_mcp')
  assert.equal(mcpSubmit.parameters.properties.timeout_seconds.default, undefined, '缺省不再是 60（缺省 = 不限时）')
  assert.ok(!/1–600/.test(mcpSubmit.parameters.properties.timeout_seconds.description), 'timeout_seconds 不应再写 1–600')
  assert.ok(mcpSubmit.parameters.properties.timeout_seconds.description.includes('不限时'), 'timeout_seconds 描述应写明缺省不限时')
  for (const name of ['bgjob_submit', 'bgjob_submit_pwsh', 'bgjob_submit_mcp']) {
    const t = tools.find((x) => x.name === name)
    assert.ok(!/1–600/.test(t.parameters.properties.wait.description), name + ' 的 wait 不应再有 600 秒上限')
  }
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



test('bgjob_config: help 无 topic ⇒ 返回索引（自包含，列出各主题）', async () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  try {
    const t = tools.find((x) => x.name === 'bgjob_config')
    const r = await t.execute({ action: 'help' }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.topic, 'index')
    for (const k of ['submit', 'query', 'control', 'defaults', 'aliases']) assert.ok(r.help.includes(k), '索引应列出主题: ' + k)
    assert.ok(Array.isArray(r.topics) && r.topics.length >= 8, 'topics 应是主题名数组')
    assert.ok(!r.help.includes('docs/'), '帮助必须自包含，不得依赖 docs/ 路径')
  } finally { dispose() }
})


test('bgjob_config: help 指定 topic ⇒ 返回该主题全文（自包含）', async () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  try {
    const t = tools.find((x) => x.name === 'bgjob_config')
    const r = await t.execute({ action: 'help', topic: 'submit' }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.topic, 'submit')
    assert.ok(r.help.includes('engine'), 'submit 主题应讲 engine 判定')
    assert.ok(r.help.includes('示例'), 'submit 主题应给示例')
    assert.ok(!r.help.includes('docs/'), '主题全文也必须自包含')
  } finally { dispose() }
})


test('bgjob_config: help 未知 topic ⇒ 返回索引 + warnings', async () => {
  const { ctx, tools } = makeCtx()
  const dispose = apply(ctx)
  try {
    const t = tools.find((x) => x.name === 'bgjob_config')
    const r = await t.execute({ action: 'help', topic: 'no-such-topic' }, { agent: undefined })
    assert.equal(r.ok, true)
    assert.equal(r.topic, 'index')
    assert.ok(Array.isArray(r.warnings) && r.warnings.length > 0, '未知主题应给 warnings')
    assert.ok(r.help.includes('submit'), '未知主题仍应返回索引')
  } finally { dispose() }
})

