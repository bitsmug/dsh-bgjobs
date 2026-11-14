// v0.4.0：启动策略（lib/exec/launch.mjs）契约测试。
// 目标：缺省 direct 与改动前**逐字相同**；开关开启才经包内 launch.vbs（wscript）启动。
// 参考 docs/spec-launch-strategy.md 的 L2 / L9 / L11。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-launch-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome

const { buildAction } = await import('../lib/exec/descriptor.mjs')
const {
  LAUNCHER_SCRIPT, LAUNCHER_ERROR_FILE, directStrategy, wscriptShimStrategy, wscriptExe,
  planLaunch, isWshDisabled, setWshProbe, readLaunchError, quoteArgWsh, joinArgumentsWsh,
} = await import('../lib/exec/launch.mjs')
const { createStore } = await import('../lib/core/store.js')

after(async () => {
  setWshProbe(null)
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

const NODE = 'X:\\pkg\\node.exe'
const HOST = 'X:\\pkg\\lib\\exec\\host.mjs'
const JOB_DIR = 'X:\\jobs\\j1'
const target = () => ({ execute: NODE, args: [HOST, JOB_DIR, 'AAAA'] })

test('direct：与 buildAction 逐字相同（L11 回归）', () => {
  const a = planLaunch({ target: target(), strategy: directStrategy })
  const b = buildAction({ nodeExe: NODE, hostScript: HOST, jobDir: JOB_DIR, descriptor: 'AAAA' })
  assert.equal(a.execute, b.execute)
  assert.equal(a.arguments, b.arguments)
  assert.equal(a.commandLine, b.commandLine)
  assert.equal(a.chars, b.chars)
  assert.equal(a.rootKind, 'direct')
})

test('shim：wscript 绝对路径 + //B //Nologo + 包内资产 + errorDir 在首位', () => {
  const a = planLaunch({ target: target(), strategy: wscriptShimStrategy, errorDir: JOB_DIR })
  assert.equal(a.execute, wscriptExe())
  assert.ok(path.isAbsolute(a.execute), 'execute 必须是绝对路径（L3）')
  assert.equal(a.rootKind, 'shim')
  const tokens = a.arguments.replace(/"([^"]*)"/g, '$1').split(' ')
  assert.deepEqual(tokens.slice(0, 2), ['//B', '//Nologo'])
  assert.equal(tokens[2], LAUNCHER_SCRIPT, '必须引用包内静态资产')
  assert.equal(tokens[3], JOB_DIR, 'errorDir 必须是 argv[0]')
  assert.equal(tokens[4], NODE, '目标 execute 紧跟 errorDir')
  assert.deepEqual(tokens.slice(5), [HOST, JOB_DIR, 'AAAA'], '目标 argv 原样转发')
})

test('shim：errorDir 非绝对路径 ⇒ 提交期抛出（不静默失败）', () => {
  assert.throws(() => planLaunch({ target: target(), strategy: wscriptShimStrategy, errorDir: 'jobs\\j1' }), /absolute errorDir/)
})

test('预算：按**包装后**整条命令行复核（L2），超限 fail loud', () => {
  const direct = planLaunch({ target: target(), strategy: directStrategy })
  assert.throws(() => planLaunch({ target: target(), strategy: directStrategy, budget: direct.chars - 1 }), /after launch wrapping/)
  assert.throws(() => planLaunch({ target: target(), strategy: wscriptShimStrategy, errorDir: JOB_DIR, budget: 40 }), /after launch wrapping/)
})

test('包内资产：存在、纯 ASCII、无 BOM、内容与作业无关（L9）', async () => {
  const buf = await fsp.readFile(LAUNCHER_SCRIPT)
  assert.ok(buf.length > 0, 'launch.vbs 必须随包发布')
  assert.notEqual(buf[0], 0xef, '不得有 UTF-8 BOM')
  for (const b of buf) assert.ok(b < 0x80, 'launch.vbs 必须是纯 ASCII（避免代码页歧义）')
  const text = buf.toString('latin1')
  assert.ok(text.includes('WScript.Arguments'), '参数必须经 WScript.Arguments（UTF-16，无编码问题）')
  assert.ok(text.includes('sh.Run cmd, 0, True'), '必须 SW_HIDE(0) + 等待(True)')
})

test('WSH 口径引号：只按空白包引号、不翻倍反斜杠（stage2 不能被 MSVCRT 规则污染）', () => {
  assert.equal(quoteArgWsh('simple'), 'simple')
  assert.equal(quoteArgWsh('a b'), '"a b"')
  assert.equal(quoteArgWsh('a\tb'), '"a\tb"')
  assert.equal(quoteArgWsh(''), '""')
  assert.equal(quoteArgWsh('X:\\tmp dir\\'), '"X:\\tmp dir\\"', 'WSH 不认 \\" 转义 ⇒ 尾随反斜杠不得翻倍')
  assert.equal(joinArgumentsWsh(['//B', 'a b', 'c']), '//B "a b" c')
})

test('launch.vbs：argv 逐字转发（真实 cscript + 包内资产，端到端）', {
  skip: process.platform !== 'win32' ? '仅 Windows 有 WSH' : false,
}, async () => {
  const dir = path.join(tmpHome, 'fidelity')
  await fsp.mkdir(dir, { recursive: true })
  const probe = path.join(dir, 'probe-argv.mjs')
  await fsp.writeFile(probe,
    "import fs from 'node:fs'\nfs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)), 'utf8')\n", 'utf8')
  const cscript = path.join(process.env.SystemRoot || 'X:\\Windows', 'System32', 'cscript.exe')
  const out = path.join(dir, 'argv.json')
  const payloads = [['plain'], ['a b'], ['a\tb'], [''], ['X:\\tmp dir\\'], ['X:\\tmp\\'], ['中文 目录'], ['a', 'b c', '']]
  for (const payload of payloads) {
    await fsp.rm(out, { force: true })
    const action = planLaunch({
      target: { execute: process.execPath, args: [probe, out, ...payload] },
      strategy: wscriptShimStrategy,
      errorDir: dir,
    })
    const res = spawnSync(cscript, [action.arguments], { windowsVerbatimArguments: true, encoding: 'utf8' })
    assert.equal(res.status, 0, 'cscript 应正常退出：' + (res.stderr || ''))
    assert.deepEqual(JSON.parse(await fsp.readFile(out, 'utf8')), payload,
      'argv 必须逐字转发：' + JSON.stringify(payload))
  }
})

test('WSH 探测：注入缝生效（不读真实注册表）', () => {
  setWshProbe(() => true)
  assert.equal(isWshDisabled(), true)
  setWshProbe(() => false)
  assert.equal(isWshDisabled(), false)
  setWshProbe(() => { throw new Error('probe down') })
  assert.equal(isWshDisabled(), false, '探测异常按"未禁用"处理（照常尝试 shim）')
  setWshProbe(null)
})

test('readLaunchError：取首行；缺失 ⇒ null', async () => {
  assert.equal(await readLaunchError('X:\\jobs\\nope'), null)
  const dir = path.join(tmpHome, 'joberr')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, LAUNCHER_ERROR_FILE), '\r\nlaunch failed: boom\r\nnext\r\n', 'utf8')
  assert.equal(await readLaunchError(dir), 'launch failed: boom')
})

test('开关：launch.json 缺省关；写后立即可读回（不缓存）', async () => {
  const store = createStore()
  const file = path.join(tmpHome, 'bgjobs', 'launch.json')
  await fsp.rm(file, { force: true })
  assert.equal(await store.readLaunchHidden(), false, '无文件 ⇒ 默认关（与改动前逐字相同）')
  assert.deepEqual(await store.setLaunchHidden(true), { ok: true, enabled: true })
  assert.equal(await store.readLaunchHidden(), true)
  assert.deepEqual(await store.setLaunchHidden(false), { ok: true, enabled: false })
  assert.equal(await store.readLaunchHidden(), false)
  await fsp.writeFile(file, JSON.stringify({ enabled: 'yes' }), 'utf8')
  assert.equal(await store.readLaunchHidden(), false, '非 true 的字面量 ⇒ false（fail-safe）')
})
