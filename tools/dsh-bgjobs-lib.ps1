﻿# dsh-bgjobs-lib.ps1 - shared logic for the bgjobs offline management CLI.
# Dot-source this from dsh-bgjobs.ps1 (CLI). Works WITHOUT DSH running:
# reads/writes the same job.json / stdout.log / exitcode.txt files and the
# same central index ($DSH_HOME/bgjobs/index.json) as the bgjobs DSH plugin.
#
# Store layout (mirrors lib/index.js of the bgjobs plugin):
#   - Jobs live at <workdir>/.dsh/bgjobs/<jobId>/  (job.json, stdout.log,
#     exitcode.txt, run.bat) — the durable source of truth. State is ALWAYS
#     read live from job.json; the central index is only a "map" (jobId ->
#     jobDir) so the offline tool can locate jobs scattered across workspaces.
#   - Central index: $DSH_HOME/bgjobs/index.json
#     DSH_HOME env var, fallback ~/.dsh — same rule as harness resolveDshHome.
#
# MUST-MIRROR notes (keep in sync with lib/index.js):
#   - New-BgjobsBat must behave identically to buildBat() in lib/index.js
#     (same cmd trap: `> file echo %var%` for numeric vars).
#   - Read-BgjobsJobJson must parse the same job.json fields the plugin writes.
#   - job.json timestamps are UNIX MILLISECONDS (Date.now() in the plugin);
#     do NOT write ISO strings or the offline tool misreads plugin-written jobs.

$script:BgjobsHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$script:BgjobsIndexPath = Join-Path $script:BgjobsHome 'bgjobs\index.json'
$script:BgjobsSchtasks = Join-Path ($env:SystemRoot) 'System32\schtasks.exe'

# Unix milliseconds, matching Date.now() in the plugin.
function Get-BgjobsNowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# Parse a job.json timestamp (UNIX ms from the plugin) into UTC DateTime.
# Returns $null when absent/unparseable.
function ConvertFrom-BgjobsTimeMs([object]$Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [long] -or $Value -is [int] -or ($Value -is [string] -and $Value -match '^\d+$')) {
        try { return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Value).UtcDateTime } catch { return $null }
    }
    try { return ([datetime]::Parse([string]$Value)).ToUniversalTime() } catch { return $null }
}

# ── path helpers (mirror strip() in lib/index.js) ─────────────────────────
# Strip trailing slashes; keep the trailing `\` for a drive root (C:\).
function Convert-BgjobsPathStrip([string]$Path) {
    $s = [string]$Path
    $s = $s.TrimEnd('\', '/')
    if ($s -match '^[a-zA-Z]:$') { return "$s\" }
    return $s
}

# ── central index ─────────────────────────────────────────────────────────
function Get-BgjobsIndex {
    if (-not (Test-Path -LiteralPath $script:BgjobsIndexPath)) {
        return @{ version = 1; updatedAt = 0; jobs = @() }
    }
    try {
        $raw = Get-Content -LiteralPath $script:BgjobsIndexPath -Raw -Encoding UTF8
        $parsed = $raw | ConvertFrom-Json
        if (-not $parsed -or $null -eq $parsed.jobs -or -not ($parsed.jobs -is [System.Array])) {
            return @{ version = 1; updatedAt = 0; jobs = @() }
        }
        return @{ version = 1; updatedAt = 0; jobs = @($parsed.jobs) }
    } catch {
        return @{ version = 1; updatedAt = 0; jobs = @() }
    }
}

# Scan known workdirs for .dsh/bgjobs/<id>/job.json and rewrite the index.
function Write-BgjobsIndexRebuild([string[]]$Workdirs) {
    $jobs = @()
    foreach ($raw in $Workdirs) {
        $workdir = Convert-BgjobsPathStrip $raw
        if (-not $workdir) { continue }
        $jobsDir = Join-Path $workdir '.dsh\bgjobs'
        if (-not (Test-Path -LiteralPath $jobsDir)) { continue }
        foreach ($n in Get-ChildItem -LiteralPath $jobsDir -Directory -Force -ErrorAction SilentlyContinue) {
            $jsonPath = Join-Path $n.FullName 'job.json'
            if (-not (Test-Path -LiteralPath $jsonPath)) { continue }
            try {
                $meta = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if (-not $meta.id -or -not $meta.logPath) { continue }
                $jobs += [pscustomobject]@{
                    id = $meta.id
                    jobDir = if ($meta.jobDir) { $meta.jobDir } else { $n.FullName }
                    workdir = $workdir
                    name = if ($meta.name) { $meta.name } else { $meta.id }
                    createdBySession = if ($meta.createdBySession) { $meta.createdBySession } else { '' }
                    createdAt = if ($meta.createdAt) { $meta.createdAt } else { 0 }
                }
            } catch { }
        }
    }
    $jobs = @($jobs | Sort-Object createdAt)
    $payload = @{ version = 1; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); jobs = $jobs }
    New-Item -ItemType Directory -Force -Path (Split-Path $script:BgjobsIndexPath -Parent) | Out-Null
    $json = $payload | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($script:BgjobsIndexPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    return $payload
}

# ── job discovery: index map -> live job.json ─────────────────────────────
function Get-BgjobsJobs {
    $idx = Get-BgjobsIndex
    $out = @()
    foreach ($entry in $idx.jobs) {
        if (-not $entry.id -or -not $entry.jobDir) { continue }
        $jobJson = Join-Path $entry.jobDir 'job.json'
        if (-not (Test-Path -LiteralPath $jobJson)) { continue }
        try {
            $meta = Get-Content -LiteralPath $jobJson -Raw -Encoding UTF8 | ConvertFrom-Json
            # 状态对账：任务实际已完成（exitcode.txt 已落盘）但 job.json 仍为 running 时，
            # 说明进程已结束、仅元数据未更新（历史竞态或宿主未写回），此处理性显示为 done。
            $exitcodePath = if ($meta.exitcodePath) { $meta.exitcodePath } else { Join-Path $entry.jobDir 'exitcode.txt' }
            $liveStatus = if ($meta.status) { $meta.status } else { 'unknown' }
            $exitCode = if ($null -ne $meta.exitCode) { $meta.exitCode } else { $null }
            if ($liveStatus -eq 'running' -and (Test-Path -LiteralPath $exitcodePath)) {
                $liveStatus = 'done'
                if ($null -eq $exitCode) {
                    $exitCode = ConvertFrom-BgjobsExitCode ([System.IO.File]::ReadAllText($exitcodePath))
                }
            }
            $out += [pscustomobject]@{
                id = $meta.id
                name = if ($meta.name) { $meta.name } else { $entry.name }
                status = $liveStatus
                exitCode = $exitCode
                workdir = if ($meta.workdir) { $meta.workdir } else { $entry.workdir }
                jobDir = $entry.jobDir
                logPath = if ($meta.logPath) { $meta.logPath } else { Join-Path $entry.jobDir 'stdout.log' }
                exitcodePath = $exitcodePath
                createdAt = if ($meta.createdAt) { $meta.createdAt } else { 0 }
                finishedAt = if ($meta.finishedAt) { $meta.finishedAt } else { $null }
                taskName = if ($meta.taskName) { $meta.taskName } else { '' }
                createdBySession = if ($meta.createdBySession) { $meta.createdBySession } else { $entry.createdBySession }
            }
        } catch { }
    }
    return @($out | Sort-Object createdAt)
}

function Get-BgjobsJob([string]$Id) {
    foreach ($j in (Get-BgjobsJobs)) { if ($j.id -eq $Id) { return $j } }
    return $null
}

# ── bat generation (MUST mirror buildBat() in lib/index.js; v0.1.8: cmd.bat + call + chcp 65001) ──
function New-BgjobsBat([object]$Job) {
    $cmdPath = if ($Job.meta.cmdPath) { $Job.meta.cmdPath } else { Join-Path (Split-Path $Job.meta.jsonPath -Parent) 'cmd.bat' }
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('@echo off')
    $lines.Add('>nul chcp 65001')
    $lines.Add('cd /d "' + $Job.meta.workdir + '"')
    $lines.Add('call "' + $cmdPath + '" >> "' + $Job.meta.logPath + '" 2>&1')
    $lines.Add('set "bgrc=%errorlevel%"')
    $lines.Add('>> "' + $Job.meta.logPath + '" echo [BGJOB] exit code: %bgrc%')
    $lines.Add('> "' + $Job.meta.exitcodePath + '" echo %bgrc%')
    $lines.Add('schtasks /Delete /TN ' + $Job.meta.taskName + ' /F >nul 2>&1')
    return (($lines -join "`r`n") + "`r`n")
}

# ── user command sub-bat (MUST mirror buildCmdBat() in lib/index.js; v0.1.8) ──
# 命令原样保留（含空行/缩进），保证 for/if 块结构正常解析。
function New-BgjobsCmdBat([object]$Job) {
    return (([string]$Job.meta.command -split "\r?\n") -join "`r`n") + "`r`n"
}

# ── bat engine hidden launcher (MUST mirror buildLaunchVbs() in lib/index.js) ──
# 纯 ASCII 模板：/TR 经 wscript.exe 执行本脚本，SW_HIDE（0）隐藏启动同目录 run.bat 并等待。
# 路径运行时由 FSO 从自身目录（jobDir）推导，不内嵌路径/中文（.vbs 无 BOM 按 ANSI 读）。
function New-BgjobsLaunchVbs {
    return ((
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'Set sh = CreateObject("WScript.Shell")',
        'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
        'sh.Run """" & dir & "\run.bat""", 0, True'
    ) -join "`r`n") + "`r`n"
}

# ── pwsh engine: run.ps1 (MUST mirror buildPwshRunner() in lib/index.js) ──────
# schtasks /TR 直接调解释器执行本包装脚本：& job.ps1 *> 重定向、写 exitcode.txt、
# 自删任务计划——pwsh 路径不再经过 cmd。退出码取 $LASTEXITCODE；try/catch 兜底保证
# exitcode.txt 必写；5.1 的 *> 输出 UTF-16LE（BOM FF FE），检测到即转 UTF-8。
# 模板用单引号 here-string：$ 与 ' 全为字面量，路径经占位符替换（避免双引号插值陷阱）。
function New-BgjobsPwshRunner([object]$Job) {
    $scriptPath = if ($Job.meta.scriptPath) { $Job.meta.scriptPath } else { Join-Path (Split-Path $Job.meta.jsonPath -Parent) 'job.ps1' }
    $tpl = @'
# bgjobs pwsh runner: 重定向 + exitcode + 自删任务计划
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$utf8 = New-Object System.Text.UTF8Encoding($false)
Set-Location -LiteralPath '__WORKDIR__'
$logPath = '__LOGPATH__'
$code = 0
try {
    & '__SCRIPTPATH__' *> $logPath
    if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }
} catch {
    $code = 1
    [System.IO.File]::AppendAllText($logPath, '[BGJOB] error: ' + $_.Exception.Message + [Environment]::NewLine, $utf8)
}
if (Test-Path -LiteralPath $logPath) {
    $logBytes = [System.IO.File]::ReadAllBytes($logPath)
    if ($logBytes.Length -ge 2 -and $logBytes[0] -eq 0xFF -and $logBytes[1] -eq 0xFE) {
        [System.IO.File]::WriteAllText($logPath, [System.IO.File]::ReadAllText($logPath, [System.Text.Encoding]::Unicode), $utf8)
    }
}
[System.IO.File]::AppendAllText($logPath, '[BGJOB] exit code: ' + $code + [Environment]::NewLine, $utf8)
[System.IO.File]::WriteAllText('__EXITCODEPATH__', [string]$code, $utf8)
& schtasks /Delete /TN '__TASKNAME__' /F *> $null
'@
    $out = $tpl.Replace('__WORKDIR__', $Job.meta.workdir).Replace('__LOGPATH__', $Job.meta.logPath).Replace('__SCRIPTPATH__', $scriptPath).Replace('__EXITCODEPATH__', $Job.meta.exitcodePath).Replace('__TASKNAME__', $Job.meta.taskName)
    return (($out -replace "`r?`n", "`r`n") + "`r`n")
}

# ── pwsh engine: job.ps1 (MUST mirror buildPs1() in lib/index.js) ────────────
# 编码 preamble + 用户命令原样（CRLF 归一）。注意：写入文件时必须加 UTF-8 BOM
# （Windows PowerShell 5.1 解析无 BOM 文件按 ANSI/GBK 读，中文会乱）。
function New-BgjobsPs1([object]$Job) {
    $preamble = @(
        '# bgjobs: 强制 UTF-8 输出（Windows PowerShell 5.1 重定向默认 UTF-16 会乱码）',
        'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
        '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'
    ) -join "`r`n"
    return $preamble + "`r`n" + (([string]$Job.meta.command -split "\r?\n") -join "`r`n") + "`r`n"
}

# ── PowerShell interpreter resolution (mirror resolveShell() in lib/index.js) ─
# 顺序：pwsh 常见安装路径 → PATH 里的 pwsh → Windows PowerShell 5.1 默认路径 →
# PATH 里的 powershell。返回 @{ exe; engine } 或 $null。
function Resolve-BgjobsShell {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'PowerShell\7\pwsh.exe')
    )
    foreach ($p in $candidates) {
        if (Test-Path -LiteralPath $p) { return @{ exe = $p; engine = 'pwsh' } }
    }
    foreach ($name in @('pwsh', 'powershell')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source) { return @{ exe = $cmd.Source; engine = $(if ($name -eq 'pwsh') { 'pwsh' } else { 'powershell' }) } }
    }
    $ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $ps51) { return @{ exe = $ps51; engine = 'powershell' } }
    return $null
}

# ── exit code (mirror parseExitCode() in lib/index.js) ────────────────────
function ConvertFrom-BgjobsExitCode([string]$Text) {
    $m = [regex]::Match([string]$Text, '(-?\d+)')
    if (-not $m.Success) { return $null }
    return [int]$m.Groups[1].Value
}

# ── schtasks runner (mirror spawnRun in lib/index.js; synchronous) ────────
function Invoke-BgjobsSchtasks([string[]]$Arguments, [string]$Cwd) {
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $script:BgjobsSchtasks
        # 不用 $psi.ArgumentList：Windows PowerShell 5.1（.NET Framework）下该属性为 null。
        # 用 Arguments 字符串：含空格且未自带引号的参数补引号（如 /TR "path" 已带引号则原样保留）。
        $parts = foreach ($a in $Arguments) {
            if ($a -match '[ "]' -and -not ($a.StartsWith('"') -and $a.EndsWith('"'))) { '"' + $a + '"' } else { $a }
        }
        $psi.Arguments = ($parts -join ' ')
        $psi.WorkingDirectory = $Cwd
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = New-Object System.Diagnostics.Process
        $p.StartInfo = $psi
        $null = $p.Start()
        $stdout = $p.StandardOutput.ReadToEnd()
        $stderr = $p.StandardError.ReadToEnd()
        $p.WaitForExit(30000) | Out-Null
        if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit() }
        return @{ exitCode = $p.ExitCode; stdout = $stdout; stderr = $stderr }
    } catch {
        return @{ exitCode = $null; stdout = ''; stderr = 'spawn failed: ' + $_.Exception.Message }
    }
}

# ── submit (mirror submitJob in lib/index.js) ─────────────────────────────
# Returns @{ ok; jobId; taskName; logPath; error }. -Engine: 'bat'（cmd，默认）
# 或 'pwsh'（PowerShell 执行，pwsh 7 优先、Windows PowerShell 5.1 兜底）。
function Submit-BgjobsJob([string]$Name, [string]$Command, [string]$WorkdirRaw, [string]$CreatedBySession, [ValidateSet('bat', 'pwsh')][string]$Engine = 'bat') {
    $workdir = Convert-BgjobsPathStrip $WorkdirRaw
    $jobId = 'bg-' + (Get-Date).ToFileTime().ToString('x') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    $taskName = 'dsh-bgj-' + $jobId
    $jobDir = Join-Path $workdir ".dsh\bgjobs\$jobId"
    $logPath = Join-Path $jobDir 'stdout.log'
    $exitcodePath = Join-Path $jobDir 'exitcode.txt'
    $jsonPath = Join-Path $jobDir 'job.json'
    $batPath = Join-Path $jobDir 'run.bat'
    $launchVbsPath = Join-Path $jobDir 'launch.vbs'
    $WSCRIPT = (Join-Path $env:SystemRoot 'System32\wscript.exe')
    $isPwsh = ($Engine -eq 'pwsh')

    try { New-Item -ItemType Directory -Force -Path $jobDir | Out-Null }
    catch { return @{ ok = $false; error = 'create job dir failed: ' + $_.Exception.Message } }

    # pwsh 引擎：先解析 PowerShell 解释器（提交时烘焙绝对路径进 run.bat）。
    $shell = $null
    if ($isPwsh) {
        $shell = Resolve-BgjobsShell
        if ($null -eq $shell) {
            [void](Remove-Item -LiteralPath $jobDir -Recurse -Force -ErrorAction SilentlyContinue)
            return @{ ok = $false; error = 'PowerShell not found: install pwsh (7+) or Windows PowerShell' }
        }
    }

    $meta = @{
        id = $jobId; name = [string]$Name; workdir = $workdir; taskName = $taskName; jobDir = $jobDir
        logPath = $logPath; exitcodePath = $exitcodePath; jsonPath = $jsonPath
        command = [string]$Command
        createdBySession = [string]$CreatedBySession; createdAt = (Get-BgjobsNowMs); status = 'running'
    }
    if ($isPwsh) {
        $scriptPath = Join-Path $jobDir 'job.ps1'
        $meta.engine = 'pwsh'
        $meta.scriptPath = $scriptPath
        $meta.interpreter = $shell.exe
    } else {
        $meta.cmdPath = Join-Path $jobDir 'cmd.bat'
    }
    $job = [pscustomobject]@{ id = $jobId; meta = [pscustomobject]$meta }
    $runnerPath = Join-Path $jobDir 'run.ps1'
    try {
        if ($isPwsh) {
            # job.ps1 / run.ps1 必须 UTF-8 with BOM：Windows PowerShell 5.1 解析无 BOM 文件按 ANSI/GBK 读，中文会乱。
            [System.IO.File]::WriteAllText($meta.scriptPath, (New-BgjobsPs1 $job), (New-Object System.Text.UTF8Encoding($true)))
            [System.IO.File]::WriteAllText($runnerPath, (New-BgjobsPwshRunner $job), (New-Object System.Text.UTF8Encoding($true)))
        } else {
            [System.IO.File]::WriteAllText($meta.cmdPath, (New-BgjobsCmdBat $job), (New-Object System.Text.UTF8Encoding($false)))
            [System.IO.File]::WriteAllText($batPath, (New-BgjobsBat $job), (New-Object System.Text.UTF8Encoding($false)))
            # 隐藏窗口启动器：wscript 以 SW_HIDE 运行 run.bat（bat 引擎零 PowerShell 依赖）
            [System.IO.File]::WriteAllText($launchVbsPath, (New-BgjobsLaunchVbs), (New-Object System.Text.UTF8Encoding($false)))
        }
        $json = $meta | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        [void](Remove-Item -LiteralPath $jobDir -Recurse -Force -ErrorAction SilentlyContinue)
        return @{ ok = $false; error = 'write job files failed: ' + $_.Exception.Message }
    }
    $st = (Get-Date).AddMinutes(1).ToString('HH:mm')
    # /TR 目标：pwsh 引擎直接调解释器执行 run.ps1（-WindowStyle Hidden 隐藏控制台窗口）；
    # bat 引擎经 wscript.exe 执行 launch.vbs（SW_HIDE 隐藏启动 run.bat，零 PowerShell 依赖）。
    # schtasks /TR 多 token 值需整体加引号并转义内部引号（"\"prog\" -arg ..."），否则
    # schtasks 会把 -NoProfile 等误判为自身选项。
    $trValue = if ($isPwsh) { ('"\"' + $shell.exe + '\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + $runnerPath + '\""') } else { ('"\"' + $WSCRIPT + '\" \"' + $launchVbsPath + '\""') }
    $create = Invoke-BgjobsSchtasks @('/Create', '/TN', $taskName, '/TR', $trValue, '/SC', 'ONCE', '/ST', $st, '/F') $workdir
    if ($create.exitCode -ne 0) {
        [void](Remove-Item -LiteralPath $jobDir -Recurse -Force -ErrorAction SilentlyContinue)
        return @{ ok = $false; error = 'schtasks create failed: ' + $create.stderr + $create.stdout }
    }
    $run = Invoke-BgjobsSchtasks @('/Run', '/TN', $taskName) $workdir
    if ($run.exitCode -ne 0) {
        [void](Invoke-BgjobsSchtasks @('/Delete', '/TN', $taskName, '/F') $workdir)
        [void](Remove-Item -LiteralPath $jobDir -Recurse -Force -ErrorAction SilentlyContinue)
        return @{ ok = $false; error = 'schtasks run failed: ' + $run.stderr + $run.stdout }
    }
    # /Run 已触发执行：立即禁用任务计划，防 /ST（now+1min）整分再触发导致任务双跑。
    # 用 /Change /DISABLE 而非 /Delete：/Run 的实例是异步排队启动的，若紧接着 /Delete，
    # Task Scheduler 会连同注册一起丢弃排队中的运行实例→进程从未启动→永远 running 且无日志。
    # 禁用保留注册（运行实例照常跑完），末尾 bat 自删与 done 兜底 /Delete 变 no-op。
    [void](Invoke-BgjobsSchtasks @('/Change', '/TN', $taskName, '/DISABLE') $workdir)
    # update central index (append entry)
    $idx = Get-BgjobsIndex
    $entry = [pscustomobject]@{
        id = $jobId; jobDir = $jobDir; workdir = $workdir; name = [string]$Name
        createdBySession = [string]$CreatedBySession; createdAt = (Get-BgjobsNowMs)
    }
    $newJobs = @($idx.jobs | Where-Object { $_.id -ne $jobId }) + $entry
    $payload = @{ version = 1; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); jobs = $newJobs }
    New-Item -ItemType Directory -Force -Path (Split-Path $script:BgjobsIndexPath -Parent) | Out-Null
    [System.IO.File]::WriteAllText($script:BgjobsIndexPath, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    return @{ ok = $true; jobId = $jobId; taskName = $taskName; logPath = $logPath }
}

# ── kill (mirror: schtasks /End + /Delete, then optional dir cleanup) ─────
function Stop-BgjobsJob([string]$Id, [switch]$NoDeleteDir) {
    $job = Get-BgjobsJob $Id
    if ($null -eq $job) { return @{ ok = $false; error = "job not found: $Id" } }
    $taskName = if ($job.taskName) { $job.taskName } else { 'dsh-bgj-' + $Id }
    if ($job.status -eq 'running') {
        [void](Invoke-BgjobsSchtasks @('/End', '/TN', $taskName) $job.workdir)
    }
    [void](Invoke-BgjobsSchtasks @('/Delete', '/TN', $taskName, '/F') $job.workdir)
    if (-not $NoDeleteDir) {
        [void](Remove-Item -LiteralPath $job.jobDir -Recurse -Force -ErrorAction SilentlyContinue)
    }
    # remove from central index
    $idx = Get-BgjobsIndex
    $newJobs = @($idx.jobs | Where-Object { $_.id -ne $Id })
    $payload = @{ version = 1; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); jobs = $newJobs }
    [System.IO.File]::WriteAllText($script:BgjobsIndexPath, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    return @{ ok = $true; removed = $Id }
}

# ── cleanup: remove done job dirs beyond retention ───────────────────────
# -OlderThanHours > 0（仅清理超期）：只删能确定完成时间且严格早于 retention 的 done；
#   finishedAt 缺失（如 DSH 离线期间完成、job.json 未回写）时以 exitcode.txt 落盘时间
#   近似完成时间参与判定；finishedAt 与 exitcode.txt 皆无才保留。
# -OlderThanHours <= 0（全部清理）：删除所有 done（含 finishedAt 缺失）。
function Clear-BgjobsDone([int]$OlderThanHours) {
    $removed = @()
    $retention = [DateTime]::UtcNow.AddHours(-$OlderThanHours)
    $jobs = Get-BgjobsJobs
    $kept = @()
    foreach ($job in $jobs) {
        $delete = $false
        try {
            $done = ($job.status -eq 'done')
            $all = ($OlderThanHours -le 0)
            $finished = ConvertFrom-BgjobsTimeMs $job.finishedAt
            if ($done -and -not $all -and $null -eq $finished -and $job.exitcodePath -and (Test-Path -LiteralPath $job.exitcodePath)) {
                # finishedAt 缺失（典型：DSH 离线期间任务结束、job.json 未回写）：
                # exitcode.txt 是任务收尾时写下的终态文件，其落盘时间 ≈ 完成时间。
                $finished = [System.IO.File]::GetLastWriteTimeUtc($job.exitcodePath)
            }
            if ($done -and ($all -or ($null -ne $finished -and $finished -lt $retention))) {
                [void](Remove-Item -LiteralPath $job.jobDir -Recurse -Force -ErrorAction SilentlyContinue)
                $removed += $job.id
                $delete = $true
            }
        } catch { }    
        if (-not $delete) { $kept += $job }
    }
    # 索引是"地图"：写回前只保留定位/展示字段（id/jobDir/workdir/name/createdBySession/createdAt），
    # 不把 job.json 的实时视图（status/logPath/finishedAt/...）复制进索引。
    $map = @($kept | ForEach-Object {
        [pscustomobject]@{
            id = $_.id
            jobDir = $_.jobDir
            workdir = if ($_.workdir) { $_.workdir } else { '' }
            name = if ($_.name) { $_.name } else { $_.id }
            createdBySession = if ($_.createdBySession) { $_.createdBySession } else { '' }
            createdAt = if ($null -ne $_.createdAt) { $_.createdAt } else { 0 }
        }
    })
    $payload = @{ version = 1; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); jobs = $map }
    [System.IO.File]::WriteAllText($script:BgjobsIndexPath, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    return $removed
}

# ── UI language (shared by dsh-bgjobs-gui.ps1) ──────────────────────────
# Follow the Windows UI language: zh* → Simplified Chinese, anything else → English.
# Note: this file must stay UTF-8 with BOM so Windows PowerShell 5.1 parses
# the Chinese fallback strings correctly (ANSI/GBK misread otherwise).
$script:BgjobsLangZh = [System.Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh*'

# GUI text dictionary. Keys are stable; pick zh or en by $script:BgjobsLangZh.
$script:BgjobsText = @{
    # main window
    'gui.title' = if ($script:BgjobsLangZh) { 'bgjobs 后台任务管理' } else { 'bgjobs Job Manager' }
    'gui.refresh' = if ($script:BgjobsLangZh) { '🔄 刷新' } else { '🔄 Refresh' }
    'gui.submit' = if ($script:BgjobsLangZh) { '➕ 提交' } else { '➕ Submit' }
    'gui.kill' = if ($script:BgjobsLangZh) { '⏹ 终止' } else { '⏹ Kill' }
    'gui.cleanup' = if ($script:BgjobsLangZh) { '🧹 清理' } else { '🧹 Cleanup' }
    'gui.index' = if ($script:BgjobsLangZh) { '🗺 重建索引' } else { '🗺 Rebuild index' }
    'col.id' = 'ID'
    'col.name' = if ($script:BgjobsLangZh) { '名称' } else { 'Name' }
    'col.status' = if ($script:BgjobsLangZh) { '状态' } else { 'Status' }
    'col.exit' = if ($script:BgjobsLangZh) { '退出码' } else { 'Exit' }
    'col.finished' = if ($script:BgjobsLangZh) { '完成时间' } else { 'Finished' }
    'col.workdir' = if ($script:BgjobsLangZh) { '工作目录' } else { 'Workdir' }
    'status.count' = if ($script:BgjobsLangZh) { '任务数：{0}    索引：{1}' } else { 'Jobs: {0}    Index: {1}' }
    'detail.log' = if ($script:BgjobsLangZh) { '-- 最近日志 --' } else { '-- recent log --' }
    'detail.nolog' = '(no log yet)'
    'mutex.already' = if ($script:BgjobsLangZh) { 'bgjobs 管理面板已在运行（可能最小化到了托盘）。' } else { 'bgjobs manager is already running (maybe minimized to tray).' }
    'dlg.submit.title' = if ($script:BgjobsLangZh) { '提交后台任务' } else { 'Submit Background Job' }
    'dlg.example' = if ($script:BgjobsLangZh) { '示例：' } else { 'Example: ' }
    'dlg.example.none' = if ($script:BgjobsLangZh) { '（无）' } else { '(none)' }
    'dlg.example.countdown' = if ($script:BgjobsLangZh) { '倒计时（每1秒打印剩余时间，结束Toast提醒）' } else { 'Countdown (prints remaining seconds, Toast on finish)' }
    'dlg.name' = if ($script:BgjobsLangZh) { '任务名（给任务起个名字，如：倒计时演示）' } else { 'Name (e.g. countdown-demo)' }
    'dlg.command' = if ($script:BgjobsLangZh) { '命令（要执行的命令，可多行）' } else { 'Command (multi-line supported)' }
    'dlg.hint' = if ($script:BgjobsLangZh) { '提示：不知道怎么写？用上方【示例】下拉选【倒计时】一键填充。' } else { 'Tip: not sure what to type? Pick "Countdown" in the Example dropdown above.' }
    'dlg.workdir' = if ($script:BgjobsLangZh) { '工作目录（任务运行目录，如 C:\logs）' } else { 'Workdir (absolute path, e.g. C:\logs)' }
    'dlg.engine' = if ($script:BgjobsLangZh) { '引擎：' } else { 'Engine: ' }
    'dlg.engine.bat' = if ($script:BgjobsLangZh) { 'bat（cmd）' } else { 'bat (cmd)' }
    'dlg.engine.pwsh' = if ($script:BgjobsLangZh) { 'pwsh（PowerShell）' } else { 'pwsh (PowerShell)' }
    'dlg.ok' = if ($script:BgjobsLangZh) { '提交' } else { 'Submit' }
    'dlg.cancel' = if ($script:BgjobsLangZh) { '取消' } else { 'Cancel' }
    'dlg.empty' = if ($script:BgjobsLangZh) { '任务名、命令、工作目录都不能为空。' } else { 'Name, command and workdir are all required.' }
    'dlg.failed' = if ($script:BgjobsLangZh) { '提交失败：{0}' } else { 'Submit failed: {0}' }
    'msg.kill' = if ($script:BgjobsLangZh) { '终止任务 {0}（{1}）？' } else { 'Kill job {0} ({1})?' }
    'msg.kill.failed' = if ($script:BgjobsLangZh) { '终止失败：{0}' } else { 'Kill failed: {0}' }
    'dlg.cleanup.title' = if ($script:BgjobsLangZh) { '清理已完成任务' } else { 'Clean up finished jobs' }
    'dlg.cleanup.older.pre' = if ($script:BgjobsLangZh) { '仅清理超过' } else { 'Only jobs older than' }
    'dlg.cleanup.older.post' = if ($script:BgjobsLangZh) { '小时前完成的任务' } else { 'h' }
    'dlg.cleanup.doOlder' = if ($script:BgjobsLangZh) { '清理超期任务' } else { 'Clean old jobs' }
    'dlg.cleanup.doAll' = if ($script:BgjobsLangZh) { '清理全部已完成' } else { 'Clean all finished' }
    'msg.cleaned' = if ($script:BgjobsLangZh) { '已清理 {0} 个任务' } else { 'Cleaned {0} job(s)' }
    'msg.index.prompt' = if ($script:BgjobsLangZh) { '选择工作区根目录（扫描其 .dsh/bgjobs 下的任务）' } else { 'Choose a workspace root (scans its .dsh/bgjobs for jobs)' }
    'msg.index.done' = if ($script:BgjobsLangZh) { '索引重建完成：{0} 个任务' } else { 'Index rebuilt: {0} job(s)' }
    # countdown example command (kept bilingual so the sample is readable in either locale)
    'example.countdown.name' = if ($script:BgjobsLangZh) { '倒计时演示' } else { 'Countdown demo' }
    'example.countdown.secs' = if ($script:BgjobsLangZh) { '{0,3} 秒后结束...' } else { '{0,3}s left...' }
    'example.countdown.done' = if ($script:BgjobsLangZh) { '倒计时结束！' } else { 'Countdown finished!' }
    'example.countdown.toast.title' = if ($script:BgjobsLangZh) { 'bgjobs 提醒' } else { 'bgjobs reminder' }
    'example.countdown.toast.msg' = if ($script:BgjobsLangZh) { '倒计时结束（{0} 秒）' } else { 'Countdown finished ({0}s)' }
    'example.countdown.toast.fail' = if ($script:BgjobsLangZh) { '（Toast 通知失败：{0}）' } else { '(Toast failed: {0})' }
}

# Resolve a UI text key. Templates with placeholders are formatted by the
# caller with -f, e.g. (Get-BgjobsText 'status.count') -f $n, $path
function Get-BgjobsText([string]$Key) {
    $tpl = $script:BgjobsText[$Key]
    if ($null -eq $tpl) { return $Key }
    return $tpl
}
