// v0.3.1：沙箱后端门控（sandbox-backends.json）默认开 —— 契约测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'

const prevHome = process.env.DSH_HOME
const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-gate-'))
process.env.DSH_HOME = tmpHome

const { createStore } = await import('../lib/core/store.js')

const gatePath = () => path.join(tmpHome, 'bgjobs', 'sandbox-backends.json')

test('门控：sandbox-backends.json 不存在 ⇒ 默认开（v0.3.1）', async () => {
  await fsp.rm(gatePath(), { force: true })
  const store = createStore()
  assert.equal(await store.readSandboxBackends(), true, '无文件应默认开（dsh 为默认后端）')
})

test('门控：{enabled:false} ⇒ 关（可显式退回 ACL）', async () => {
  await fsp.mkdir(path.dirname(gatePath()), { recursive: true })
  await fsp.writeFile(gatePath(), JSON.stringify({ enabled: false }), 'utf8')
  const store = createStore()
  assert.equal(await store.readSandboxBackends(), false, '显式 false 应生效')
})

test('门控：{enabled:true} ⇒ 开', async () => {
  await fsp.writeFile(gatePath(), JSON.stringify({ enabled: true }), 'utf8')
  const store = createStore()
  assert.equal(await store.readSandboxBackends(), true)
})

test('门控：无需重启即生效（不做进程内缓存）', async () => {
  const store = createStore()
  await fsp.writeFile(gatePath(), JSON.stringify({ enabled: false }), 'utf8')
  assert.equal(await store.readSandboxBackends(), false, '写文件后应立即读到 false')
  await fsp.writeFile(gatePath(), JSON.stringify({ enabled: true }), 'utf8')
  assert.equal(await store.readSandboxBackends(), true, '写文件后应立即读到 true')
})

test('写开关：setSandboxBackends(false) 真正落盘并可读回', async () => {
  await fsp.rm(gatePath(), { force: true })
  const store = createStore()
  assert.deepEqual(await store.setSandboxBackends(false), { ok: true, enabled: false })
  assert.equal(await store.readSandboxBackends(), false, '写 false 后应读回 false（回归：曾引用未声明变量导致写盘被吞）')
})

test('写开关：setSandboxBackends(true) 真正落盘并可读回', async () => {
  const store = createStore()
  assert.deepEqual(await store.setSandboxBackends(true), { ok: true, enabled: true })
  assert.equal(await store.readSandboxBackends(), true)
})

test.after(async () => {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})
