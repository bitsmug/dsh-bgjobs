// bgjobs tests —— 面板作用域三态（spec-session-scope.md）：纯函数 + 客户端偏好 store。
// scope.js 不 require react，可直接加载；gui-prefs.js 会 require('react')，缺失时跳过该组用例。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  SCOPE_MODES, DEFAULT_SCOPE, normalizeScope, normalizePath,
  readActiveScopeTarget, effectiveScope, selectVisibleJobs,
} = require('../lib/client-src/scope.js')

let guiPrefs = null
try { guiPrefs = require('../lib/client-src/gui-prefs.js') } catch (e) { /* react 不可用：跳过 */ }

/** 假 sessions 服务：byId 里 retainedBy.mainView > 0 的那条视为活动会话。 */
const fakeSessions = (rows, opts) => ({
  list: {
    getSnapshot: () => {
      if (opts && opts.throwOnSnapshot) throw new Error('boom')
      return { ids: rows.map((r) => r.id), byId: Object.fromEntries(rows.map((r) => [r.id, r])), phase: 'ready', projectionsBySession: {} }
    },
  },
})

const job = (id, workdir, createdBySession) => ({ id, workdir, createdBySession })

test('scope: 常量与归一化', () => {
  assert.deepEqual(SCOPE_MODES, ['session', 'workspace', 'all'])
  assert.equal(DEFAULT_SCOPE, 'session')
  assert.equal(normalizeScope('all'), 'all')
  assert.equal(normalizeScope('bogus'), 'session', '非法值回落 session')
  assert.equal(normalizeScope(undefined), 'session')
  assert.equal(normalizeScope(null), 'session')
})

test('scope: normalizePath 统一斜杠/尾斜杠/大小写', () => {
  assert.equal(normalizePath('X:/work/Proj/'), 'x:\\work\\proj')
  assert.equal(normalizePath('X:\\work\\Proj\\\\'), 'x:\\work\\proj')
  assert.equal(normalizePath(''), '')
  assert.equal(normalizePath(undefined), '')
})

test('scope: effectiveScope 控件隐藏即不过滤，非法值回落缺省', () => {
  assert.equal(effectiveScope({ scope: 'workspace', onlySessionVisible: false }), 'all')
  assert.equal(effectiveScope({ scope: 'workspace', onlySessionVisible: true }), 'workspace')
  assert.equal(effectiveScope({ scope: 'nope' }), 'session')
  assert.equal(effectiveScope({}), 'session')
})

test('scope: session 只保留本会话与未知来源', () => {
  const jobs = [job('a', 'X:\\w', 's1'), job('b', 'X:\\w', 's2'), job('c', 'X:\\w', '')]
  const r = selectVisibleJobs({ jobs, scope: 'session', activeSessionId: 's1', activeCwd: 'X:\\w' })
  assert.deepEqual(r.jobs.map((j) => j.id), ['a', 'c'], '别的会话被过滤，未知来源保留')
  assert.equal(r.effectiveMode, 'session')
})

test('scope: session 无会话 id ⇒ 降级 workspace；两者都无 ⇒ all', () => {
  const jobs = [job('a', 'X:\\w\\sub', 's1'), job('b', 'X:\\other', 's2')]
  let r = selectVisibleJobs({ jobs, scope: 'session', activeCwd: 'X:\\w' })
  assert.deepEqual(r.jobs.map((j) => j.id), ['a'], '按工作区前缀过滤')
  assert.equal(r.effectiveMode, 'workspace')
  r = selectVisibleJobs({ jobs, scope: 'session' })
  assert.deepEqual(r.jobs.map((j) => j.id), ['a', 'b'], '无任何前置数据 ⇒ 不过滤')
  assert.equal(r.effectiveMode, 'all')
})

test('scope: workspace 含子目录、大小写/斜杠归一、路径边界', () => {
  const jobs = [
    job('exact', 'X:\\Dev', 's1'),
    job('sub', 'x:/dev/app/src', 's2'),
    job('sibling', 'X:\\Dev2', 's3'),
    job('outside', 'X:\\Other', 's4'),
  ]
  const r = selectVisibleJobs({ jobs, scope: 'workspace', activeCwd: 'x:\\dev\\' })
  assert.deepEqual(r.jobs.map((j) => j.id), ['exact', 'sub'], 'dev 不误匹配 dev2')
  assert.equal(r.effectiveMode, 'workspace')
})

test('scope: workspace 无工作区路径 ⇒ all；all 恒不过滤', () => {
  const jobs = [job('a', 'X:\\w', 's1'), job('b', 'X:\\x', 's2')]
  let r = selectVisibleJobs({ jobs, scope: 'workspace' })
  assert.equal(r.effectiveMode, 'all')
  assert.equal(r.jobs.length, 2)
  r = selectVisibleJobs({ jobs, scope: 'all', activeSessionId: 's1', activeCwd: 'X:\\w' })
  assert.equal(r.effectiveMode, 'all')
  assert.equal(r.jobs.length, 2)
})

test('scope: 控件隐藏时三态一律不过滤', () => {
  const jobs = [job('a', 'X:\\w', 's1'), job('b', 'X:\\x', 's2')]
  for (const scope of SCOPE_MODES) {
    const r = selectVisibleJobs({ jobs, scope, onlySessionVisible: false, activeSessionId: 's1', activeCwd: 'X:\\w' })
    assert.equal(r.effectiveMode, 'all', scope + ' 隐藏时不生效')
    assert.equal(r.jobs.length, 2)
  }
})

test('scope: 兼容 0.2.2-rc.1 ~ rc.3 的 SessionListState 形状', () => {
  // 三个 RC 的 sessions 客户端契约一致（SessionListState 只有 ids/byId/phase/projectionsBySession；
  // retainedBy 是 null 原型对象；summary 带 displayTitle/cwd）。这里按真实形状构造并冻结。
  const retainedBy = Object.assign(Object.create(null), { mainView: 1 })
  const summary = Object.freeze({
    id: 'session-rc', cwd: 'X:\\Work\\Repo', displayTitle: '当前会话',
    retainedBy: Object.freeze(retainedBy), blank: false,
  })
  const state = Object.freeze({
    ids: Object.freeze(['session-rc', 'other']),
    byId: Object.freeze({
      'session-rc': summary,
      other: Object.freeze({ id: 'other', displayTitle: '别的会话', retainedBy: Object.freeze(Object.assign(Object.create(null), { history: 2 })) }),
    }),
    phase: 'ready',
    projectionsBySession: Object.freeze({}),
  })
  const sessions = { list: { getSnapshot: () => state, subscribe: () => () => {} } }
  assert.deepEqual(readActiveScopeTarget(sessions), { id: 'session-rc', cwd: 'X:\\Work\\Repo', label: '当前会话' })
  const r = selectVisibleJobs({
    jobs: [job('mine', 'X:\\Work\\Repo', 'session-rc'), job('theirs', 'X:\\Work\\Repo', 'other')],
    scope: 'session', activeSessionId: readActiveScopeTarget(sessions).id, activeCwd: readActiveScopeTarget(sessions).cwd,
  })
  assert.deepEqual(r.jobs.map((j) => j.id), ['mine'])
})

test('scope: retainedBy 缺失/全 0/坏快照一律降级，不抛错', () => {
  // 没有 mainView 占用（欢迎页 / 面板预览）⇒ 无活动会话
  assert.equal(readActiveScopeTarget(fakeSessions([{ id: 's1', cwd: 'X:\\w' }])).id, undefined)
  assert.equal(readActiveScopeTarget(fakeSessions([{ id: 's1', retainedBy: { history: 3 } }])).id, undefined)
  assert.equal(readActiveScopeTarget(fakeSessions([{ id: 's1', retainedBy: { mainView: 0 } }])).id, undefined)
  // getSnapshot 返回 null / 非对象 / byId 非对象 ⇒ 全 undefined
  assert.deepEqual(readActiveScopeTarget({ list: { getSnapshot: () => null } }).id, undefined)
  assert.deepEqual(readActiveScopeTarget({ list: { getSnapshot: () => ({ byId: null }) } }).id, undefined)
  assert.deepEqual(readActiveScopeTarget({ list: {} }).id, undefined)
  // 坏 sessions 对象（getSnapshot 不是函数）⇒ 不抛错
  assert.deepEqual(readActiveScopeTarget({ list: { getSnapshot: 42 } }).id, undefined)
})

test('scope: readActiveScopeTarget 优先 retainedBy.mainView，0.1.x 回退 current', () => {
  let r = readActiveScopeTarget(fakeSessions([
    { id: 's1', cwd: 'X:\\w1', displayTitle: '项目一', retainedBy: { mainView: 0 } },
    { id: 's2', cwd: 'X:\\w2', displayTitle: '项目二', retainedBy: { mainView: 1 } },
  ]))
  assert.deepEqual(r, { id: 's2', cwd: 'X:\\w2', label: '项目二' })
  // 0.2.x 有 retainedBy 时以 mainView 为准，即使列表里残留 current 也以它优先
  const both = {
    list: {
      getSnapshot: () => ({
        current: 's1',
        byId: {
          s1: { id: 's1', cwd: 'X:\\w1' },
          s2: { id: 's2', cwd: 'X:\\w2', retainedBy: { mainView: 1 } },
        },
      }),
    },
  }
  assert.equal(readActiveScopeTarget(both).id, 's2', '0.2.x 优先 retainedBy.mainView')
  // 0.1.x（无 retainedBy）回退 current —— issue #2 只发生在"只剩 current"被删的 0.2.x
  const legacy = {
    list: {
      getSnapshot: () => ({ current: 's1', byId: { s1: { id: 's1', cwd: 'X:\\w1' } } }),
    },
  }
  assert.equal(readActiveScopeTarget(legacy).id, 's1', '0.1.x 回退 current')
  // current 指向已不存在的会话 ⇒ 取不到（不抛错）
  assert.equal(readActiveScopeTarget({
    list: { getSnapshot: () => ({ current: 'gone', byId: { s1: { id: 's1' } } }) },
  }).id, undefined)
  // displayTitle 缺失 ⇒ id 前 8 位
  r = readActiveScopeTarget(fakeSessions([{ id: 'abcdefghijkl', retainedBy: { mainView: 2 } }]))
  assert.equal(r.label, 'abcdefgh')
  // 服务缺失 / 抛异常 ⇒ 全 undefined（不报错）
  assert.deepEqual(readActiveScopeTarget(undefined), { id: undefined, cwd: undefined, label: undefined })
  assert.deepEqual(readActiveScopeTarget(fakeSessions([], { throwOnSnapshot: true })).id, undefined)
})

test('gui-prefs: 宿主回显 scope 生效（loadGuiPrefs 走 /bgjobs/uiprefs）', { skip: !guiPrefs }, async () => {
  const store = guiPrefs.createGuiPrefsStore()
  assert.equal(store.getScope(), 'session', '缺省 session')
  const origFetch = global.fetch
  const respond = (body) => { global.fetch = () => Promise.resolve({ json: () => Promise.resolve(body) }) }
  // loadGuiPrefs 是「发起请求后返回」，等一轮宏任务让 .then 链跑完。
  const flush = () => new Promise((r) => setImmediate(r))
  try {
    respond({ scope: 'workspace' })
    guiPrefs.loadGuiPrefs(store)
    await flush()
    assert.equal(store.getScope(), 'workspace', '宿主回显生效')
    respond({ scope: 'bogus' })
    guiPrefs.loadGuiPrefs(store)
    await flush()
    assert.equal(store.getScope(), 'session', '非法回显回落 session')
    respond({})
    guiPrefs.loadGuiPrefs(store)
    await flush()
    assert.equal(store.getScope(), 'session', '回显无 scope 时保持现值')
    store.applyScope('all')
    assert.equal(store.getScope(), 'all')
  } finally {
    global.fetch = origFetch
  }
})
