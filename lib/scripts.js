// bgjobs —— 任务脚本/启动器生成（v0.1.61 结构重构自 lib/index.js 拆分）。
// 纯文本构建：run.bat / cmd.bat / run.ps1 / job.ps1 / launch.vbs 的逐行模板。
// 机制要点（实测，勿破坏）：
//   - bat 引擎用 `call cmd.bat >> log 2>&1` 整体重定向（逐行重定向破坏 for/if 块）；
//   - bat 开头 chcp 65001 保 UTF-8；末尾写 exitcode、自删任务；
//   - pwsh 引擎 /TR 直调解释器执行 run.ps1（& job.ps1 *> stdout.log、5.1 UTF-16 转
//     UTF-8、写 exitcode、自删任务）；
//   - bat 引擎经 wscript.exe + 纯 ASCII launch.vbs 隐藏窗口（零 PowerShell 依赖）。

import path from 'node:path'

/**
 * 生成任务 bat（run.bat）：用 `call cmd.bat >> log 2>&1` 整体重定向用户命令，
 * 避免逐行重定向破坏 for/if 等块结构；bat 开头 chcp 65001 保证日志 UTF-8；
 * 末尾写 exitcode 并自删任务计划。
 */
export function buildBat(job) {
  const cmdPath = job.meta.cmdPath || path.join(path.dirname(job.meta.jsonPath), 'cmd.bat')
  const lines = [
    '@echo off',
    '>nul chcp 65001',
    'cd /d "' + job.meta.workdir + '"',
    'call "' + cmdPath + '" >> "' + job.meta.logPath + '" 2>&1',
    'set "bgrc=%errorlevel%"',
    '>> "' + job.meta.logPath + '" echo [BGJOB] exit code: %bgrc%',
    '> "' + job.meta.exitcodePath + '" echo %bgrc%',
    'schtasks /Delete /TN ' + job.meta.taskName + ' /F >nul 2>&1',
  ]
  return lines.join('\r\n') + '\r\n'
}

/** 生成用户命令子 bat（cmd.bat）：命令原样保留（含空行/缩进），保证块结构正常解析。 */
export function buildCmdBat(job) {
  return String(job.meta.command).split(/\r?\n/).join('\r\n') + '\r\n'
}

/**
 * 生成 mcp 引擎的子 bat（cmd.bat）：一行调用 Node 执行 runner 跑本任务的 mcp.json。
 * mcp 引擎走 bat 管线（run.bat 整体重定向 + chcp 65001 + wscript 隐藏窗口）：零 PowerShell
 * 依赖，且 /TR 仍只有 wscript.exe "<launch.vbs>"（规避 v0.1.70 的 /TR 长度上限）；
 * Node 默认 UTF-8 输出，无需额外编码处理。路径均来自 meta（提交时烘焙绝对路径）。
 */
export function buildMcpCmdBat(job) {
  return '"' + job.meta.nodeExe + '" "' + job.meta.mcpRunnerPath + '" "' + job.meta.mcpSpecPath + '"\r\n'
}

/**
 * 解释器是否为 pwsh 7（判据 = 可执行文件 basename）。解释器由 resolveShell() 在**提交时**
 * 解析并烘焙进 meta.interpreter（lib/core/jobs.js），生成器只读不重新探测。
 * 拿不到 / 认不出 ⇒ 当 5.1 处理（fail-safe：宁可多写一行近零开销的编码设置，
 * 也不能漏——5.1 的 `*>` 产物是 UTF-16LE）。
 * ★ 风险声明更正（v0.1.95 实测）：非 Store 版（MSI/zip）pwsh 7 可能继承 OEM 控制台代码页，
 * 而 **pwsh 7 只在 stdout 被重定向时才强制 UTF-8；进程拥有控制台时它保留继承的代码页**
 * （schtasks / `-WindowStyle Hidden` 启动下实测 CodePage = 936）⇒ 原句「pwsh 7 启动即把
 * [Console]::OutputEncoding 设为 UTF-8」在真任务里**不成立**（详见 buildPwshRunner 的更正）。
 */
function isPwsh7Interpreter(interpreter) {
  const baseName = String(interpreter === undefined || interpreter === null ? '' : interpreter).split(/[\\/]/).pop().toLowerCase()
  return baseName === 'pwsh' || baseName === 'pwsh.exe'
}

/**
 * 编码 preamble（run.ps1 / job.ps1 共用判据）：仅 Windows PowerShell 5.1 需要。
 * v0.1.92 起 pwsh 7 整段跳过（默认 UTF-8，写了是纯开销）。
 */
function needsEncodingPreamble(interpreter) {
  return !isPwsh7Interpreter(interpreter)
}

/**
 * 生成 pwsh 引擎的任务包装脚本（run.ps1）：schtasks /TR 直接调用 PowerShell 执行
 * 本脚本（不再经过 cmd 的 run.bat），由它完成输出重定向（& job.ps1 *> stdout.log）、
 * 写 exitcode.txt、自删任务计划。退出码取 $LASTEXITCODE（exit N 或原生命令退出码），
 * try/catch 兜底保证 exitcode.txt 一定写入（任务不会卡 running）；5.1 的 *> 输出
 * UTF-16LE（BOM FF FE），检测到即转 UTF-8（pwsh 7 已是 UTF-8，跳过）。
 * ★ 这里是**乱码兜底的真身**：5.1 产物由下面的 FF FE 检测转换纠正（实测与是否设置
 * 控制台代码页无关，字节完全相同）。v0.1.92 删掉了 `Add-Type … SetConsoleOutputCP`
 * （纯开销、零语义，见 buildPs1 注释），并按解释器条件化编码 preamble。
 * ★★ v0.1.92 定论更正（v0.1.95 实测，按新事实理解）：
 *   ① **pwsh 7 只在 stdout 被重定向时才强制 UTF-8；进程拥有控制台时它保留继承的代码页**
 *      （schtasks / `-WindowStyle Hidden` / `CreateNoWindow` 启动 ⇒
 *      `[Console]::OutputEncoding.CodePage = 936`）⇒ v0.1.92 那句「pwsh 7 启动即 UTF-8」
 *      在真任务里**不成立**：native 子进程（node）输出的 UTF-8 中文被按 936 解码成乱码
 *      （错位码点 38171,22562,23277,… → 修复后 65288,29420,31435,27169,24335,32,47,32,115…,65289
 *      =「（独立模式 / standalone）」）。
 *      注意实验方法：直接 `pwsh -NoProfile -NonInteractive -File run.ps1` **不复现**该 bug
 *      （该启动方式下 stdout 被重定向 ⇒ pwsh 反而设成 65001）；复现必须走 schtasks 或
 *      `CreateNoWindow` / `-WindowStyle Hidden` 等"进程拥有控制台"的启动。
 *   ② 修复 = 在 `*>` **之前**加一行 `try { [Console]::OutputEncoding = $utf8 } catch { }`：
 *      **`&` 是 call operator ⇒ job.ps1 与它拉起的 native node 与 run.ps1 同进程 ⇒
 *      编码只需在 runner 里设一次**（复用已定义的 $utf8，不重复 new）——这就是净成本 ≈ 0
 *      的原因：实测 A 中位数 419.6 ms / B 411.3 ms；剔首轮热身 A 404.3 / B 404.6 ⇒ Δ=+0.3 ms
 *      （噪声级）。该行在 5.1 下与上方 preamble 幂等（同一个 $utf8），两种解释器的产物都含它。
 *   ③ `Add-Type … SetConsoleOutputCP(65001)` 仍是**禁选**（+0.6 s/次、对 `*>` 产物零语义，
 *      见 buildPs1 注释）——本方案不碰它。
 * 沙箱任务（job.meta.sandbox 非 off）：外层（完整 token）保持重定向/exitcode/自删，
 * 仅"用户命令"经 sandbox-windows-acl 独立 runner 包装（--workspace=workdir、
 * --temp=sandbox 私有根、--mode 受限模式，子命令=解释器 -File job.ps1）；受限子进程
 * 经外层已打开句柄输出，退出码经 runner 镜像 → $LASTEXITCODE 语义不变。
 * ★ 落盘自己的 pid（B1 修复，沙箱与非沙箱都写）：第一件事写 `<jobDir>\run.pid` = 本进程
 * `$PID`，也就是 **schtasks 任务根**。删任务时据此 `taskkill /PID <pid> /T /F` 才能杀穿
 * 后代（`schtasks /End` 够不到 node runner 与受限子进程，见 lib/kill-tree.js）。
 * 写入必须 try/catch 兜住：pid 文件写失败绝不能拦住用户命令（否则任务永远停在 running）。
 * ★ 两处镜像必须一致：tools/dsh-bgjobs-lib.ps1 的 New-BgjobsPwshRunner（模板用 __JOBDIR__）。
 */
export function buildPwshRunner(job) {
  const jobDir = path.dirname(job.meta.jsonPath)
  const scriptPath = job.meta.scriptPath || path.join(jobDir, 'job.ps1')
  const sandbox = job.meta.sandbox && job.meta.sandbox !== 'off' ? job.meta.sandbox : undefined
  const runLine = sandbox
    ? "& '" + job.meta.nodeExe + "' '" + job.meta.sandboxRunnerPath + "' --workspace '" + job.meta.workdir
      + "' --temp '" + job.meta.sandboxTempPath + "' --mode " + sandbox + " '--' '" + job.meta.interpreter
      + "' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '" + scriptPath + "' *> $logPath"
    : "    & '" + scriptPath + "' *> $logPath"
  const lines = [
    '# bgjobs pwsh runner: 重定向 + exitcode + 自删任务计划',
    // ★ 任务根 pid 落盘（B1）：$PID = 本 run.ps1 进程 = schtasks 任务根 = taskkill /T 的树根。
    "$pidPath = '" + jobDir + "\\run.pid'",
    'try { [System.IO.File]::WriteAllText($pidPath, [string]$PID, (New-Object System.Text.UTF8Encoding($false))) } catch { }',
    // 编码 preamble：仅 5.1（pwsh 7 默认 UTF-8）。v0.1.92 起这里是唯一一行，且已删 Add-Type。
    ...(needsEncodingPreamble(job.meta.interpreter)
      ? ['try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }']
      : []),
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    "Set-Location -LiteralPath '" + job.meta.workdir + "'",
    "$logPath = '" + job.meta.logPath + "'",
    '$code = 0',
    'try {',
    // ★ 乱码兜底（v0.1.95，见上面 buildPwshRunner 注释）：`& job.ps1` 是同进程调用
    // （call operator）⇒ 在 `*>` **之前**用已定义的 $utf8 设一次 [Console]::OutputEncoding，
    // job.ps1 与它拉起的 native 子进程（node 等）的输出解码都跟着走 UTF-8。
    '    try { [Console]::OutputEncoding = $utf8 } catch { }',
    runLine,
    '    if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }',
    '} catch {',
    '    $code = 1',
    "    [System.IO.File]::AppendAllText($logPath, '[BGJOB] error: ' + $_.Exception.Message + [Environment]::NewLine, $utf8)",
    '}',
    'if (Test-Path -LiteralPath $logPath) {',
    '    $logBytes = [System.IO.File]::ReadAllBytes($logPath)',
    '    if ($logBytes.Length -ge 2 -and $logBytes[0] -eq 0xFF -and $logBytes[1] -eq 0xFE) {',
    '        [System.IO.File]::WriteAllText($logPath, [System.IO.File]::ReadAllText($logPath, [System.Text.Encoding]::Unicode), $utf8)',
    '    }',
    '}',
    "[System.IO.File]::AppendAllText($logPath, '[BGJOB] exit code: ' + $code + [Environment]::NewLine, $utf8)",
    "[System.IO.File]::WriteAllText('" + job.meta.exitcodePath + "', [string]$code, $utf8)",
    "& schtasks /Delete /TN '" + job.meta.taskName + "' /F *> $null",
  ]
  return lines.join('\r\n') + '\r\n'
}

/**
 * 生成 bat 引擎的隐藏启动器（launch.vbs）：/TR 改为 wscript.exe 执行本脚本，以隐藏窗口
 * （SW_HIDE=0）启动同目录的 run.bat 并等待（True）。wscript 是 GUI 子系统（无控制台窗口），
 * Windows 全系自带——bat 引擎保持零 PowerShell 依赖。模板纯 ASCII：路径运行时由 FSO 从
 * 自身目录（jobDir）推导，不内嵌任何路径/中文（.vbs 无 BOM 按 ANSI 读，内嵌中文路径会乱码）。
 */
export function buildLaunchVbs() {
  return [
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'sh.Run """" & dir & "\\run.bat""", 0, True',
  ].join('\r\n') + '\r\n'
}

/**
 * 生成 pwsh 用户命令脚本（job.ps1）：编码 preamble（**仅 5.1**，v0.1.92 起）+ 用户命令
 * 原样（CRLF 归一）。
 * **为什么不再需要 Add-Type（v0.1.92 定论；理由在 v0.1.95 更正）**：曾有一行
 * `Add-Type … SetConsoleOutputCP(65001)`，每次进程启动都要现编译一段 C#——实测
 * addtype-only 1356 ms vs 裸 649/693 ms，即 **+0.6 s/次**（run.ps1 + job.ps1 各一次
 * ⇒ 每任务约 1.1 s），是沙箱 pwsh 任务启动耗时的主要来源；而它对 5.1 的 `*>` 产物
 * **零语义**（带/不带该行的产物字节完全相同，都是 FF FE UTF-16LE）。真正救回乱码的是
 * run.ps1 的 FF FE 检测转换（见本文件 buildPwshRunner）。**该禁选结论不变，本方案不碰它。**
 * 留下的 [Console]::OutputEncoding 只对 5.1 有意义（重定向默认 UTF-16LE）；
 * $OutputEncoding 保证 5.1 下用户命令管道传给原生工具的字符串按 UTF-8 编码（5.1 默认
 * ASCII）。★ 更正（v0.1.95）：pwsh 7 **并非**「启动即 UTF-8」——它只在 stdout 被重定向时
 * 强制 UTF-8，进程拥有控制台时（schtasks / `-WindowStyle Hidden`）保留继承的代码页
 * （实测 CodePage = 936）。job.ps1 之所以仍可整段跳过：**`& job.ps1` 是 call operator、
 * 与 run.ps1 同进程**，而 run.ps1 已在 `*>` 之前设过一次 [Console]::OutputEncoding
 * （见 buildPwshRunner 的乱码修复），job.ps1 与其拉起的 native 子进程直接继承 ⇒ 无需在
 * 这里重复设置。不设置 $ErrorActionPreference，保持默认语义。
 */
export function buildPs1(job) {
  const preambleLines = needsEncodingPreamble(job.meta.interpreter)
    ? [
      '# bgjobs: 强制 UTF-8 输出（Windows PowerShell 5.1 重定向默认 UTF-16 会乱码）',
      'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    ]
    : []
  const preamble = preambleLines.join('\r\n')
  const head = preamble.length > 0 ? preamble + '\r\n' : ''
  return head + String(job.meta.command).split(/\r?\n/).join('\r\n') + '\r\n'
}
