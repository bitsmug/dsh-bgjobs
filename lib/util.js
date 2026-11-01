// bgjobs —— 纯字符串/退出码工具（v0.1.61 结构重构自 lib/index.js 拆分）。

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

// auto 收尾检测用的解码器（模块级缓存，懒创建）。
let autoUtf8Strict = null
let autoGbk = null

/**
 * auto 编码任务的**显示层解码**（v0.3.2）：与 run.ps1 收尾检测块**同一口径**——
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
export function decodeAutoText(text) {
  const s = String(text)
  if (!/[\x80-\xFF]/.test(s)) return s
  if (autoUtf8Strict === null) {
    autoUtf8Strict = new TextDecoder('utf-8', { fatal: true })
    autoGbk = new TextDecoder('gbk')
  }
  return s.replace(/[\x00-\xFF]+/g, (seg) => {
    if (!/[\x80-\xFF]/.test(seg)) return seg
    const bytes = new Uint8Array(seg.length)
    for (let i = 0; i < seg.length; i++) bytes[i] = seg.charCodeAt(i) & 0xff
    try { return autoUtf8Strict.decode(bytes) } catch (e) { return autoGbk.decode(bytes) }
  })
}
