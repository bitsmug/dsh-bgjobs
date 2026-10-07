// bgjobs tests —— B1：pid 探针的**实机**可用性（真起 Windows PowerShell 5.1 查真实进程）。
// 为什么要单独一个文件：本文件的用例必须用**生产 runner**（不能被 setSchtasksRunner 换掉），
// 而 node --test 每个测试文件跑在独立子进程里 ⇒ 这里天然拿到未被替换的默认实现。
// 动机是一次实机验收抓到的真回归：探针脚本曾把 if/else 用 `; ` 拼成 `}; else {`，PowerShell 把
// `else` 当命令 ⇒ 脚本 exit 1、零输出 ⇒ probeProcess 永远 unknown，**pid 复用防护静默失效**。
// 单测（注入 fake runner 回放标记）抓不到这类"脚本本身跑不起来"的错，故留这个实机哨兵。
// 反查（缺口 B）同理：注入 fake runner 的用例回放的是**解析层**，脚本能不能跑通、会不会把自己
// 也当成任务根、后代的父链能不能真的展开 —— 只有真跑才知道（2026-10-07 实机抓到"查询进程自命中"）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { probeProcess, listJobProcesses, killProcessTree } from '../lib/index.js'

/** 起一个带独特命令行标记的真实子进程（node 的额外 argv 会原样出现在 CommandLine 里）。 */
function spawnMarked(needle) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', needle], { windowsHide: true })
  return child
}

/** 起一个"带 needle 的根"真实进程，它再起一个**命令行不含 needle 的后代**（真实父子链）。 */
function spawnRootWithChild(needle) {
  const script = 'const {spawn}=require("child_process");'
    + 'spawn("ping",["-n","30","127.0.0.1"],{stdio:"ignore",windowsHide:true});'
    + 'setTimeout(()=>{},30000)'
  return spawn(process.execPath, ['-e', script, needle], { windowsHide: true })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('probeProcess(实机): 真实存在的进程 ⇒ state=alive（回归：}; else { 会让它永远 unknown）', async () => {
  const probe = await probeProcess(process.pid, [], process.cwd())
  assert.equal(probe.state, 'alive', '探针必须能识别真实存在的进程；unknown 说明探针脚本没跑起来')
})

test('probeProcess(实机): 归属核验按命令行 needle 判定（命中 ⇒ owned、不命中 ⇒ 不 owned）', async () => {
  const needle = 'bgjobs-probe-needle-' + process.pid
  const child = spawnMarked(needle)
  try {
    const hit = await probeProcess(child.pid, [needle], process.cwd())
    assert.equal(hit.state, 'alive')
    assert.equal(hit.owned, true, 'needle 命中子进程命令行 ⇒ owned（据此才允许 taskkill）')
    const miss = await probeProcess(child.pid, ['C:\\definitely-not-in-this-cmdline-bgjobs'], process.cwd())
    assert.equal(miss.state, 'alive')
    assert.equal(miss.owned, false, 'needle 不命中 ⇒ owned=false（pid 复用防护据此拒杀）')
  } finally {
    child.kill()
  }
})

test('probeProcess(实机): 不存在的 pid ⇒ state=gone（不是 unknown）', async () => {
  const probe = await probeProcess(999999999, [], process.cwd())
  assert.equal(probe.state, 'gone')
})

// ── 反查（缺口 B）的实机哨兵 ─────────────────────────────────────────────

test('listJobProcesses(实机): 查询进程自命中必须被排除（脚本正文里就含 needle）+ 带 marker 的巡检进程也排除', async () => {
  const needle = 'bgjobs-selfneedle-' + process.pid + '-' + Date.now()
  // 诱饵：命令行里同时带 needle 与查询 marker（模拟"另一个正在跑巡检的进程"）
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'BGJOBS-PROC', needle], { windowsHide: true })
  try {
    const found = await listJobProcesses([needle], process.cwd())
    assert.equal(found.error, undefined, '反查必须真的跑起来（error 说明脚本没跑通）')
    assert.deepEqual(found.entries.map((entry) => entry.pid), [],
      '查询进程自己（正文含 needle ⇒ 必然自命中）与带 marker 的诱饵都不得进入结果；实际: '
        + JSON.stringify(found.entries.map((entry) => ({ pid: entry.pid, matched: entry.matched, cmdline: entry.cmdline }))))
  } finally {
    decoy.kill()
  }
})

test('listJobProcesses(实机): 后代命令行不含 needle 也按父链展开（复现"后代不含 jobDir"的真实情形）', async () => {
  const needle = 'bgjobs-descneedle-' + process.pid + '-' + Date.now()
  const child = spawnRootWithChild(needle)
  try {
    let found = { entries: [] }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250)
      found = await listJobProcesses([needle], process.cwd())
      if (found.entries.some((entry) => !entry.matched)) break
    }
    assert.equal(found.error, undefined, '反查必须真的跑起来')
    const matched = found.entries.filter((entry) => entry.matched)
    const descendants = found.entries.filter((entry) => !entry.matched)
    assert.ok(matched.some((entry) => entry.pid === child.pid),
      '带 needle 的根必须命中；实际: ' + JSON.stringify(matched.map((entry) => entry.pid)))
    const hidden = descendants.find((entry) => entry.cmdline.toLowerCase().includes('ping'))
    assert.ok(hidden !== undefined,
      '命令行不含 needle 的后代（ping）必须靠父链展开拿到（漏了它就等于 ping 变孤儿继续跑）；实际: '
        + JSON.stringify(descendants.map((entry) => entry.cmdline)))
    assert.ok(!hidden.cmdline.toLowerCase().includes(needle.toLowerCase()), '本用例前提：该后代命令行确实不含 needle')
    // 父链必须真的连到 matched 根（否则"后代"只是碰巧同批返回的无关进程）
    const byPid = new Map(found.entries.map((entry) => [entry.pid, entry]))
    let cursor = hidden
    let linked = false
    for (let hop = 0; hop < 8 && cursor !== undefined; hop += 1) {
      cursor = byPid.get(cursor.ppid)
      if (cursor !== undefined && cursor.matched) { linked = true; break }
    }
    assert.equal(linked, true, '后代必须能沿 ParentProcessId 追到 matched 根')
  } finally {
    // 用插件自己的树杀清理本用例起的真实进程（不是 hand-made taskkill）
    await killProcessTree(child.pid, process.cwd()).catch(() => {})
  }
})
