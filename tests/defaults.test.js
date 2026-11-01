// tests/defaults.test.js —— B′ T1：分层默认（L1 config → L2 项目文件 → L3 会话 → L4 调用）
//
// 只测 lib/core/defaults.js 这个"唯一所有者"；不碰 tools/jobs。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PROJECT_FILE_REL,
  resolveDefaults,
  readProjectDefaults,
  setSessionGroups,
  getSessionGroups,
  resetSessionGroups,
  __resetCachesForTest,
} from '../lib/core/defaults.js'

const makeWorkspace = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgjobs-defaults-'))
  fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true })
  return dir
}

const writeProject = (dir, obj) => {
  fs.writeFileSync(path.join(dir, PROJECT_FILE_REL), JSON.stringify(obj), 'utf8')
}

test('L1 插件 config 提供默认值', () => {
  __resetCachesForTest()
  const r = resolveDefaults({ group: 'submit', config: { submit: { sandbox: 'workspace-write' } } })
  assert.deepEqual(r.values, { sandbox: 'workspace-write' })
  assert.deepEqual(r.warnings, [])
})

test('L2 项目文件覆盖 L1，且改完即生效（mtime 失效）', () => {
  __resetCachesForTest()
  const ws = makeWorkspace()
  writeProject(ws, { submit: { sandbox: 'read-only' } })
  const a = resolveDefaults({ group: 'submit', config: { submit: { sandbox: 'workspace-write' } }, workspace: ws })
  assert.equal(a.values.sandbox, 'read-only')
  // 改文件（内容长度不同 ⇒ size 也变，确保缓存失效）
  fs.writeFileSync(path.join(ws, PROJECT_FILE_REL), JSON.stringify({ submit: { sandbox: 'danger-full-access' } }), 'utf8')
  const b = resolveDefaults({ group: 'submit', config: { submit: { sandbox: 'workspace-write' } }, workspace: ws })
  assert.equal(b.values.sandbox, 'danger-full-access')
})

test('L3 会话层覆盖 L2，L4 调用参数覆盖 L3', () => {
  __resetCachesForTest()
  const ws = makeWorkspace()
  writeProject(ws, { submit: { sandbox: 'read-only', output_encoding: 'utf8' } })
  const sid = 'sess-a'
  setSessionGroups(sid, { submit: { sandbox: 'workspace-write', notify: 'on-completion' } })
  const r = resolveDefaults({
    group: 'submit',
    config: { submit: { notify: 'off' } },
    workspace: ws,
    sessionId: sid,
    call: { output_encoding: 'native' },
  })
  assert.equal(r.values.sandbox, 'workspace-write') // L3 > L2
  assert.equal(r.values.notify, 'on-completion') // L3 > L1
  assert.equal(r.values.output_encoding, 'native') // L4 > L2
})

test('output_encoding: 新缺省值 auto 同样经 L4 透传（白名单已含键；v0.3.2）', () => {
  __resetCachesForTest()
  const r = resolveDefaults({ group: 'submit', call: { output_encoding: 'auto' } })
  assert.equal(r.values.output_encoding, 'auto')
  assert.deepEqual(r.warnings, [])
})

test('null 表示显式删除该键', () => {
  __resetCachesForTest()
  const sid = 'sess-null'
  setSessionGroups(sid, { submit: { sandbox: 'read-only' } })
  assert.equal(resolveDefaults({ group: 'submit', sessionId: sid }).values.sandbox, 'read-only')
  setSessionGroups(sid, { submit: { sandbox: null } })
  assert.equal(resolveDefaults({ group: 'submit', sessionId: sid }).values.sandbox, undefined)
})

test('坏 JSON 只告警、不抛错，且不影响提交', () => {
  __resetCachesForTest()
  const ws = makeWorkspace()
  fs.writeFileSync(path.join(ws, PROJECT_FILE_REL), '{ not json', 'utf8')
  const r = resolveDefaults({ group: 'submit', workspace: ws, config: { submit: { engine: 'pwsh' } } })
  assert.equal(r.values.engine, 'pwsh') // L1 仍然生效
  assert.ok(r.warnings.some((w) => w.includes('解析失败')))
})

test('未知键 / 一次性参数 / 未知组 只告警被忽略', () => {
  __resetCachesForTest()
  const ws = makeWorkspace()
  writeProject(ws, {
    submit: { command: 'rm -rf /', workdir: 'C:\\x', notAKey: 1, sandbox: 'read-only' },
    nope: { a: 1 },
  })
  const r = resolveDefaults({ group: 'submit', workspace: ws })
  assert.deepEqual(r.values, { sandbox: 'read-only' })
  const joined = r.warnings.join(' | ')
  assert.ok(joined.includes('command') && joined.includes('默认层不接受'))
  assert.ok(joined.includes('workdir') && joined.includes('默认层不接受'))
  assert.ok(joined.includes('notAKey'))
  assert.ok(joined.includes('nope'))
})

test('项目文件不存在 ⇒ 安静返回空，无告警', () => {
  __resetCachesForTest()
  const ws = makeWorkspace()
  const p = readProjectDefaults(ws)
  assert.equal(p.exists, false)
  assert.deepEqual(p.warnings, [])
  assert.deepEqual(p.groups, { submit: {}, query: {}, control: {} })
})

test('会话层可读、可重置', () => {
  __resetCachesForTest()
  const sid = 'sess-b'
  setSessionGroups(sid, { control: { reason: 'from-session' } })
  assert.equal(getSessionGroups(sid).control.reason, 'from-session')
  resetSessionGroups(sid)
  assert.deepEqual(getSessionGroups(sid), { submit: {}, query: {}, control: {} })
})
