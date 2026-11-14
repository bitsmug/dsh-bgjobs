// bgjobs exec —— 任务描述符：编解码 + 字段契约矩阵 + 长度预算（spec v7 §4.3 / I3 / I4）。
//
// 描述符 = base64url(deflateRaw(utf8(JSON)))，是 Task Scheduler 任务定义里**唯一**的
// 执行输入；工作区里的 job.json / cmd.ps1 只是记录，不被读取为配置、不被执行（I1/I2）。
//
// 字段契约由 `m` 决定（I4）——缺字段、多字段一律 fail-closed，绝不取默认：
//   direct  : v,m,id,n,e,o,s,w,c          禁带 b,a,p,t
//   sandbox : + b
//     dsh   : v,m,b,id,n,e,o,s,w,a        禁带 c,p,t
//     acl   : v,m,b,id,n,e,o,s,w,c,p[,t]  禁带 a

import zlib from 'node:zlib'
import path from 'node:path'

/** 描述符版本；host 见到未知版本必须拒绝（§8 host 升级）。 */
export const DESCRIPTOR_VERSION = 1

/**
 * 整条任务命令行的产品上限（字符）。实测（spec §12-E2）32700 可用、32760 起
 * `0x800700CE`；取 30000 留余量给 node.exe / host.mjs / jobDir 与引号。
 */
export const MAX_ACTION_CHARS = 30000

const MODES = ['direct', 'sandbox']
const BACKENDS = ['dsh', 'acl']
const ENGINES = ['pwsh', 'bat']
const ENCODINGS = ['utf8', 'native', 'auto']
const SANDBOX_POLICIES = ['read-only', 'workspace-write']
const ID_RE = /^[A-Za-z0-9._-]+$/

const ALL_FIELDS = new Set(['v', 'm', 'id', 'n', 'e', 'o', 's', 'w', 'b', 'p', 't', 'c', 'a'])

const fail = (msg) => {
  throw new Error('descriptor: ' + msg)
}

/** 描述符 → 单行文本（base64url，无填充）。 */
export function encodeDescriptor(descriptor) {
  const json = JSON.stringify(descriptor)
  const packed = zlib.deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 })
  return packed.toString('base64url')
}

/** 单行文本 → 描述符对象；任何损坏都抛错（调用方 fail-closed）。 */
export function decodeDescriptor(text) {
  const s = String(text === undefined || text === null ? '' : text)
  if (s.length === 0) fail('empty')
  if (!/^[A-Za-z0-9_-]+$/.test(s)) fail('not base64url')
  let json
  try {
    json = zlib.inflateRawSync(Buffer.from(s, 'base64url')).toString('utf8')
  } catch (e) {
    fail('inflate failed: ' + ((e && e.message) || String(e)))
  }
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    fail('invalid json: ' + ((e && e.message) || String(e)))
  }
  return parsed
}

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0
const isAbs = (v) => isNonEmptyString(v) && path.win32.isAbsolute(v)

/**
 * `b=dsh` 的 argv 必须是**无会话作用域**的（spec §5.1 / §12-E4）：出现
 * `--write-sid` / `--temp-write-sid` 说明提交期把 sessionId 传给了 confine()，
 * 任务会在 DSH 退出后必然失败 ⇒ 提交期 fail-closed。
 */
export function assertNoSessionScope(argv) {
  for (const arg of argv) {
    const s = String(arg).toLowerCase()
    if (s === '--write-sid' || s === '--temp-write-sid'
      || s.startsWith('--write-sid=') || s.startsWith('--temp-write-sid=')) {
      fail('sandbox argv carries session-scoped temp grants (' + arg + '); do not pass sessionId to confine()')
    }
  }
}

/**
 * 按 §4.3 矩阵校验描述符形状（纯函数，不碰文件系统）。
 * 通过返回描述符本身；不通过抛错（错误信息以 "descriptor: " 开头）。
 */
export function validateDescriptor(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) fail('not an object')
  for (const key of Object.keys(d)) {
    if (!ALL_FIELDS.has(key)) fail('unknown field "' + key + '"')
  }
  if (d.v !== DESCRIPTOR_VERSION) fail('unsupported version: ' + String(d.v))
  if (!MODES.includes(d.m)) fail('missing/invalid "m" (expected direct | sandbox)')
  if (!isNonEmptyString(d.id) || !ID_RE.test(d.id) || d.id.length > 128) fail('missing/invalid "id"')
  if (typeof d.n !== 'string') fail('missing "n"')
  if (!ENGINES.includes(d.e)) fail('missing/invalid "e" (expected pwsh | bat)')
  if (!ENCODINGS.includes(d.o)) fail('missing/invalid "o" (expected utf8 | native | auto)')
  if (typeof d.s !== 'string') fail('missing "s"')
  if (!isAbs(d.w)) fail('missing/invalid "w" (expected an absolute path)')
  if (d.e === 'bat' && d.o === 'utf8') fail('"o" must be native|auto for engine bat')

  const has = (key) => d[key] !== undefined

  if (d.m === 'direct') {
    for (const key of ['b', 'a', 'p', 't']) {
      if (has(key)) fail('"m=direct" must not carry "' + key + '"')
    }
    if (!isNonEmptyString(d.c)) fail('"m=direct" requires a non-empty "c"')
    return d
  }

  // m === 'sandbox'
  if (!BACKENDS.includes(d.b)) fail('"m=sandbox" requires "b" (expected dsh | acl)')
  if (d.b === 'dsh') {
    for (const key of ['c', 'p', 't']) {
      if (has(key)) fail('"b=dsh" must not carry "' + key + '"')
    }
    if (!Array.isArray(d.a) || d.a.length === 0) fail('"b=dsh" requires a non-empty "a" argv')
    for (const item of d.a) {
      if (typeof item !== 'string' || item.length === 0) fail('"a" must be an array of non-empty strings')
    }
    if (!isAbs(d.a[0])) fail('"a[0]" must be an absolute path')
    assertNoSessionScope(d.a)
    return d
  }
  // b === 'acl'
  if (has('a')) fail('"b=acl" must not carry "a"')
  if (!isNonEmptyString(d.c)) fail('"b=acl" requires a non-empty "c"')
  if (!SANDBOX_POLICIES.includes(d.p)) fail('"b=acl" requires "p" (expected read-only | workspace-write)')
  if (has('t') && !isAbs(d.t)) fail('"t" must be an absolute path when present')
  return d
}

/** 解码 + 校验一条描述符文本。 */
export function parseDescriptor(text) {
  return validateDescriptor(decodeDescriptor(text))
}

/** Windows 命令行参数引用（路径/描述符均无内嵌引号，仍按通用规则转义）。 */
export function quoteArg(value) {
  const s = String(value)
  if (s.length > 0 && !/[\s"]/.test(s)) return s
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

/** 由 argv 数组拼整条命令行（不含 execute）。 */
export function joinArguments(args) {
  return (Array.isArray(args) ? args : []).map(quoteArg).join(' ')
}

/**
 * 目标 argv（不含启动包装）：`[host.mjs, jobDir, descriptor]`。
 * 启动策略（lib/exec/launch.mjs）只包装它，不解读内容 ⇒ 策略与描述符契约互不窥探。
 */
export function buildTarget({ nodeExe, hostScript, jobDir, descriptor }) {
  if (!isAbs(nodeExe)) fail('node executable must be an absolute path')
  if (!isAbs(hostScript)) fail('host script must be an absolute path')
  if (!isAbs(jobDir)) fail('job dir must be an absolute path')
  return { execute: nodeExe, args: [hostScript, jobDir, descriptor] }
}

/**
 * 任务 action = `<node.exe> "<host.mjs>" "<jobDir>" "<descriptor>"`。
 * 返回 { execute, arguments, commandLine, chars }；超预算抛错（fail-closed，§4.3）。
 */
export function buildAction({ nodeExe, hostScript, jobDir, descriptor }) {
  const target = buildTarget({ nodeExe, hostScript, jobDir, descriptor })
  const args = joinArguments(target.args)
  const commandLine = quoteArg(target.execute) + ' ' + args
  if (commandLine.length > MAX_ACTION_CHARS) {
    const over = commandLine.length - MAX_ACTION_CHARS
    fail('action command line is ' + commandLine.length + ' chars, over the '
      + MAX_ACTION_CHARS + ' budget by ' + over + ' (shorten the command or use sandbox_backend=acl)')
  }
  return { execute: target.execute, arguments: args, commandLine, chars: commandLine.length }
}
