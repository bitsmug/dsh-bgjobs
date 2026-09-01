# dsh-bgjobs-lib.ps1 - shared logic for the bgjobs offline management CLI.
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

# ── pwsh engine: run.bat (MUST mirror buildPwshBat() in lib/index.js) ─────────
# 直接以 PowerShell 解释器（提交时解析的绝对路径）执行 job.ps1，输出整体重定向。
function New-BgjobsPwshBat([object]$Job) {
    $scriptPath = if ($Job.meta.scriptPath) { $Job.meta.scriptPath } else { Join-Path (Split-Path $Job.meta.jsonPath -Parent) 'job.ps1' }
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('@echo off')
    $lines.Add('>nul chcp 65001')
    $lines.Add('cd /d "' + $Job.meta.workdir + '"')
    $lines.Add('"' + $Job.meta.interpreter + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" >> "' + $Job.meta.logPath + '" 2>&1')
    $lines.Add('set "bgrc=%errorlevel%"')
    $lines.Add('>> "' + $Job.meta.logPath + '" echo [BGJOB] exit code: %bgrc%')
    $lines.Add('> "' + $Job.meta.exitcodePath + '" echo %bgrc%')
    $lines.Add('schtasks /Delete /TN ' + $Job.meta.taskName + ' /F >nul 2>&1')
    return (($lines -join "`r`n") + "`r`n")
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
function Invoke-BgjobsSchtasks([string[]]$Args, [string]$Cwd) {
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $script:BgjobsSchtasks
        foreach ($a in $Args) { [void]$psi.ArgumentList.Add($a) }
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
    try {
        if ($isPwsh) {
            # job.ps1 必须 UTF-8 with BOM：Windows PowerShell 5.1 解析无 BOM 文件按 ANSI/GBK 读，中文会乱。
            [System.IO.File]::WriteAllText($meta.scriptPath, (New-BgjobsPs1 $job), (New-Object System.Text.UTF8Encoding($true)))
            [System.IO.File]::WriteAllText($batPath, (New-BgjobsPwshBat $job), (New-Object System.Text.UTF8Encoding($false)))
        } else {
            [System.IO.File]::WriteAllText($meta.cmdPath, (New-BgjobsCmdBat $job), (New-Object System.Text.UTF8Encoding($false)))
            [System.IO.File]::WriteAllText($batPath, (New-BgjobsBat $job), (New-Object System.Text.UTF8Encoding($false)))
        }
        $json = $meta | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        [void](Remove-Item -LiteralPath $jobDir -Recurse -Force -ErrorAction SilentlyContinue)
        return @{ ok = $false; error = 'write job files failed: ' + $_.Exception.Message }
    }
    $st = (Get-Date).AddMinutes(1).ToString('HH:mm')
    $create = Invoke-BgjobsSchtasks @('/Create', '/TN', $taskName, '/TR', ('"' + $batPath + '"'), '/SC', 'ONCE', '/ST', $st, '/F') $workdir
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

# ── cleanup: remove done job dirs beyond retention, prune orphaned tasks ──
function Clear-BgjobsDone([int]$OlderThanHours) {
    $removed = @()
    $retention = [DateTime]::UtcNow.AddHours(-$OlderThanHours)
    $idx = Get-BgjobsIndex
    $kept = @()
    foreach ($entry in $idx.jobs) {
        $jobJson = Join-Path $entry.jobDir 'job.json'
        $delete = $false
        if (Test-Path -LiteralPath $jobJson) {
            try {
                $meta = Get-Content -LiteralPath $jobJson -Raw -Encoding UTF8 | ConvertFrom-Json
                $done = ($meta.status -eq 'done')
                $finished = ConvertFrom-BgjobsTimeMs $meta.finishedAt
                if ($done -and ($null -eq $finished -or $finished -lt $retention)) {
                    [void](Remove-Item -LiteralPath $entry.jobDir -Recurse -Force -ErrorAction SilentlyContinue)
                    $removed += $entry.id
                    $delete = $true
                }
            } catch { }
        } elseif (-not (Test-Path -LiteralPath $entry.jobDir)) {
            $delete = $true # job dir gone: drop stale index entry
        }
        if (-not $delete) { $kept += $entry }
    }
    $payload = @{ version = 1; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); jobs = $kept }
    [System.IO.File]::WriteAllText($script:BgjobsIndexPath, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    return $removed
}
