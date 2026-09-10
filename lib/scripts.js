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
 * 生成 pwsh 引擎的任务包装脚本（run.ps1）：schtasks /TR 直接调用 PowerShell 执行
 * 本脚本（不再经过 cmd 的 run.bat），由它完成输出重定向（& job.ps1 *> stdout.log）、
 * 写 exitcode.txt、自删任务计划。退出码取 $LASTEXITCODE（exit N 或原生命令退出码），
 * try/catch 兜底保证 exitcode.txt 一定写入（任务不会卡 running）；5.1 的 *> 输出
 * UTF-16LE（BOM FF FE），检测到即转 UTF-8（pwsh 7 已是 UTF-8，跳过）。
 * 沙箱任务（job.meta.sandbox 非 off）：外层（完整 token）保持重定向/exitcode/自删，
 * 仅"用户命令"经 sandbox-windows-acl 独立 runner 包装（--workspace=workdir、
 * --temp=sandbox 私有根、--mode 受限模式，子命令=解释器 -File job.ps1）；受限子进程
 * 经外层已打开句柄输出，退出码经 runner 镜像 → $LASTEXITCODE 语义不变。
 */
export function buildPwshRunner(job) {
  const scriptPath = job.meta.scriptPath || path.join(path.dirname(job.meta.jsonPath), 'job.ps1')
  const sandbox = job.meta.sandbox && job.meta.sandbox !== 'off' ? job.meta.sandbox : undefined
  const runLine = sandbox
    ? "& '" + job.meta.nodeExe + "' '" + job.meta.sandboxRunnerPath + "' --workspace '" + job.meta.workdir
      + "' --temp '" + job.meta.sandboxTempPath + "' --mode " + sandbox + " '--' '" + job.meta.interpreter
      + "' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '" + scriptPath + "' *> $logPath"
    : "    & '" + scriptPath + "' *> $logPath"
  const lines = [
    '# bgjobs pwsh runner: 重定向 + exitcode + 自删任务计划',
    'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
    "try { Add-Type -Namespace BgjobsCon -Name ConCp -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern bool SetConsoleOutputCP(uint w);[DllImport(\"kernel32.dll\")]public static extern bool SetConsoleCP(uint w);' -ErrorAction SilentlyContinue; [void][BgjobsCon.ConCp]::SetConsoleOutputCP(65001); [void][BgjobsCon.ConCp]::SetConsoleCP(65001) } catch { }",
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    "Set-Location -LiteralPath '" + job.meta.workdir + "'",
    "$logPath = '" + job.meta.logPath + "'",
    '$code = 0',
    'try {',
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
 * 生成 pwsh 用户命令脚本（job.ps1）：编码 preamble + 用户命令原样（CRLF 归一）。
 * [Console]::OutputEncoding 决定进程 stdout 重定向到文件时的字节编码：
 * Windows PowerShell 5.1 重定向默认 UTF-16LE，设为 UTF-8 后日志与插件读取一致；
 * pwsh 7 默认已是 UTF-8，设置无副作用。$OutputEncoding 保证用户命令管道传给
 * 原生工具的字符串按 UTF-8 编码。不设置 $ErrorActionPreference，保持默认语义。
 */
export function buildPs1(job) {
  const preamble = [
    '# bgjobs: 强制 UTF-8 输出（Windows PowerShell 5.1 重定向默认 UTF-16 会乱码）',
    'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
    "try { Add-Type -Namespace BgjobsCon -Name ConCp -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern bool SetConsoleOutputCP(uint w);[DllImport(\"kernel32.dll\")]public static extern bool SetConsoleCP(uint w);' -ErrorAction SilentlyContinue; [void][BgjobsCon.ConCp]::SetConsoleOutputCP(65001); [void][BgjobsCon.ConCp]::SetConsoleCP(65001) } catch { }",
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  ].join('\r\n')
  return preamble + '\r\n' + String(job.meta.command).split(/\r?\n/).join('\r\n') + '\r\n'
}
