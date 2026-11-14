// bgjobs tests —— v0.4 描述符执行链路（descriptor / envelope / host plan / reconcile）。
// 纯函数级验收：不建任务、不落盘；真实任务链路由 sandbox-backend / submit 等集成用例覆盖。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DESCRIPTOR_VERSION, MAX_ACTION_CHARS,
  encodeDescriptor, decodeDescriptor, validateDescriptor, parseDescriptor,
  buildAction, quoteArg, joinArguments, assertNoSessionScope,
  buildPwshEnvelope, buildBatEnvelope, buildEnvPrefix, encodePwshCommand, buildPwshDelivery, buildBatDelivery,
  planForDescriptor, selectOrphanTasks, jobIdFromTaskName, RECONCILE_GRACE_MS,
  codePageLabel, decodeLogBuffer,
} from '../lib/index.js'
import { finalizeAutoLog } from '../lib/exec/host.mjs'

const BASE = { v: DESCRIPTOR_VERSION, id: 'bg-abc-def', n: 'job', o: 'auto', s: 'sid', w: 'X:\\work' }
const direct = (over = {}) => ({ ...BASE, m: 'direct', e: 'pwsh', c: 'echo ok', ...over })
const acl = (over = {}) => ({
  ...BASE, m: 'sandbox', b: 'acl', e: 'pwsh', c: 'echo ok', p: 'workspace-write',
  t: 'X:\\home\\sandbox\\x', ...over,
})
const dsh = (over = {}) => ({
  ...BASE, m: 'sandbox', b: 'dsh', e: 'pwsh',
  a: ['X:\\wxc\\wxc-exec.exe', '--', 'X:\\pwsh\\pwsh.exe', '-NoProfile'], ...over,
})

// ── 编解码 ───────────────────────────────────────────────────────────────────

test('descriptor 往返：含中文/多行逐字还原', () => {
  const d = direct({ n: '中文任务', c: "Write-Output '中文'\nexit 2" })
  const text = encodeDescriptor(d)
  assert.match(text, /^[A-Za-z0-9_-]+$/, '描述符必须是单行 base64url')
  assert.deepEqual(decodeDescriptor(text), d)
  assert.deepEqual(parseDescriptor(text), d, 'parse = decode + validate')
  assert.equal(validateDescriptor(d), d, 'validate 通过时返回原对象')
})

test('descriptor 解码：空/非 base64url/损坏载荷一律 fail loud', () => {
  assert.throws(() => decodeDescriptor(''), /descriptor: empty/)
  assert.throws(() => decodeDescriptor('a+b/c='), /not base64url/)
  assert.throws(() => decodeDescriptor('QUJD'), /inflate failed/)
})

// ── 字段契约矩阵（I4）：缺字段/多字段都 fail-closed ──────────────────────────

test('字段矩阵：direct 必带 c、禁带 b/a/p/t', () => {
  validateDescriptor(direct())
  assert.throws(() => validateDescriptor(direct({ c: undefined })), /requires a non-empty "c"/)
  for (const key of ['b', 'a', 'p', 't']) {
    assert.throws(() => validateDescriptor(direct({ [key]: key === 'a' ? ['x'] : 'x' })), /must not carry/,
      'direct 不得携带 ' + key)
  }
})

test('字段矩阵：sandbox+dsh 必带 a、禁带 c/p/t', () => {
  validateDescriptor(dsh())
  assert.throws(() => validateDescriptor(dsh({ a: undefined })), /requires a non-empty "a"/)
  assert.throws(() => validateDescriptor(dsh({ a: [] })), /requires a non-empty "a"/)
  assert.throws(() => validateDescriptor(dsh({ a: ['relative.exe'] })), /"a\[0\]" must be an absolute path/)
  for (const key of ['c', 'p', 't']) {
    assert.throws(() => validateDescriptor(dsh({ [key]: 'x' })), /must not carry/, 'dsh 不得携带 ' + key)
  }
})

test('字段矩阵：sandbox+acl 必带 c/p、可选 t、禁带 a', () => {
  validateDescriptor(acl())
  validateDescriptor(acl({ t: undefined }))
  assert.throws(() => validateDescriptor(acl({ c: undefined })), /requires a non-empty "c"/)
  assert.throws(() => validateDescriptor(acl({ p: undefined })), /requires "p"/)
  assert.throws(() => validateDescriptor(acl({ p: 'off' })), /requires "p"/)
  assert.throws(() => validateDescriptor(acl({ t: 'relative' })), /must be an absolute path/)
  assert.throws(() => validateDescriptor(acl({ a: ['X:\\x.exe'] })), /must not carry "a"/)
})

test('字段矩阵：m/b/e/o/v 的非法取值与未知字段', () => {
  assert.throws(() => validateDescriptor(direct({ v: 2 })), /unsupported version/)
  assert.throws(() => validateDescriptor({ ...direct(), b: undefined, m: 'auto' }), /missing\/invalid "m"/)
  assert.throws(() => validateDescriptor(direct({ e: 'cmd' })), /expected pwsh \| bat/)
  assert.throws(() => validateDescriptor(direct({ o: 'utf16' })), /expected utf8 \| native \| auto/)
  assert.throws(() => validateDescriptor({ ...direct(), z: 1 }), /unknown field "z"/)
  assert.throws(() => validateDescriptor(direct({ id: 'bad id' })), /missing\/invalid "id"/)
  assert.throws(() => validateDescriptor(direct({ w: 'relative\\dir' })), /"w"/)
  assert.throws(() => validateDescriptor(null), /not an object/)
})

test('字段矩阵：bat 引擎不得 utf8；`x` 已退役（env 走命令前缀）', () => {
  assert.throws(() => validateDescriptor(direct({ e: 'bat', o: 'utf8' })), /engine bat/)
  validateDescriptor(direct({ e: 'bat', o: 'native' }))
  assert.throws(() => validateDescriptor(direct({ x: { FOO: 'v' } })), /unknown field "x"/)
})

test('buildEnvPrefix：pwsh 前缀单引号转义；空值=删除；非法入参 fail loud', () => {
  assert.equal(buildEnvPrefix('pwsh', undefined), '')
  assert.equal(buildEnvPrefix('pwsh', {}), '')
  assert.equal(buildEnvPrefix('pwsh', { FOO: 'bar' }), "$env:FOO = 'bar'\r\n")
  assert.equal(buildEnvPrefix('pwsh', { A: 'it\'s', B: 2, C: false }), "$env:A = 'it''s'\r\n$env:B = '2'\r\n$env:C = 'false'\r\n")
  assert.equal(buildEnvPrefix('pwsh', { TMP: 'X:\\t' }), "$env:TMP = 'X:\\t'\r\n", 'temp 不再是禁区（前缀由脚本执行）')
  assert.equal(buildEnvPrefix('pwsh', { EMPTY: '' }), "$env:EMPTY = ''\r\n", '空串 ⇒ 删除该变量')
  assert.equal(buildEnvPrefix('pwsh', { SKIP: undefined }), '')
  assert.equal(buildEnvPrefix('bat', { FOO: 'bar' }), 'set "FOO=bar"\r\n')
  assert.throws(() => buildEnvPrefix('pwsh', { 'A-B': 'v' }), /invalid variable name "A-B"/)
  assert.throws(() => buildEnvPrefix('pwsh', { FOO: { a: 1 } }), /must be a string, number or boolean/)
  assert.throws(() => buildEnvPrefix('pwsh', { FOO: 'a\nb' }), /must not contain a line break/)
  assert.throws(() => buildEnvPrefix('pwsh', 'FOO=bar'), /expected an object/)
})

test('assertNoSessionScope：confine 产物携带会话级 temp 授权 ⇒ 提交期拒绝（E4）', () => {
  assertNoSessionScope(['X:\\wxc.exe', '--config-base64', 'QUJD', '--'])
  for (const bad of ['--write-sid', '--temp-write-sid', '--write-sid=S-1', '--TEMP-WRITE-SID=x']) {
    assert.throws(() => assertNoSessionScope(['X:\\wxc.exe', bad]), /session-scoped temp grants/)
  }
})

// ── 任务定义与预算 ───────────────────────────────────────────────────────────

test('quoteArg/joinArguments：只在需要时加引号，内部引号按 Windows 规则转义', () => {
  assert.equal(quoteArg('X:\\a\\b'), 'X:\\a\\b')
  assert.equal(quoteArg('X:\\a b'), '"X:\\a b"')
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""')
  assert.equal(joinArguments(['a', 'b c', 'd']), 'a "b c" d')
  assert.equal(joinArguments([]), '')
})

test('buildAction：<node> <host.mjs> <jobDir> <descriptor>；超预算 fail-closed 且报出超出量', () => {
  const descriptor = encodeDescriptor(direct())
  const action = buildAction({
    nodeExe: 'X:\\Program Files\\nodejs\\node.exe',
    hostScript: 'X:\\plugins\\bgjobs\\lib\\exec\\host.mjs',
    jobDir: 'X:\\work\\.dsh\\bgjobs\\bg-abc-def',
    descriptor,
  })
  assert.equal(action.execute, 'X:\\Program Files\\nodejs\\node.exe')
  // 无空格的路径不加引号（quoteArg 只在必要时包裹）
  assert.equal(action.arguments, [
    'X:\\plugins\\bgjobs\\lib\\exec\\host.mjs',
    'X:\\work\\.dsh\\bgjobs\\bg-abc-def',
    descriptor,
  ].join(' '))
  assert.equal(action.chars, action.commandLine.length)
  assert.ok(action.chars <= MAX_ACTION_CHARS)

  // 必须高熵：重复字符会被 deflate 压到预算内
  const huge = randomBytes(MAX_ACTION_CHARS + 5000).toString('base64url')
  assert.throws(
    () => buildAction({ nodeExe: 'X:\\n\\node.exe', hostScript: 'X:\\p\\host.mjs', jobDir: 'X:\\j', descriptor: encodeDescriptor(direct({ c: huge })) }),
    /over the 30000 budget by \d+/,
  )
  assert.throws(() => buildAction({ nodeExe: 'node.exe', hostScript: 'X:\\p\\host.mjs', jobDir: 'X:\\j', descriptor }), /absolute path/)
})

// ── 命令信封 ─────────────────────────────────────────────────────────────────

test('pwsh 信封：pwsh 7 无 5.1 preamble；命令进 & { } 且错误流就地转文本、收尾 exit', () => {
  const env = buildPwshEnvelope("Write-Output 'hi'", { encoding: 'auto', interpreter: 'X:\\pwsh\\7\\pwsh.exe' })
  assert.ok(!env.startsWith('# bgjobs:'), 'pwsh 7 不得写 5.1 preamble')
  assert.ok(env.includes("try { $PSStyle.OutputRendering = 'PlainText' } catch { }"), 'pwsh 7 剥 ANSI 颜色')
  assert.ok(env.includes('    & {\r\nWrite-Output \'hi\'\r\n    } 2>&1 | ForEach-Object {'), '原始命令原样进 & { }')
  assert.ok(env.includes('GetEncoding(28591)'), 'auto：native 字节一律按 28591 成像（无损）')
  assert.ok(env.includes('[Console]::SetOut($bgjobOut)'), 'auto：PS 自身输出（含 Write-Host）走显式 UTF-8 写入器')
  assert.ok(env.includes('New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $bgjobUtf8)'))
  assert.ok(env.includes('try { $bgjobOut.Flush(); $bgjobOut.Dispose() } catch { }'), 'auto：收尾必须 flush/dispose')
  assert.ok(env.includes('$bgjobExit = $LASTEXITCODE'))
  assert.ok(env.endsWith('exit $bgjobExit\r\n'))
})

test('pwsh 信封：utf8 不走成像；native 取继承码页', () => {
  const utf8 = buildPwshEnvelope('echo ok', { encoding: 'utf8', interpreter: 'X:\\pwsh\\7\\pwsh.exe' })
  assert.ok(utf8.includes('[Console]::OutputEncoding = $bgjobUtf8'), 'utf8：直接 UTF-8')
  assert.ok(!utf8.includes('28591'), 'utf8 不是成像模式')
  assert.ok(!utf8.includes('$bgjobOut'), 'utf8 不需要显式写入器（Console.Out 就是 UTF-8）')

  const native = buildPwshEnvelope('echo ok', { encoding: 'native', interpreter: 'X:\\pwsh\\7\\pwsh.exe' })
  assert.ok(native.includes('$bgjobNative = [Console]::OutputEncoding'), 'native：先取继承码页')
  assert.ok(native.includes('[Console]::OutputEncoding = $bgjobNative'), 'native：用继承码页')
  assert.ok(!native.includes('28591'), 'native 不走成像')
})

test('pwsh 信封：5.1 写编码 preamble', () => {
  const ps51 = buildPwshEnvelope('echo ok', { encoding: 'auto', interpreter: 'X:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })
  assert.ok(ps51.startsWith('# bgjobs: 强制 UTF-8 输出'), '5.1：首行 preamble')
  assert.ok(ps51.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  assert.ok(ps51.includes('$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  assert.ok(!ps51.includes('$PSStyle'), '5.1 不得用 $PSStyle')
  assert.ok(ps51.includes('GetEncoding(28591)'), '5.1 的 auto 同样是成像 + UTF-8 写入器')
})

test('bat 信封：@echo off + 仅 utf8 切 65001 + exit /b %errorlevel%', () => {
  const utf8 = buildBatEnvelope('echo ok', { encoding: 'utf8' })
  assert.equal(utf8, '@echo off\r\n>nul chcp 65001\r\necho ok\r\nexit /b %errorlevel%\r\n')
  const native = buildBatEnvelope('echo ok', { encoding: 'native' })
  assert.ok(!native.includes('chcp'), 'native 不改代码页')
})

test('交付参数：pwsh 用 -EncodedCommand（UTF-16LE base64）；bat 用 /d /c 且双写内部引号', () => {
  const env = buildPwshEnvelope('echo ok', { interpreter: 'X:\\pwsh\\pwsh.exe' })
  const delivery = buildPwshDelivery({ interpreter: 'X:\\pwsh\\pwsh.exe', envelope: env })
  assert.deepEqual(delivery.slice(0, 6), ['X:\\pwsh\\pwsh.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  assert.equal(Buffer.from(delivery[6], 'base64').toString('utf16le'), env)
  assert.equal(delivery[6], encodePwshCommand(env))
  assert.deepEqual(buildBatDelivery({ envelope: 'echo "a"' }), ['/d', '/c', '"echo ""a"""'])
})

// ── host 计划 ────────────────────────────────────────────────────────────────

test('planForDescriptor：direct = 解释器 -EncodedCommand（命令在信封里）', () => {
  const plan = planForDescriptor(direct({ c: "Write-Output 'ok'" }))
  assert.equal(plan.kind, 'direct')
  assert.equal(plan.execute, plan.interpreter)
  assert.ok(plan.execute.toLowerCase().endsWith('.exe'))
  assert.equal(plan.args[4], '-EncodedCommand')
  const envelope = Buffer.from(plan.args[5], 'base64').toString('utf16le')
  assert.ok(envelope.includes("Write-Output 'ok'"))
})

test('planForDescriptor：dsh = 提交期 confine 产物的 execute + args 逐字', () => {
  const plan = planForDescriptor(dsh())
  assert.equal(plan.kind, 'dsh')
  assert.equal(plan.execute, 'X:\\wxc\\wxc-exec.exe')
  assert.deepEqual(plan.args, ['--', 'X:\\pwsh\\pwsh.exe', '-NoProfile'])
})

test('planForDescriptor：acl = node runner 包解释器；bat 一律拒绝', () => {
  const plan = planForDescriptor(acl())
  assert.equal(plan.kind, 'acl')
  assert.equal(plan.execute, process.execPath)
  assert.equal(plan.args[0].endsWith('runner.js'), true, 'args[0] 应是 ACL runner')
  assert.deepEqual(plan.args.slice(1, 8), ['--workspace', 'X:\\work', '--temp', 'X:\\home\\sandbox\\x', '--mode', 'workspace-write', '--'])
  assert.throws(() => planForDescriptor(direct({ e: 'bat' })), /engine bat is not supported/)
})

// ── 启动期对账 ───────────────────────────────────────────────────────────────

test('jobIdFromTaskName：只认本插件前缀 + jobId 形状', () => {
  assert.equal(jobIdFromTaskName('dsh-bgj-bg-abc-def'), 'bg-abc-def')
  assert.equal(jobIdFromTaskName('dsh-bgj-probe3'), null, '人工探针任务永不被当成自家任务')
  assert.equal(jobIdFromTaskName('other-bg-abc-def'), null)
  assert.equal(jobIdFromTaskName(undefined), null)
})

test('selectOrphanTasks：跳过 Running / 宽限内 / 索引内 / 形状不符', () => {
  const now = 1_000_000_000
  const old = now - RECONCILE_GRACE_MS - 1000
  const tasks = [
    { name: 'dsh-bgj-bg-a1-b2', state: 'Ready', date: old },
    { name: 'dsh-bgj-bg-c3-d4', state: 'Running', date: old },
    { name: 'dsh-bgj-bg-e5-f6', state: 'Ready', date: now - 1000 },
    { name: 'dsh-bgj-bg-g7-h8', state: 'Ready', date: old },
    { name: 'dsh-bgj-probe3', state: 'Ready', date: old },
    { name: 'dsh-bgj-bg-i9-j0', state: 'Ready', date: 0 },
  ]
  const picked = selectOrphanTasks({
    tasks, knownIds: new Set(['bg-g7-h8']), now, graceMs: RECONCILE_GRACE_MS,
  })
  assert.deepEqual(picked, [{ id: 'bg-a1-b2', name: 'dsh-bgj-bg-a1-b2' }])
})

// ── 日志码页（v11）：auto 成像还原 + native 按记录码页解码 ────────────────────

test('codePageLabel / decodeLogBuffer：native 按记录的码页解码；auto 追加成像还原', () => {
  assert.equal(codePageLabel(65001), 'utf-8')
  assert.equal(codePageLabel(936), 'gbk')
  assert.equal(codePageLabel(950), 'big5')
  assert.equal(codePageLabel(1252), 'windows-1252')
  assert.equal(codePageLabel(undefined), 'utf-8')
  assert.equal(codePageLabel(437), 'utf-8', '认不出的码页回落 UTF-8，绝不抛错')

  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])   // "中文" 的 GBK 字节
  assert.equal(decodeLogBuffer(gbk, { outputEncoding: 'native', logCodePage: 936 }), '中文')
  assert.ok(decodeLogBuffer(gbk, { outputEncoding: 'native', logCodePage: 65001 }).includes('\uFFFD'), '码页记错就显示乱码，不再假装能自动识别')

  // auto：28591 成像后的 UTF-8 文本（U+00E4 U+00B8 U+00AD … ⇒ 字节 e4 b8 ad …）
  const imaged = Buffer.from('NODE-\u00e4\u00b8\u00ad\u00e6\u0096\u0087', 'utf8')
  assert.equal(decodeLogBuffer(imaged, { outputEncoding: 'auto', logCodePage: 65001 }), 'NODE-中文')
  assert.equal(decodeLogBuffer(imaged, { outputEncoding: 'auto' }), 'NODE-中文', '缺 logCodePage 的老记录也要能还原')
  // v13：收尾完成（logFormat='utf8'）的日志不许再跑成像还原——`°±·` 这类纯 Latin-1 文本
  // 会被 strict UTF-8 判死再回落 GBK，还原成乱码；老记录（无 logFormat）保持解码行为。
  const latin1 = Buffer.from('°±·', 'utf8')
  assert.equal(decodeLogBuffer(latin1, { outputEncoding: 'auto', logFormat: 'utf8', logCodePage: 65001 }), '°±·')
  assert.notEqual(decodeLogBuffer(latin1, { outputEncoding: 'auto', logFormat: 'latin1-legacy', logCodePage: 65001 }), '°±·')
  // v13：整段字节末尾停在多字节中间（任务被 kill）⇒ 先裁残片再解码，不留 `�`
  assert.equal(decodeLogBuffer(Buffer.from([0x41, 0xe4, 0xb8]), { outputEncoding: 'utf8', logCodePage: 65001 }), 'A')
  assert.equal(decodeLogBuffer(Buffer.from([0x41, 0xd6]), { outputEncoding: 'native', logCodePage: 936 }), 'A')
})

test('finalizeAutoLog：收尾把成像还原成干净 UTF-8；已干净则零改写', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgj-final-'))
  try {
    const logPath = path.join(dir, 'stdout.log')
    await fsp.writeFile(logPath, 'PS-中文\r\nNODE-\u00e4\u00b8\u00ad\u00e6\u0096\u0087\r\n', 'utf8')
    await finalizeAutoLog(logPath)
    assert.equal(await fsp.readFile(logPath, 'utf8'), 'PS-中文\r\nNODE-中文\r\n')
    // v13：收尾后落 log.format='utf8' 标记（watch 据此把 meta.logFormat 改成 utf8）
    assert.equal((await fsp.readFile(path.join(dir, 'log.format'), 'utf8')).trim(), 'utf8')
    await finalizeAutoLog(logPath)   // 幂等：第二次不得改动
    assert.equal(await fsp.readFile(logPath, 'utf8'), 'PS-中文\r\nNODE-中文\r\n')
    const missing = path.join(dir, 'nope.log')
    await finalizeAutoLog(missing)   // 不存在 ⇒ 静默（收尾尽力而为）
    assert.equal(await fsp.readFile(missing, 'utf8').then(() => true).catch(() => false), false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
