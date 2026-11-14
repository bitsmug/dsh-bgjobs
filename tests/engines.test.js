import test from 'node:test'
import assert from 'node:assert/strict'
import { BgjobEngine, createEnginesService } from '../lib/core/engines.js'

const mkEngine = (id) => new BgjobEngine({ id, buildTr: () => '"x"' })

test('registerEngine disposer 注销引擎，卸载后可重新注册同一 id', () => {
  const svc = createEnginesService()
  const dispose = svc.registerEngine(mkEngine('mcp'))
  assert.deepEqual(svc.list().map((e) => e.id), ['mcp'])

  dispose()
  assert.equal(svc.get('mcp'), null)
  assert.equal(svc.list().length, 0)

  // 插件重载：同一 id 再注册不应撞 "already registered"
  const dispose2 = svc.registerEngine(mkEngine('mcp'))
  assert.ok(svc.get('mcp'))
  dispose2()
})

test('注册期间同 id 仍 fail-fast 冲突', () => {
  const svc = createEnginesService()
  svc.registerEngine(mkEngine('mcp'))
  assert.throws(() => svc.registerEngine(mkEngine('mcp')), /already registered/)
})

test('旧 disposer 重复调用不误删后来重新注册的实例', () => {
  const svc = createEnginesService()
  const dispose = svc.registerEngine(mkEngine('mcp'))
  dispose()
  svc.registerEngine(mkEngine('mcp'))
  dispose()
  assert.ok(svc.get('mcp'))
})

test('buildMeta 收到含 jsonPath 的 baseMeta（jobs.js 传入的是完整 meta）', async () => {
  const { batEngine } = await import('../lib/engines/shell/index.js')
  const meta = await batEngine.buildMeta(null, { id: 'j1', jsonPath: 'X:\\w\\.dsh\\bgjobs\\j1\\job.json' })
  assert.equal(meta.engine, 'bat')
  assert.equal(meta.cmdPath, 'X:\\w\\.dsh\\bgjobs\\j1\\cmd.bat')
})
