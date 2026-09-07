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
