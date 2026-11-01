// 0.3 批次 3.1：全局配置文件唯一读写者（config.json）的契约测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'

const prevHome = process.env.DSH_HOME
const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-cfg-'))
process.env.DSH_HOME = tmpHome

const { readGlobalConfig, writeGlobalConfig, globalConfigPath } = await import('../lib/core/config-file.js')

test('config-file: 路径在 $DSH_HOME/bgjobs/config.json', () => {
  assert.equal(globalConfigPath(), path.join(tmpHome, 'bgjobs', 'config.json'))
})

test('config-file: 文件不存在 ⇒ ok:true + 空形状（不是错误）', async () => {
  const r = await readGlobalConfig()
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { submit: {}, query: {}, control: {}, ui: {} })
  assert.equal(r.mtimeMs, null)
})

test('config-file: 写入后可读回，且只保留四组', async () => {
  const w = await writeGlobalConfig({ submit: { notify: 'on-exit' }, ui: { waitTimeout: 60 }, bogus: { x: 1 } })
  assert.equal(w.ok, true, JSON.stringify(w))
  const r = await readGlobalConfig()
  assert.equal(r.ok, true)
  assert.equal(r.value.submit.notify, 'on-exit')
  assert.equal(r.value.ui.waitTimeout, 60)
  assert.equal(r.value.bogus, undefined, '未知组应被忽略')
})

test('config-file: 合并语义 —— 组内浅合并，null 删键', async () => {
  await writeGlobalConfig({ submit: { notify: 'on-exit', wait: 30 } })
  await writeGlobalConfig({ submit: { notify: null, wait: 45 } })
  const r = await readGlobalConfig()
  assert.equal(r.ok, true)
  assert.equal(r.value.submit.notify, undefined, 'null 应删键')
  assert.equal(r.value.submit.wait, 45)
})

test('config-file: 坏 JSON ⇒ ok:false 且不抛错', async () => {
  const p = globalConfigPath()
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, '{ bad json', 'utf8')
  const r = await readGlobalConfig()
  assert.equal(r.ok, false)
  assert.match(r.error, /不是合法 JSON/)
})

test('config-file: 顶层非对象 ⇒ ok:false', async () => {
  await fsp.writeFile(globalConfigPath(), '[1,2,3]', 'utf8')
  const r = await readGlobalConfig()
  assert.equal(r.ok, false)
  assert.match(r.error, /顶层必须是对象/)
})

test.after(async () => {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})
