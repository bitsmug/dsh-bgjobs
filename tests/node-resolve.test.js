// bgjobs tests —— node 解释器解析：**同源优先**的优先级链 + PE/名守卫 + 版本落盘（v0.1.91）
//
// 场景：**只装桌面版 DSH、机器上没有独立安装 node**（PATH 上也没有）⇒ `where.exe node` 落空。
// 桌面版自带一个真 node（实机实测 v24.21.0、PE 子系统 3），必须靠同源层找到它。
//
// 解析优先级（v0.1.91 重排，逐层都在下面的用例里被钉住）：
//   ① basename 快路径（execPath 本身是 node/node.exe）
//   ② DSH_DESKTOP_NODE_EXECUTABLE
//   ③ <resourcesPath> 已知布局 + 限深扫描（桌面版自带）
//   ④ where.exe node —— **最后手段**，且命中结果同样要过「名 node.exe + PE = 3」校验
//   ⑤ 全落空 ⇒ fail-closed 返回 null，绝不退回 GUI 子系统的 execPath（issue #1 的假成功）
//
// 测试用真 PE 文件当替身：System32\cmd.exe（子系统 3，可当 node 用）/ notepad.exe（子系统 2）。
// ★ 判据一律「单引号字面量 + 非子串比较 + 打印期望值」（见 docs/developer.md 测试约定）。

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  setSchtasksRunner, setNodeSearchContext, setNodeVersionProber,
  resolveNodeExe, resolveNodeExeInfo, probeNodeVersion, parseNodeVersion, peSubsystem,
} from '../lib/index.js'
import { installSuiteHooks, makeFakeRunner } from './helpers/common.js'

installSuiteHooks()

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'
const CONSOLE_EXE = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe') // PE 子系统 3
const GUI_EXE = path.join(SYSTEM_ROOT, 'System32', 'notepad.exe') // PE 子系统 2
const DESKTOP_HOST_EXE = 'C:\\install\\DeepSeek Harness.exe' // 桌面版宿主：GUI 子系统、basename 非 node

// —— 模块级注入缝的用例隔离（防上一个用例的替身泄漏到下一个，让判据变假绿）——
beforeEach(() => {
  setSchtasksRunner(makeFakeRunner([])) // 缺省「什么都不命中」；要用命中的用例自行覆盖
  setNodeVersionProber(async () => null) // 缺省「不真跑解释器」；版本用例自行覆盖
  setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: '' }))
  whereCalls.length = 0
})
after(() => {
  setSchtasksRunner(makeFakeRunner([]))
  setNodeVersionProber(async () => null)
})

/** where.exe 调用台账：新优先级要求「自带 node 存在时**不**走到 where.exe」，靠它证明。 */
const whereCalls = []

/** where.exe node 落空（= 只装桌面版的机器）：fake runner 恒 exit 0 且 stdout 为空。 */
function whereMisses() {
  whereCalls.length = 0
  setSchtasksRunner(async (argv) => {
    if (argv[0] === 'where.exe') whereCalls.push(argv.join(' '))
    return { exitCode: 0, stdout: '', stderr: '' }
  })
}

/** where.exe node 命中（= 机器上另有独立 node）：stdout 给一条路径。 */
function whereHits(hitPath) {
  whereCalls.length = 0
  setSchtasksRunner(async (argv) => {
    if (argv[0] === 'where.exe') whereCalls.push(argv.join(' '))
    return { exitCode: 0, stdout: argv[0] === 'where.exe' ? hitPath + '\r\n' : '', stderr: '' }
  })
}

async function makeTmp(tag) {
  const raw = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-node-' + tag + '-'))
  return fsp.realpath(raw).catch(() => raw)
}

/** 把某个真 exe 复制成 dest（用真 PE 文件当 node.exe 替身）。 */
async function placeAs(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(src, dest)
  return dest
}


test('fixture 基线：cmd.exe=3（console，当 node 替身）/ notepad.exe=2（GUI，当反例）', async () => {
  const consoleSub = await peSubsystem(CONSOLE_EXE)
  const guiSub = await peSubsystem(GUI_EXE)
  console.log('[PE 基线] cmd.exe=' + consoleSub + '（期望 3）; notepad.exe=' + guiSub + '（期望 2）')
  assert.equal(consoleSub, 3, 'cmd.exe 应为 console 子系统（实测 ' + consoleSub + '）')
  assert.equal(guiSub, 2, 'notepad.exe 应为 GUI 子系统（实测 ' + guiSub + '）')
})


test('同源 (a)：DSH_DESKTOP_NODE_EXECUTABLE 指向真 node ⇒ 采用（where.exe 落空）', async () => {
  const tmp = await makeTmp('a')
  try {
    const desktopNode = await placeAs(CONSOLE_EXE, path.join(tmp, 'bundled', 'node.exe'))
    whereMisses()
    setNodeSearchContext(() => ({
      execPath: DESKTOP_HOST_EXE,
      env: { DSH_DESKTOP_NODE_EXECUTABLE: desktopNode },
      resourcesPath: '',
    }))
    const got = await resolveNodeExe(tmp)
    console.log('[同源 (a)] 期望 ' + desktopNode + '，实得 ' + got)
    assert.equal(got, desktopNode)
    assert.deepEqual(await resolveNodeExeInfo(tmp), { exe: desktopNode, source: 'desktop-env' }, 'source 标签应为 desktop-env')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


test('同源 (a) 守卫：env 指向 GUI 子系统 ⇒ 不采信，落到 (b) 已知布局', async () => {
  const tmp = await makeTmp('b')
  try {
    const guiNode = await placeAs(GUI_EXE, path.join(tmp, 'gui', 'node.exe'))
    const bundled = await placeAs(
      CONSOLE_EXE,
      path.join(tmp, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    )
    whereMisses()
    setNodeSearchContext(() => ({
      execPath: DESKTOP_HOST_EXE,
      env: { DSH_DESKTOP_NODE_EXECUTABLE: guiNode },
      resourcesPath: path.join(tmp, 'resources'),
    }))
    assert.equal(await resolveNodeExe(tmp), bundled, 'GUI 的 env 候选必须被 PE 守卫拒掉')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


test('同源 (b)：<resourcesPath> 已知布局命中（env 为空、where.exe 落空）', async () => {
  const tmp = await makeTmp('c')
  try {
    const bundled = await placeAs(
      CONSOLE_EXE,
      path.join(tmp, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    )
    whereMisses()
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: path.join(tmp, 'resources') }))
    const got = await resolveNodeExe(tmp)
    console.log('[同源 (b)] 期望 ' + bundled + '，实得 ' + got)
    assert.equal(got, bundled)
    assert.equal((await resolveNodeExeInfo(tmp)).source, 'desktop-bundled')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


test('同源 (b) 守卫：已知布局里是 GUI ⇒ 继续 (c) 扫描，找到更深的真 node', async () => {
  const tmp = await makeTmp('d')
  try {
    await placeAs(
      GUI_EXE,
      path.join(tmp, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    )
    const deeper = await placeAs(
      CONSOLE_EXE,
      path.join(tmp, 'resources', 'runtime', 'other-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    )
    whereMisses()
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: path.join(tmp, 'resources') }))
    assert.equal(await resolveNodeExe(tmp), deeper, '(c) 扫描应跳过 GUI 候选、命中 console 候选')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


test('同源 (c) 边界：只有 GUI 候选 ⇒ fail-closed 返回 null（绝不退回 GUI 的 execPath）', async () => {
  const tmp = await makeTmp('e')
  try {
    await placeAs(
      GUI_EXE,
      path.join(tmp, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    )
    whereMisses()
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: path.join(tmp, 'resources') }))
    const got = await resolveNodeExe(tmp)
    console.log('[fail-closed] 期望 null，实得 ' + got)
    assert.equal(got, null, '三层都拿不到 console node ⇒ 必须为 null')
    assert.notEqual(got, DESKTOP_HOST_EXE, '绝不退回 GUI 子系统的 execPath')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


test('shim 陷阱：非 PE 的 node.exe / 名为 node（无扩展名）的真 PE 都不采信', async () => {
  const tmp = await makeTmp('f')
  try {
    // ① 布局里放一个 0 字节的 node.exe（模拟 <runtime>\bin 里那个非 PE 的 shim）
    const emptyNode = path.join(tmp, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    await fsp.mkdir(path.dirname(emptyNode), { recursive: true })
    await fsp.writeFile(emptyNode, '', 'utf8')
    whereMisses()
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: path.join(tmp, 'resources') }))
    assert.equal(await resolveNodeExe(tmp), null, '非 PE 的 node.exe 不得被采信')

    // ② 名为 node（无扩展名）的真 console PE ⇒ 仍不得采信（shim 就叫 node）
    const shim = await placeAs(CONSOLE_EXE, path.join(tmp, 'resources2', 'runtime', 'bin', 'node'))
    const shimSub = await peSubsystem(shim)
    console.log('[shim ②] 期望 ' + shim + ' 的 PE 子系统 = 3，实得 ' + shimSub)
    assert.equal(shimSub, 3, '该 shim 替身确实是 console PE（实测 ' + shimSub + '）')
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: { DSH_DESKTOP_NODE_EXECUTABLE: shim }, resourcesPath: path.join(tmp, 'resources2') }))
    assert.equal(await resolveNodeExe(tmp), null, 'basename 不是 node.exe 的候选（shim）不得被采信')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


test('同源 (c) 有界：超出深度上限的 node.exe 不被扫到（fail-closed）', async () => {
  const tmp = await makeTmp('g')
  try {
    // 深度 7（> DESKTOP_NODE_SCAN_MAX_DEPTH=5）+ 不在已知布局里
    await placeAs(
      CONSOLE_EXE,
      path.join(tmp, 'resources', 'runtime', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'node.exe'),
    )
    whereMisses()
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: path.join(tmp, 'resources') }))
    assert.equal(await resolveNodeExe(tmp), null, '扫描必须是有界的（限深）')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


// ─────────────────── (i) 新优先级：自带 node 先于 where.exe（v0.1.91 的核心） ───────────────────

test('新优先级 ①：自带 node 存在 ⇒ 取自带，且**绝不**走到 where.exe（v0.1.91）', async () => {
  const tmp = await makeTmp('pri1')
  try {
    const bundled = await placeAs(
      CONSOLE_EXE,
      path.join(tmp, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    )
    const whereNode = await placeAs(CONSOLE_EXE, path.join(tmp, 'path-node', 'node.exe'))
    // where.exe 会命中**机器上任意的**一份 node（这里是异源替身）——它必须排在自带 node 之后
    whereHits(whereNode)
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: path.join(tmp, 'resources') }))
    const got = await resolveNodeExe(tmp)
    console.log('[新优先级 ①] 期望自带 ' + bundled + '（非 where 命中 ' + whereNode + '），实得 ' + got
      + '；where.exe 调用次数=' + whereCalls.length + '（期望 0）')
    assert.equal(got, bundled, '自带（同源）node 必须优先于 where.exe 命中')
    assert.notEqual(got, whereNode, '不得采用 where.exe 命中的异源 node')
    assert.equal(whereCalls.length, 0, '自带 node 已命中 ⇒ 不该白跑 where.exe（期望 0 次，实得 ' + whereCalls.length + '）')
    assert.equal((await resolveNodeExeInfo(tmp)).source, 'desktop-bundled')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


test('新优先级 ②：同源三层全落空 ⇒ 才降级 where.exe（source=where），basename 快路径最优先', async () => {
  const tmp = await makeTmp('pri2')
  try {
    const whereNode = await placeAs(CONSOLE_EXE, path.join(tmp, 'path-node', 'node.exe'))
    whereHits(whereNode)
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: path.join(tmp, 'resources-none') }))
    const got = await resolveNodeExe(tmp)
    console.log('[新优先级 ②] 期望 where 命中 ' + whereNode + '，实得 ' + got)
    assert.equal(got, whereNode, '同源全落空才轮到 where.exe（最后手段）')
    assert.equal((await resolveNodeExeInfo(tmp)).source, 'where')
    assert.ok(whereCalls.length > 0, '这一层必须真跑过 where.exe（实得 ' + whereCalls.length + ' 次）')

    // execPath 本身就是 node.exe ⇒ 快路径优先于一切（保 koffi ABI 匹配、也不跑 where.exe）
    whereCalls.length = 0
    setNodeSearchContext(() => ({ execPath: process.execPath, env: {}, resourcesPath: path.join(tmp, 'resources') }))
    const fast = await resolveNodeExe(tmp)
    console.log('[新优先级 ②] basename 快路径期望 ' + process.execPath + '，实得 ' + fast + '；where.exe 调用次数=' + whereCalls.length)
    assert.equal(fast, process.execPath, 'basename 快路径必须最优先')
    assert.equal(whereCalls.length, 0, 'basename 命中 ⇒ 不该跑 where.exe')
    assert.equal((await resolveNodeExeInfo(tmp)).source, 'basename')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


// ─────────────── (ii) where.exe 命中结果也过 PE/名守卫（补旁路，v0.1.91） ───────────────

test('where.exe 旁路守卫：命中非 PE 的 node.exe（#!/bin/sh shim / 0 字节）⇒ 拒绝', async () => {
  const tmp = await makeTmp('where1')
  try {
    // 模拟 <runtime>\bin\node：非 PE，spawn 会直接失败（若被采信就是 B1 之外的新假成功）
    const shimNode = path.join(tmp, 'runtime-bin', 'node.exe')
    await fsp.mkdir(path.dirname(shimNode), { recursive: true })
    await fsp.writeFile(shimNode, '#!/bin/sh\nexec node "$@"\n', 'utf8')
    const shimSub = await peSubsystem(shimNode)
    whereHits(shimNode)
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: '' }))
    const got = await resolveNodeExe(tmp)
    console.log('[where 守卫·非 PE] shim 的 PE 子系统实测 ' + shimSub + '（期望 null）; 期望解析结果 null，实得 ' + got)
    assert.equal(shimSub, null, '该 shim 不是 PE（实测 ' + shimSub + '）')
    assert.equal(got, null, 'where.exe 命中的非 PE 候选不得被采信')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


test('where.exe 旁路守卫：命中名为 node（无扩展名）的真 console PE ⇒ 仍拒绝', async () => {
  const tmp = await makeTmp('where2')
  try {
    const shim = await placeAs(CONSOLE_EXE, path.join(tmp, 'runtime-bin', 'node'))
    const shimSub = await peSubsystem(shim)
    whereHits(shim)
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: '' }))
    const got = await resolveNodeExe(tmp)
    console.log('[where 守卫·名] ' + shim + ' 的 PE 子系统实测 ' + shimSub + '（期望 3 ⇒ 仍需被名守卫拒）; 期望解析结果 null，实得 ' + got)
    assert.equal(shimSub, 3, '该 shim 替身确实是 console PE（实测 ' + shimSub + '）')
    assert.equal(got, null, 'where.exe 命中的 node（无 .exe）不得被采信')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


test('where.exe 旁路守卫：命中**真 node.exe**（console PE）⇒ 正常采信（别把防线测成一律拒绝）', async () => {
  const tmp = await makeTmp('where3')
  try {
    const realNode = await placeAs(CONSOLE_EXE, path.join(tmp, 'path-node', 'node.exe'))
    whereHits(realNode)
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: '' }))
    assert.equal(await resolveNodeExe(tmp), realNode, '真 node.exe（PE=3）应被采信，守卫只挡异类')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})


// ─────────────────── (iii) 所选 node 的版本落盘（成功 / 失败两种） ───────────────────

test('版本落盘 (iii) 成功：node 的 --version 归一为 x.y.z（parseNodeVersion 基线）', async () => {
  setNodeVersionProber(null) // 恢复生产探测实现（缺省桩只为隔离，本用例要真跑一次）
  const realVersion = await probeNodeVersion(process.execPath)
  const expected = parseNodeVersion(process.version)
  console.log('[版本探测] process.execPath=' + process.execPath + ' 实测=' + realVersion + '（期望 ' + expected + '）')
  assert.equal(realVersion, expected, '真 node 的 --version 应归一成 ' + expected + '（实测 ' + realVersion + '）')
  assert.equal(parseNodeVersion('v24.21.0\n'), '24.21.0', '`v` 前缀 + 换行应归一')
  assert.equal(parseNodeVersion('24.21.0'), '24.21.0', '无 v 前缀同样认')
  assert.equal(parseNodeVersion('not a version'), null, '认不出 ⇒ null')
  assert.equal(parseNodeVersion(''), null, '空串 ⇒ null')
})


test('版本落盘 (iii) 失败：不可执行路径 / 探测抛错 / 非版本输出 ⇒ 一律 null（绝不抛）', async () => {
  const missing = path.join(os.tmpdir(), 'bgjobs-node-absent-' + Date.now(), 'node.exe')
  const fromMissing = await probeNodeVersion(missing)
  console.log('[版本探测·失败] 不存在的 ' + missing + ' ⇒ ' + fromMissing + '（期望 null）')
  assert.equal(fromMissing, null, '不存在的解释器 ⇒ null（不抛）')

  setNodeVersionProber(async () => { throw new Error('probe boom') })
  const fromThrow = await probeNodeVersion(process.execPath)
  console.log('[版本探测·失败] 注入抛错 ⇒ ' + fromThrow + '（期望 null）')
  assert.equal(fromThrow, null, '探测抛错 ⇒ null（提交不得因此失败）')

  setNodeVersionProber(async () => null)
  assert.equal(await probeNodeVersion(process.execPath), null, '探测返回 null ⇒ null')
})


// ─────────────────── (iv) 错误文案中性化后的可判别关键字（v0.1.91） ───────────────────

test('错误文案 (iv)：全落空时中性文案含 console-subsystem / could not be located', async () => {
  const tmp = await makeTmp('msg')
  try {
    whereMisses()
    setNodeSearchContext(() => ({ execPath: DESKTOP_HOST_EXE, env: {}, resourcesPath: path.join(tmp, 'resources-empty') }))
    assert.equal(await resolveNodeExe(tmp), null, '先确证这一层确实落空（null 才有后面的文案场景）')
    // 文案本体在 lib/core/jobs.js 的提交分支；此处钉住它的可判别关键字与「不再写死 where.exe」。
    const NEW_MSG = 'sandbox requested but a real console-subsystem node executable could not be located'
    const OLD_MSG = 'sandbox requested but a real node executable not found (where.exe node)'
    const sourceText = await fsp.readFile(path.join(import.meta.dirname, '..', 'lib', 'core', 'jobs.js'), 'utf8')
    const hasNew = sourceText.includes("'" + NEW_MSG + "'")
    const hasOld = sourceText.includes("'" + OLD_MSG + "'")
    console.log('[错误文案] 新文案存在=' + hasNew + '（期望 true）; 旧文案残留=' + hasOld + '（期望 false）')
    assert.equal(hasNew, true, '中性文案应存在于 lib/core/jobs.js（期望 ' + NEW_MSG + '）')
    assert.equal(hasOld, false, '旧写死 where.exe 的文案不得残留（期望 ' + OLD_MSG + ' 不存在）')
    assert.ok(NEW_MSG.includes('console-subsystem') && NEW_MSG.includes('could not be located'), '文案须含可判别关键字')
    // 同文件紧邻的 GUI 守卫文案保持原样（别改错行）
    assert.ok(sourceText.includes('sandbox runner needs a console-subsystem node'), 'GUI 守卫文案应保持原样')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
