// bgjobs tests —— Web 面板侧的 `unknown` 门槛（用户裁定 2026-10-08「③ 面板确认即 force」）。
//
// 被测对象 lib/client-src/panel.js **要 require react**（bundle 期才有的依赖）⇒ node:test 里
// 不能 require 它（同 tests/open-settings.test.js 的既有模式）⇒ 本文件用**源码接线守卫**：
// 读 panel.js 源码，断言"该分支 / 该请求参数确实存在、且只在该处存在"；宿主侧 `?force=1` 的
// **真实往返**由 tests/kill-tree.test.js 的真 http 用例负责（沿用既有分工）。
//
// 覆盖（对应裁定 ③ 的四个要求）：
// ① i18n 中英双改：force.ask.* / del.failed* 双字典齐备、互不相同、逐字锁定（缺键会跨语言回退 ⇒ 抓得到）
// ② i18n 键集一致（唯一已知例外 log.loading —— EN 侧既有缺口，未补齐，不在裁定 ③ 范围）
// ③ 请求形态：force **只在用户确认后**出现（全文件唯一一处 '&force=1'；唯一 true 调用点在 confirmForce）
// ④ 门只对 unknown 开：只认 host 的 needsForce 标记；面板不新增 kill 入口；「只有 done 可拖」原样保留
// ⑤ 未确认不发请求：取消 = setForceAsk(null)（不碰任何请求）；确认 = confirmForce；两条渲染分支都在
// ⑥ needsForce 的文案在面板**看得见**：对话框原样渲染 host 的 error + warnings，另有失败 toast 兜底
//
// 判据一律「单引号 + 非子串（计数/全等，不用 includes 断言）+ 打印期望值」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { ZH, EN, makeT } = require('../lib/client-src/i18n.js')
// panel.js 需 react ⇒ 只读源码（接线守卫），不 require 它。
const PANEL_SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client-src', 'panel.js'), 'utf8')

/** 命中共 n 次（正则全文扫描；n 与期望值一起打印）。 */
const matches = (re) => PANEL_SRC.match(re) || []

const FORCE_KEYS = [
  'force.ask.title', 'force.ask.one', 'force.ask.many', 'force.ask.hint',
  'force.ask.confirm', 'force.ask.confirm.title', 'force.ask.cancel', 'force.ask.cancel.title',
  'del.failed', 'del.failed.unknown',
]

// ── ① 新文案：中英双字典齐备（渲染值逐字锁定）─────────────────────────────────

test('① i18n：force.ask.* / del.failed* 中英双字典齐备、互不相同、渲染文本逐字锁定', () => {
  const missingZh = FORCE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(ZH, key))
  const missingEn = FORCE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(EN, key))
  console.log('  期望新增键数:', FORCE_KEYS.length, '；期望 zh 缺失 = [] 实际 =', JSON.stringify(missingZh))
  console.log('  期望 en 缺失 = [] 实际 =', JSON.stringify(missingEn))
  assert.deepEqual(missingZh, [])
  assert.deepEqual(missingEn, [])
  // 中英必须是两条不同文案（防复制粘贴只改一边 / 漏译）。
  const identical = FORCE_KEYS.filter((key) => ZH[key] === EN[key])
  console.log('  期望「中英雷同」键 = [] 实际 =', JSON.stringify(identical))
  assert.deepEqual(identical, [])
  // 逐字锁定：确认框标题（面板上第一眼看到的那句）+ 「确认清理」的 tooltip 口径。
  const expectedZhTitle = '无法判定该任务的进程状态'
  const expectedEnTitle = 'Cannot determine the process state'
  console.log('  期望 zh[force.ask.title] =', expectedZhTitle, '实际 =', makeT('zh')('force.ask.title'))
  console.log('  期望 en[force.ask.title] =', expectedEnTitle, '实际 =', makeT('en')('force.ask.title'))
  assert.equal(makeT('zh')('force.ask.title'), expectedZhTitle)
  assert.equal(makeT('en')('force.ask.title'), expectedEnTitle)
  // {name}/{id}/{count} 三个占位符必须真被替换（漏了就是面板上露出 {name}）——整串全等。
  const expectedOneZh = '任务「演示任务」（bg-x）的进程探针/反查本身跑不起来：既不能确认它还在跑、也不能确认它已经停了。'
  const actualOneZh = makeT('zh')('force.ask.one', { name: '演示任务', id: 'bg-x' })
  console.log('  期望 zh[force.ask.one] 渲染 =', expectedOneZh)
  console.log('  实际 zh[force.ask.one] 渲染 =', actualOneZh)
  assert.equal(actualOneZh, expectedOneZh)
  const expectedManyEn = 'The process probe/lookup failed for 3 jobs: it is impossible to tell whether they are still running or already gone.'
  const actualManyEn = makeT('en')('force.ask.many', { count: '3' })
  console.log('  期望 en[force.ask.many] 渲染 =', expectedManyEn)
  console.log('  实际 en[force.ask.many] 渲染 =', actualManyEn)
  assert.equal(actualManyEn, expectedManyEn)
  // 失败 toast 的模板（面板新暴露的错误通道）。
  const failedZh = makeT('zh')('del.failed', { error: 'E' })
  console.log('  期望 zh[del.failed] = 删除失败：E 实际 =', failedZh)
  assert.equal(failedZh, '删除失败：E')
})

// ── ② 中英键集一致（唯一已知例外：EN 缺 log.loading，既有缺口、未补齐）──────────

test('② i18n：中英字典键集一致（唯一已知例外 EN 缺 log.loading，既有缺口本轮未动）', () => {
  const KNOWN_GAP = ['log.loading']
  const zhOnly = Object.keys(ZH).filter((key) => !Object.prototype.hasOwnProperty.call(EN, key))
  const enOnly = Object.keys(EN).filter((key) => !Object.prototype.hasOwnProperty.call(ZH, key))
  console.log('  期望 zh-only =', JSON.stringify(KNOWN_GAP), '实际 =', JSON.stringify(zhOnly))
  console.log('  期望 en-only = [] 实际 =', JSON.stringify(enOnly))
  assert.deepEqual(zhOnly, KNOWN_GAP)
  assert.deepEqual(enOnly, [])
})

// ── ③ 请求形态：force 只在用户确认后出现 ─────────────────────────────────────

test('③ panel.js 接线：全文件唯一一处 force 分支，且唯一的 true 调用点在 confirmForce', () => {
  const forceLiteral = matches(/'&force=1'/g).length
  console.log('  期望 \'&force=1\' 字面量出现 1 次（只此一条带 force 的请求路径）；实际 =', forceLiteral)
  assert.equal(forceLiteral, 1)
  // 删除请求的 URL 拼接只应有一处（requestDelete）——两处就会绕开 withForce 闸门。
  const deleteUrls = matches(/\/bgjobs\/delete\?id=/g).length
  console.log('  期望 \'/bgjobs/delete?id=\' 拼接出现 1 次（唯一入口 requestDelete）；实际 =', deleteUrls)
  assert.equal(deleteUrls, 1)
  // 三个调用点：两条**尝试**路径一律 false，唯一 true 在 confirmForce。
  const callSites = matches(/requestDelete\([a-zA-Z.]+,\s*(true|false)\)/g)
  const expectedCallSites = ['requestDelete(id, false)', 'requestDelete(item.id, true)', 'requestDelete(j.id, false)']
  console.log('  期望调用点 =', JSON.stringify(expectedCallSites))
  console.log('  实际调用点 =', JSON.stringify(callSites))
  assert.deepEqual(callSites, expectedCallSites)
  // true 那次必须落在 confirmForce 的函数体内（用户点了「确认清理」才会走到）。
  const confirmBody = matches(/const confirmForce = async \(\) => \{[\s\S]*?\n {6}\}/g)
  console.log('  期望 confirmForce 函数体命中 1 段；实际 =', confirmBody.length)
  assert.equal(confirmBody.length, 1)
  const forceInsideConfirm = (confirmBody[0].match(/requestDelete\(item\.id, true\)/g) || []).length
  console.log('  期望 force 调用在 confirmForce 内出现 1 次；实际 =', forceInsideConfirm)
  assert.equal(forceInsideConfirm, 1)
})

// ── ④ 门只对 unknown 开（live / absent / 普通 done 一律不添确认、参数不变）──────

test('④ panel.js 接线：门槛只认 host 的 needsForce 标记；面板不新增 kill 入口；只有 done 可拖', () => {
  const gates = matches(/r\.needsForce === true/g).length
  console.log('  期望「r.needsForce === true」判定 2 处（deleteJob + cleanupVisible）；实际 =', gates)
  assert.equal(gates, 2)
  // 不得出现"不看标记就带 force"的写法（例如按 status/error 猜）。
  const guessed = matches(/force[^\n]*status === 'unknown'/g).length + matches(/status === 'unknown'[^\n]*force/g).length
  console.log("  期望「按 status 猜 unknown 而带 force」= 0；实际 =", guessed)
  assert.equal(guessed, 0)
  // 面板没有 kill 路由（垃圾篓只有 delete）——live 语义（有活进程 ⇒ 请先 kill）一个字节没动。
  const killCalls = matches(/\/bgjobs\/kill/g).length
  console.log('  期望面板调用 \'/bgjobs/kill\' 次数 = 0（未新增 kill 入口）；实际 =', killCalls)
  assert.equal(killCalls, 0)
  // 回归钉子：拖拽删除的准入条件原样保留（只有 done 可拖）。
  const deletable = matches(/const deletable = \(job\) => trashOpen && job\.status === 'done'/g).length
  console.log("  期望「const deletable = (job) => trashOpen && job.status === 'done'」原样 1 处；实际 =", deletable)
  assert.equal(deletable, 1)
})

// ── ⑤ 未确认不发请求 ─────────────────────────────────────────────────────────

test('⑤ panel.js 接线：取消 = setForceAsk(null)（不发请求）；确认 = confirmForce；两条渲染分支都在', () => {
  const cancel = matches(/h\(MiniBtn, \{ title: t\('force\.ask\.cancel\.title'\), onClick: \(\) => setForceAsk\(null\) \}, '✕ ' \+ t\('force\.ask\.cancel'\)\)/g).length
  console.log('  期望取消按钮接线（onClick = setForceAsk(null)，不碰请求）1 处；实际 =', cancel)
  assert.equal(cancel, 1)
  const confirm = matches(/h\(MiniBtn, \{ title: t\('force\.ask\.confirm\.title'\), onClick: \(\) => confirmForce\(\) \}, '🗑 ' \+ t\('force\.ask\.confirm'\)\)/g).length
  console.log('  期望确认按钮接线（onClick = confirmForce()）1 处；实际 =', confirm)
  assert.equal(confirm, 1)
  // 折叠/最小化时也要能看到确认框 ⇒ 两条 return 各渲染一次。
  const rendered = matches(/renderForceAsk\(\),/g).length
  console.log('  期望 renderForceAsk() 在两条 return 分支各出现 1 次 = 2；实际 =', rendered)
  assert.equal(rendered, 2)
})

// ── ⑥ needsForce 的文案在面板看得见（此前整个被吞）──────────────────────────

test('⑥ panel.js 接线：host 的 error + warnings 原样进确认框，失败另有 toast 兜底', () => {
  const errorPart = matches(/if \(r && r\.error\) parts\.push\(String\(r\.error\)\)/g).length
  const warnPart = matches(/if \(r && Array\.isArray\(r\.warnings\)\) for \(const w of r\.warnings\) parts\.push\(String\(w\)\)/g).length
  console.log('  期望 failureText 同时拼 error / warnings：error 段 = 1 实际 =', errorPart, '；warnings 段 = 1 实际 =', warnPart)
  assert.equal(errorPart, 1)
  assert.equal(warnPart, 1)
  // unknown 被拦下时：host 原文交给确认框（单条 / 批量各一处）。
  const single = matches(/text: failureText\(r\), batch: false/g).length
  const batch = matches(/text: blockedTexts\.join\('\\n'\), batch: true/g).length
  console.log('  期望「host 原文进确认框」：单条 = 1 实际 =', single, '；批量 = 1 实际 =', batch)
  assert.equal(single, 1)
  assert.equal(batch, 1)
  // 确认框里必须真的渲染出那段原文（带锚点属性便于检索/回归）。
  const anchor = matches(/'data-bgjobs-forceask-src': true/g).length
  const rendered = matches(/String\(forceAsk\.text \|\| ''\)/g).length
  console.log('  期望确认框渲染 host 原文：锚点 = 1 实际 =', anchor, '；文本节点 = 1 实际 =', rendered)
  assert.equal(anchor, 1)
  assert.equal(rendered, 1)
  // 其余失败（含 live 拒绝）不再静默：toast 兜底 3 处（deleteJob / confirmForce / cleanupVisible）。
  const toasts = matches(/pushToast\(t\('del\.failed', \{ error: failureText\(r\) \}\)\)/g).length
  console.log('  期望失败 toast 接线 3 处（拖拽 / 确认后 / 批量）；实际 =', toasts)
  assert.equal(toasts, 3)
})
