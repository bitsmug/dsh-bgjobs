// bgjobs exec —— 命令信封（spec v7 §4.8 / I10）。
//
// 旧布局里编码成像（28591 / UTF-8）与退出码收尾由 run.ps1 / run.bat 承担；新布局工作区
// 没有可执行脚本，这两件事改由本模块的**确定性纯函数**生成、经 `-EncodedCommand` /
// `cmd /c` 交付。`direct` / `b=acl` 在 host 运行期调用；`b=dsh` 在提交期调用后再交给
// `confine()`，保证两条路径字节级一致。
//
// 记录文件 cmd.ps1 / cmd.bat 写**命令 + env 前缀**（不含信封），供人阅读与复制重跑。

const CRLF = '\r\n'

/** 解释器是否为 pwsh 7（判据 = 可执行文件 basename；认不出按 5.1 处理，fail-safe）。 */
function isPwsh7(interpreter) {
  const base = String(interpreter === undefined || interpreter === null ? '' : interpreter)
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
  return base === 'pwsh' || base === 'pwsh.exe'
}

/** 归一编码取值；未知/缺省按当前默认 auto。 */
function normalizeEncoding(value) {
  if (value === 'utf8' || value === 'native') return value
  return 'auto'
}

/** 原始命令按 CRLF 归一（信封内联交付，不依赖文件换行）。 */
function bodyLines(rawCommand) {
  return String(rawCommand).split(/\r?\n/)
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const psSingleQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'"

/**
 * 用户 env → 命令前缀（§4.3，v0.4 起 env 不再是进程环境注入）。
 *
 * 沙箱约束的是**进程初始环境**与可写根，`confine()` 的 policy 也没有 temp 字段——
 * 任何后端（acl 的私有 temp、mxc/容器自己的 /tmp）都可能在 spawn 前重写 TMP/TEMP。
 * 把 env 渲染成用户命令**前面的一行赋值**，就让"用户意志"永远最后生效：脚本内改环境
 * 之后派生的一切进程都继承它，三条链路（direct / acl / dsh）行为一致，且不依赖后端能力。
 *
 * 空的字符串值 ⇒ PowerShell 的 `$env:X = ''` 会删除该变量（与原语义一致）。
 * 键名/值类型/换行是**入参错误**，提交期 fail loud（不再静默剔除）。
 *
 * @param {'pwsh'|'bat'} engine - 目标引擎的语法
 * @param {object|undefined|null} env - 提交期的原始 env 对象
 * @returns {string} 以 CRLF 结尾的前缀；空 env 返回 ''
 */
export function buildEnvPrefix(engine, env) {
  if (env === undefined || env === null) return ''
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('env: expected an object mapping variable names to values')
  }
  const lines = []
  for (const key of Object.keys(env)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error('env: invalid variable name "' + key + '" (expected [A-Za-z_][A-Za-z0-9_]*)')
    }
    const value = env[key]
    if (value === undefined || value === null) continue
    const type = typeof value
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new Error('env: value for "' + key + '" must be a string, number or boolean')
    }
    const text = String(value)
    if (/[\r\n]/.test(text)) throw new Error('env: value for "' + key + '" must not contain a line break')
    if (engine === 'bat') {
      if (text.includes('"')) throw new Error('env: value for "' + key + '" must not contain a double quote (bat syntax)')
      lines.push('set "' + key + '=' + text + '"')
    } else {
      lines.push('$env:' + key + ' = ' + psSingleQuote(text))
    }
  }
  return lines.length === 0 ? '' : lines.join(CRLF) + CRLF
}

/**
 * PowerShell 信封：编码 preamble + `& { <原始命令> } 2>&1` + 退出码收尾。
 *
 * 编码口径（v0.4 起与旧 run.ps1 有一处**必要差异**）：新链路里子进程的 stdout/stderr
 * 是 task host 打开的**文件句柄**（I12，受限令牌下不能建管道），PowerShell 自己的输出
 * 直接经 Console.Out 落盘，不再有 `*>` 的 Out-File 包装 ⇒ Console.OutputEncoding 同时
 * 决定"PS 原生字符串怎么编码"和"native 输出怎么解码"。若直接把它设成 28591，PS 自己的
 * 中文会被压成 `?`（不可逆）。因此 auto 用**显式 UTF-8 写入器**把两者拆开（v11）：
 *   - `[Console]::OutputEncoding = 28591` 只负责"native 字节 → U+00XX 成像"（无损）；
 *   - PS 字符串（含 Write-Host / 格式化对象）经 `StreamWriter(OpenStandardOutput(), UTF-8)`
 *     落盘（`[Console]::SetOut` 让宿主 UI 也走它）⇒ 成像字符以 UTF-8 文本保存，可逆。
 * 收尾由 host 在写 exitcode 之前调用 decodeAutoText 重写为干净 UTF-8（§4.4 第 7 步）。
 *   utf8  ⇒ 强制 UTF-8（PS 原生中文与 UTF-8 native 工具都正确）；
 *   native ⇒ 按继承码页（若已是 65001 则退到系统 ANSI 码页），保留 GBK 类工具。
 * `2>&1` 在脚本内合并错误流，避免 PowerShell 把 Write-Error 序列化成 CLIXML 写到 fd。
 * `$LASTEXITCODE` 为 null（纯 PowerShell 命令）⇒ 0；抛异常 ⇒ 1。
 */
export function buildPwshEnvelope(rawCommand, options = {}) {
  const encoding = normalizeEncoding(options.encoding)
  const interpreter = options.interpreter
  const auto = encoding === 'auto'
  const lines = []
  // 5.1 的 `*>`/重定向产物默认 UTF-16LE：先强制 UTF-8（pwsh 7 已是 UTF-8，跳过）。
  if (!isPwsh7(interpreter)) {
    lines.push('# bgjobs: 强制 UTF-8 输出（Windows PowerShell 5.1 重定向默认 UTF-16 会乱码）')
    lines.push('try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }')
    lines.push('$OutputEncoding = [System.Text.UTF8Encoding]::new($false)')
  }
  if (encoding === 'native') {
    // 必须在任何覆盖之前取继承码页；继承值就是 65001 时退到系统 ANSI 码页（否则 native 等价 utf8）。
    lines.push('$bgjobNative = [Console]::OutputEncoding')
    lines.push('if ($bgjobNative.CodePage -eq 65001) { $bgjobNative = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage) }')
  }
  // 重定向到文件时剥掉 ANSI 颜色（否则日志里全是 ESC 序列）。pwsh 7 才有 $PSStyle。
  if (isPwsh7(interpreter)) lines.push('try { $PSStyle.OutputRendering = \'PlainText\' } catch { }')
  lines.push('$bgjobUtf8 = New-Object System.Text.UTF8Encoding($false)')
  if (auto) {
    // PS 自己的输出（含 Write-Host / Write-Warning / 格式化对象）走显式 UTF-8 写入器，
    // 与 native 的 28591 成像解耦（见函数头）。写入器与 fd 共用同一文件句柄。
    lines.push('$bgjobOut = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $bgjobUtf8)')
    lines.push('$bgjobOut.AutoFlush = $true')
    lines.push('$bgjobStreamed = $false')
    lines.push('try { [Console]::SetOut($bgjobOut); $bgjobStreamed = $true } catch { }')
  }
  lines.push('$bgjobExit = 0')
  lines.push('try {')
  if (encoding === 'native') {
    lines.push('    try { [Console]::OutputEncoding = $bgjobNative } catch { }')
  } else if (auto) {
    lines.push('    try { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(28591) } catch { }')
  } else {
    lines.push('    try { [Console]::OutputEncoding = $bgjobUtf8 } catch { }')
  }
  lines.push('    & {')
  for (const line of bodyLines(rawCommand)) lines.push(line)
  lines.push('    } 2>&1 | ForEach-Object {')
  // 把 ErrorRecord 就地渲染成单行文本：stdout/stderr 是同一个文件句柄时，PowerShell 会把
  // 错误流按 CLIXML（`#< CLIXML ...`）序列化到 fd，日志不可读；在脚本内消费掉就不会外泄。
  if (auto) {
    lines.push('      if ($_ -is [System.Management.Automation.ErrorRecord]) { $bgjobOut.WriteLine(\'Write-Error: \' + $_.Exception.Message) }')
    lines.push('      elseif ($_ -is [string]) { $bgjobOut.WriteLine([string]$_) }')
    lines.push('      else { foreach ($bgjobLine in @($_ | Out-String -Stream)) { $bgjobOut.WriteLine([string]$bgjobLine) } }')
  } else {
    lines.push("      if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Output ('Write-Error: ' + $_.Exception.Message) } else { $_ }")
  }
  lines.push('    }')
  lines.push('    if ($null -ne $LASTEXITCODE) { $bgjobExit = $LASTEXITCODE }')
  lines.push('} catch {')
  lines.push('    $bgjobExit = 1')
  if (auto) {
    lines.push("    try { if ($bgjobStreamed) { $bgjobOut.WriteLine('[BGJOB] error: ' + $_.Exception.Message) } else { [Console]::Error.WriteLine('[BGJOB] error: ' + $_.Exception.Message) } } catch { }")
  } else {
    lines.push("    [Console]::Error.WriteLine('[BGJOB] error: ' + $_.Exception.Message)")
  }
  lines.push('}')
  if (auto) lines.push('try { $bgjobOut.Flush(); $bgjobOut.Dispose() } catch { }')
  lines.push('exit $bgjobExit')
  return lines.join(CRLF) + CRLF
}

/**
 * cmd 信封：`@echo off` +（仅 utf8）`chcp 65001` + 原始命令 + `exit /b %errorlevel%`。
 * native/auto 不改代码页（bat 继承宿主码页，输出按原始字节落盘）。
 */
export function buildBatEnvelope(rawCommand, options = {}) {
  const encoding = normalizeEncoding(options.encoding)
  const lines = ['@echo off']
  if (encoding === 'utf8') lines.push('>nul chcp 65001')
  for (const line of bodyLines(rawCommand)) lines.push(line)
  lines.push('exit /b %errorlevel%')
  return lines.join(CRLF) + CRLF
}

/** PowerShell `-EncodedCommand` 载荷：UTF-16LE + base64。 */
export function encodePwshCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/** 解释器 + 交付参数（`direct` / `b=acl` 共用；`b=dsh` 在提交期由同一函数生成后交给 confine）。 */
export function buildPwshDelivery({ interpreter, envelope }) {
  return [interpreter, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePwshCommand(envelope)]
}

/** cmd 交付参数：`/d /c "<信封>"`。 */
export function buildBatDelivery({ envelope }) {
  return ['/d', '/c', '"' + String(envelope).replace(/"/g, '""') + '"']
}
