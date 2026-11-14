// bgjobs —— 纯字符串/退出码工具（v0.1.61 结构重构自 lib/index.js 拆分）。

import { execFileSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'

/**
 * 原子发布一个小文件（v16）：写同目录临时文件 → `rename` 覆盖目标。
 * Windows 上 `rename` 走 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，同卷内是目录项替换 ⇒
 * 读者一旦看到目标文件，内容必然完整（不存在"已创建但还没写完"的中间态）。
 * 用于 `exitcode.txt` / `log.format` 这类"出现即代表完成"的信号文件。
 */
export async function writeFileAtomic(file, text, encoding = 'utf8') {
  const tmp = file + '.tmp-' + process.pid
  try {
    await fsp.writeFile(tmp, text, encoding)
    await fsp.rename(tmp, file)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    await fsp.writeFile(file, text, encoding) // 兜底：目标被占用等情况下退回直写
  }
}

/** 去掉路径尾部反斜杠；盘符根路径（C:\）保留尾部 `\`。 */
export function strip(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  return /^[a-zA-Z]:$/.test(s) ? s + '\\' : s
}

/** 取错误信息，避免 `[object Object]`。 */
export function errorMsg(e) {
  return (e && e.message) || String(e)
}

/** 从 exitcode.txt 文本解析退出码；无数字返回 null。 */
export function parseExitCode(text) {
  const m = /(-?\d+)/.exec(String(text))
  return m ? Number(m[1]) : null
}

/** 内存 tail / 日志回读的字符上限（防止失控长日志撑爆面板状态）。 */
export const TAIL_CAP = 100 * 1024

// auto 收尾标记（v13）：host 在写 exitcode.txt 之前把本文件写成本目录下的 'utf8'，
// 表示日志已被重写成干净 UTF-8（不再含 28591 成像段）。
export const LOG_FORMAT_FILE = 'log.format'
export const LOG_FORMAT_UTF8 = 'utf8'

/**
 * auto 日志是否仍是**字节成像**（v13）：收尾重写成 UTF-8 的任务（`logFormat: 'utf8'`）
 * 不能再跑 decodeAutoText —— 纯 Latin-1 文本（`°±·`、`µm`）会被误判成成像段还原成乱码。
 * 无 logFormat（老任务 / 收尾未跑）= 成像，必须解码。
 */
export const isImagedAutoLog = (meta) => !!meta && meta.outputEncoding === 'auto' && meta.logFormat !== LOG_FORMAT_UTF8

// auto 收尾检测用的解码器（模块级缓存，懒创建）。
let autoUtf8Strict = null
let autoGbk = null

/**
 * auto 显示层解码族（v0.3.2；v12 增**末尾残片**处理）。主入口见 decodeAutoText，
 * 区块内的 utf8SeqLen / pendingUtf8Len / pendingGbkLen 只判「末尾写了一半」的序列。
 * 把文本中每个「字符全 ≤ U+00FF 且含 ≥1 个 ≥ U+0080」的极大连续段映射回字节
 * （charCode→byte，ISO-8859-1 成像的逆映射），先试**严格 UTF-8**（fatal），
 * 失败则按 **GBK（936）** 解码，替换回原文。纯函数、幂等：解码产物是 CJK/正常
 * 文本（不再含 U+0080-U+00FF 成像段）；输入无成像段（纯 ASCII/正常中文）原样返回。
 * 用途（仅当 meta.outputEncoding === 'auto' 时套用，见 registry/wait）：
 *   ① 运行中面板/wait 即时显示（此时日志文件还是字节成像，收尾检测尚未跑）；
 *   ② 任务被 kill（收尾块没跑）时文件永久停留在字节成像，显示层仍能还原。
 * ★ JS 侧 ANSI 兜底固定 'gbk'：插件目标环境 = 中文 Windows（PS 侧用
 *   CurrentCulture.TextInfo.ANSICodePage，本机即 936）。
 */
/** UTF-8 首字节声明的序列长度（非法首字节 ⇒ 0）。 */
const utf8SeqLen = (b) => (b >= 0xC2 && b <= 0xDF ? 2 : (b >= 0xE0 && b <= 0xEF ? 3 : (b >= 0xF0 && b <= 0xF4 ? 4 : 0)))
/** 末尾**写了一半**的 UTF-8 序列占几字节（0 = 无残片，含"整段就是一个残片"）。 */
const pendingUtf8Len = (bytes) => {
  // 从尾部往前找最后一个**首字节**（0x80-0xBF 只可能是续字节，不会误判）；
  // 其后若都是续字节且数量不足它声明的长度，则那段就是写了一半的序列。
  for (let start = bytes.length - 1; start >= 0 && bytes.length - start <= 3; start--) {
    const need = utf8SeqLen(bytes[start])
    if (need === 0) continue
    if (bytes.length - start - 1 >= need - 1) return 0
    for (let i = start + 1; i < bytes.length; i++) {
      if ((bytes[i] & 0xC0) !== 0x80) return 0
    }
    return bytes.length - start
  }
  return 0
}

/** 末尾悬空的 GBK 前导字节（0/1）——按 GBK 规则从头走一遍，避免把合法尾字节误判成前导。 */
const pendingGbkLen = (bytes) => {
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x81 || b === 0xFF) { i += 1; continue }
    if (i + 1 >= bytes.length) return 1
    const trail = bytes[i + 1]
    if (trail >= 0x40 && trail !== 0x7F && trail !== 0xFF) { i += 2; continue }
    i += 1
  }
  return 0
}

/**
 * auto 显示层解码：成像段先试**严格 UTF-8**，失败则丢末尾残片重试，最后 GBK 兜底。
 * 纯函数、幂等；用途见 registry / wait / watch 的 auto 闸门。
 */
export function decodeAutoText(text) {
  const s = String(text)
  if (!/[\x80-\xFF]/.test(s)) return s
  if (autoUtf8Strict === null) {
    autoUtf8Strict = new TextDecoder('utf-8', { fatal: true })
    autoGbk = new TextDecoder('gbk')
  }
  const decodeSpan = (seg) => {
    if (!/[\x80-\xFF]/.test(seg)) return seg
    const bytes = new Uint8Array(seg.length)
    for (let i = 0; i < seg.length; i++) bytes[i] = seg.charCodeAt(i) & 0xff
    // ① 完整 UTF-8
    try { return autoUtf8Strict.decode(bytes) } catch (e) { /* 继续 */ }
    // ② 末尾可能是**写了一半**的多字节序列（日志正在追加，读到半截）：丢掉残片再试。
    //    不丢就会落到 GBK 兜底 ⇒ 半个字符变成 `�`（auto 的 mid-character truncation）。
    const utf8Cut = pendingUtf8Len(bytes)
    if (utf8Cut > 0) {
      try { return autoUtf8Strict.decode(bytes.subarray(0, bytes.length - utf8Cut)) } catch (e) { /* 继续 */ }
    }
    // ③ GBK 兜底：同样丢掉末尾悬空的 GBK 前导字节（下一 tick 会补全）
    const gbkCut = pendingGbkLen(bytes)
    return autoGbk.decode(gbkCut > 0 ? bytes.subarray(0, bytes.length - gbkCut) : bytes)
  }
  // ★ 逐行判定（v11）：同一份日志里 PS 字符串（真 UTF-8）与 native 字节（成像）常常相邻，
  // 若把两行合成一段，strict UTF-8 一失败就整段回落 GBK，会把正常中文一起弄坏。
  // 换行字节（0x0D/0x0A）不可能是 UTF-8 续字节、也不是 GBK 尾字节 ⇒ 按行切分安全。
  // ★ 整行闸门（v15）：只有**整行字符都 ≤ U+00FF**（成像的必然特征）才做逆映射。
  // PS 写出的真 UTF-8 行只要含一个 > U+00FF 的字符（中文、℃ 等），就原样返回——
  // 否则该行里的 `°±·` 这类 Latin-1 文本会被当成成像，压成字节后按 GBK 还原成 `氨`。
  return s.split(/(\r\n|\n|\r)/).map((line) => (
    /[\x80-\xFF]/.test(line) && !/[^\x00-\xFF]/.test(line) ? line.replace(/[\x00-\xFF]+/g, decodeSpan) : line
  )).join('')
}

/**
 * 从长文本取尾部展示窗口（v12）。★ 切点必须在**行边界**：
 * `job.tail` 在 auto 下是 28591 成像文本（1 字节 = 1 字符），按字符窗口硬切会切在
 * 多字节字符中间，解码时就成了 `�`（auto 的 mid-character truncation，老版本遗留）。
 * 行首落点天然对齐：换行不是 UTF-8 续字节、也不是 GBK 尾字节。
 * 单行超长（无换行）时退回硬切——后续 decodeAutoText 会丢掉不完整残片。
 */
export function tailText(text, capChars) {
  const s = String(text == null ? '' : text)
  if (s.length <= capChars) return s
  const start = s.length - capChars
  const sliced = s.slice(start)
  if (s[start - 1] === '\n') return sliced
  const nl = sliced.indexOf('\n')
  return nl === -1 ? sliced : sliced.slice(nl + 1)
}

// ── 日志码页（v11：native 日志按 job.json 记录的实际码页解码）─────────────────

/**
 * Windows 码页 → WHATWG 解码器标签。认不出（如 OEM 437）回落 UTF-8：
 * 宁可显示乱码也不抛错——读取端永远不能因为码页问题打断面板/wait。
 */
export function codePageLabel(codePage) {
  const cp = Number(codePage)
  if (!Number.isFinite(cp) || cp <= 0 || cp === 65001) return 'utf-8'
  const known = {
    936: 'gbk', 54936: 'gb18030', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 874: 'windows-874',
  }
  if (known[cp] !== undefined) return known[cp]
  if (cp >= 1250 && cp <= 1258) return 'windows-' + cp
  return 'utf-8'
}

// 系统 ANSI 码页探测（模块级缓存；只读注册表，失败返回 0）。★ 不用 `chcp`：
// 有控制台的进程会报控制台码页（本机 65001），而计划任务无控制台 ⇒ 继承的是系统 ANSI 码页。
let cachedAnsiCodePage = null
export function probeAnsiCodePage() {
  if (cachedAnsiCodePage !== null) return cachedAnsiCodePage
  cachedAnsiCodePage = 0
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const m = /ACP\s+REG_SZ\s+(\d+)/i.exec(String(out))
    if (m) cachedAnsiCodePage = Number(m[1])
  } catch (e) { /* 探测失败 ⇒ 0（读取端回落 UTF-8，绝不打断） */ }
  return cachedAnsiCodePage
}

/** 丢掉整段字节末尾"写了一半"的序列（日志正在追加 / 进程被 kill 时常见）。 */
const trimPartialTail = (bytes, label) => {
  if (label === 'utf-8') {
    const cut = pendingUtf8Len(bytes)
    return cut > 0 ? bytes.subarray(0, bytes.length - cut) : bytes
  }
  if (label === 'gbk' || label === 'gb18030') {
    const cut = pendingGbkLen(bytes)
    return cut > 0 ? bytes.subarray(0, bytes.length - cut) : bytes
  }
  return bytes
}

/** 按 job 元数据解码整段日志字节：auto 追加成像还原（幂等），native 按 logCodePage。 */
export function decodeLogBuffer(buf, meta) {
  const m = meta || {}
  const label = codePageLabel(m.logCodePage)
  let text
  try {
    // v13：整段读取时末尾可能停在多字节中间（任务被 kill），先裁掉残片再解码，
    // 否则最后一个字符会变成 `�`（同 auto 的 mid-character truncation）。
    const view = Buffer.isBuffer(buf) || buf instanceof Uint8Array ? trimPartialTail(buf, label) : buf
    text = new TextDecoder(label).decode(view)
  } catch (e) {
    text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
  }
  return isImagedAutoLog(m) ? decodeAutoText(text) : text
}
