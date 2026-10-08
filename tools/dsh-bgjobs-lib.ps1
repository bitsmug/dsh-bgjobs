# dsh-bgjobs-lib.ps1 - shared logic for the bgjobs offline management CLI.
# Dot-source this from dsh-bgjobs.ps1 (CLI). Works WITHOUT DSH running:
# reads/writes the same job.json / stdout.log / exitcode.txt files and the
# same central index (<dsh-home>/bgjobs/index.json) as the bgjobs DSH plugin.
#
# Store layout (mirrors lib/index.js of the bgjobs plugin):
#   - Jobs live at <workdir>/.dsh/bgjobs/<jobId>/  (job.json, stdout.log,
#     exitcode.txt, run.bat) — the durable source of truth. State is ALWAYS
#     read live from job.json; the central index is only a "map" (jobId ->
#     jobDir) so the offline tool can locate jobs scattered across workspaces.
#   - Central index: <dsh-home>/bgjobs/index.json, where <dsh-home> comes from
#     Resolve-BgjobsHome() below — PORTABLE-FIRST, then the harness rule
#     ($DSH_HOME env var, fallback ~/.dsh) as fallback.
#     Inside a portable tree this file sits at <root>\plugins\<plugin>\tools\,
#     so <root>\data\dsh-home (three levels up) WINS over an external DSH_HOME
#     **on purpose** — that is the portable tree's own documented policy
#     ("DSH_HOME 策略 = 便携优先", see the tree's README): a stale machine-level
#     DSH_HOME must not drag the offline tools to a different, abandoned store.
#     $env:BGJOBS_DSH_HOME overrides every layer (explicit escape hatch).
#
# MUST-MIRROR notes (keep in sync with lib/index.js):
#   - New-BgjobsBat must behave identically to buildBat() in lib/index.js
#     (same cmd trap: `> file echo %var%` for numeric vars).
#   - Read-BgjobsJobJson must parse the same job.json fields the plugin writes.
#   - job.json timestamps are UNIX MILLISECONDS (Date.now() in the plugin);
#     do NOT write ISO strings or the offline tool misreads plugin-written jobs.

# ── dsh-home resolution: portable-first, harness rule as fallback ─────────
# Priority: ① $env:BGJOBS_DSH_HOME (explicit override for the offline tools)
# → ② portable probe <root>\data\dsh-home (this file sits in
# <root>\plugins\<plugin>\tools\, so '..\..\..' from here is <root>)
# → ③ $env:DSH_HOME (same rule as harness resolveDshHome)
# → ④ $env:USERPROFILE\.dsh.
# The "shape" gate guards only the *guessed* layers (② and ④): a directory
# with no bgjobs/DSH marker inside is not a home and must not win by accident
# (e.g. an empty <root>\data\dsh-home stub). Explicitly set env vars (①/③)
# are deliberately NOT shape-gated: an explicit choice stays authoritative
# even for a brand-new/empty store — otherwise these tools would silently read
# and write a DIFFERENT home than the one the user/harness selected.
$script:BgjobsPortableHomeProbe = if ($PSScriptRoot) { Join-Path $PSScriptRoot '..\..\..\data\dsh-home' } else { $null }

# Does $Dir look like a DSH home? Must exist, be a directory, and carry at
# least one marker. Primitives only (Windows PowerShell 5.1 compatible).
function Test-BgjobsHomeShape([string]$Dir) {
    if (-not $Dir) { return $false }
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return $false }
    foreach ($marker in @('bgjobs\index.json', 'profiles', 'sessions', 'logs')) {
        if (Test-Path -LiteralPath (Join-Path $Dir $marker)) { return $true }
    }
    return $false
}

# Resolve the dsh-home as { Path; Source } — Source is one of
# override|portable|env|userprofile|fallback (the GUI shows it in the status
# bar so a "which store am I looking at?" question is answerable at a glance).
function Resolve-BgjobsHome() {
    # ① explicit override
    if ($env:BGJOBS_DSH_HOME) {
        return [pscustomobject]@{ Path = $env:BGJOBS_DSH_HOME; Source = 'override' }
    }
    # ② portable-first probe (shape-gated)
    if ($script:BgjobsPortableHomeProbe -and (Test-BgjobsHomeShape $script:BgjobsPortableHomeProbe)) {
        $portablePath = $script:BgjobsPortableHomeProbe
        try { $portablePath = (Resolve-Path -LiteralPath $script:BgjobsPortableHomeProbe).Path } catch { }
        $externalHome = if ($env:DSH_HOME) { ([string]$env:DSH_HOME).TrimEnd('\', '/') } else { '' }
        if ($externalHome -and ($externalHome -ne ([string]$portablePath).TrimEnd('\', '/'))) {
            Write-Host "[bgjobs] external DSH_HOME=$($env:DSH_HOME) ignored on purpose (portable-first); using $portablePath"
        }
        return [pscustomobject]@{ Path = $portablePath; Source = 'portable' }
    }
    # ③ harness rule
    if ($env:DSH_HOME) {
        return [pscustomobject]@{ Path = $env:DSH_HOME; Source = 'env' }
    }
    # ④ ~/.dsh
    $userProfileHome = Join-Path $env:USERPROFILE '.dsh'
    if (Test-BgjobsHomeShape $userProfileHome) {
        return [pscustomobject]@{ Path = $userProfileHome; Source = 'userprofile' }
    }
    # nothing looks like a home: still hand back a path (never an empty one)
    return [pscustomobject]@{ Path = $userProfileHome; Source = 'fallback' }
}

# Path + Source are kept side by side; $script:BgjobsHome keeps its old name
# and type so every downstream consumer stays untouched.
$script:BgjobsHomeInfo = Resolve-BgjobsHome
$script:BgjobsHome = $script:BgjobsHomeInfo.Path
$script:BgjobsIndexPath = Join-Path $script:BgjobsHome 'bgjobs\index.json'
$script:BgjobsSchtasks = Join-Path ($env:SystemRoot) 'System32\schtasks.exe'
# 树杀用（B1）：`schtasks /End` 够不到任务根起的后代，只有 taskkill /T 杀得穿。
$script:BgjobsTaskkill = Join-Path ($env:SystemRoot) 'System32\taskkill.exe'
# ★ 被终止（kill）时由 host 侧补写的退出码 = 1：实测（本机 Windows，各 3 次重复）——退出码**不是
# 系统自动给的**，它就是终止方传给 TerminateProcess 的参数，而 `taskkill /PID <pid> /T /F` 记录的
# 值稳定 = 1 ⇒ 1 就是"取任务进程真正的退出码"能取到的**真值**（旧值 143 = 128 + 15 是 POSIX 的
# SIGTERM 约定，Windows 根本不会产生，已废弃）。两个边界：① 任务进程是 schtasks 起的、我们不持有
# 它的句柄 ⇒ **读不到"任务自己"的码**；② schtasks 的 Last Result 分不清"runner 自己报了 1"与
# "runner 被杀成 1" ⇒ **不能当证据**，来源一律靠 job.json 的 exitCodeSource:'killed' 判定。
# 与宿主侧 lib/kill-tree.js 的 KILLED_EXIT_CODE 同值（两处必须一起改）。
$script:BgjobsKilledExitCode = 1

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

# 读取日志尾部 N 行，编码自适应：优先严格 UTF-8，失败回退系统 ANSI 代码页
# （中文系统 = GBK/936，MATLAB 等子进程常以 ANSI 输出；硬编码 UTF-8 会乱码）。
# 追加鲁棒性：任务仍在运行、日志末尾可能带未写完的半个 UTF-8 字符——整文件严格解码
# 会失败并误回退 GBK 造成全文件乱码。处理顺序：
#   1) 整文件严格 UTF-8（成功即用）；
#   2) 去掉尾部 ≤3 字节后严格 UTF-8（覆盖"尾部半个字符"场景，成功即用）；
#   3) 宽容 UTF-8（非法处替换为 U+FFFD），替换数很少（≤3）说明基本是 UTF-8，采用；
#   4) 否则按系统 ANSI(GBK) 解码。
function Read-BgjobsLogTail([string]$Path, [int]$Tail) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        if ($bytes.Length -eq 0) { return @() }
        $strict = New-Object System.Text.UTF8Encoding($false, $true)   # 非法字节即抛异常
        $text = $null
        $ok = $false
        # 1) 整文件严格解码
        try { $text = $strict.GetString($bytes); $ok = $true } catch { }
        # 2) 去掉尾部 ≤3 字节再严格解码（文件正在被写入，末尾可能是半个多字节字符）
        if (-not $ok) {
            $cut = [Math]::Min(3, $bytes.Length)
            for ($i = 1; $i -le $cut -and -not $ok; $i++) {
                try {
                    $text = $strict.GetString($bytes, 0, $bytes.Length - $i)
                    $ok = $true
                } catch { }
            }
        }
        if (-not $ok) {
            # 3) 宽容 UTF-8：替换数很少时按 UTF-8 处理（只末尾一个 �，主体可读）
            $lenient = New-Object System.Text.UTF8Encoding($false, $false)
            $candidate = $lenient.GetString($bytes)
            $rep = ([regex]::Matches($candidate, [string][char]0xFFFD)).Count
            if ($rep -le 3) { $text = $candidate; $ok = $true }
        }
        if (-not $ok) {
            # 4) 非 UTF-8（如纯 GBK）：按系统 ANSI 解码
            $text = [System.Text.Encoding]::Default.GetString($bytes)
        }
        $lines = @($text -split "`r?`n")
        if ($lines.Count -gt $Tail) { $lines = @($lines | Select-Object -Last $Tail) }
        return @($lines)
    } catch { return @() }
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
                command = if ($meta.command) { [string]$meta.command } else { '' }
                createdBySession = if ($meta.createdBySession) { $meta.createdBySession } else { $entry.createdBySession }
                # 沙箱任务私有的临时根（宿主提交时写进 job.json）：删除任务时一并清掉，
                # 否则孤儿进程复活重建的目录会一直留在磁盘上（B1 的第三个后果）。
                sandboxTempPath = if ($meta.sandboxTempPath) { [string]$meta.sandboxTempPath } else { '' }
                # notify（交付）标记：notifiedAt/notifiedBy 与宿主 job.json 同源
                notified = if ($null -ne $meta.notifiedAt) { $true } else { $false }
                notifiedAt = if ($meta.notifiedAt) { $meta.notifiedAt } else { $null }
                notifiedBy = if ($null -ne $meta.notifiedAt) { if ($meta.notifiedBy) { $meta.notifiedBy } else { 'notify' } } else { $null }
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

# ── pwsh engine: run.ps1 (MUST mirror buildPwshRunner() in lib/scripts.js) ─────
# schtasks /TR 直接调解释器执行本包装脚本：& job.ps1 *> 重定向、写 exitcode.txt、
# 自删任务计划——pwsh 路径不再经过 cmd。退出码取 $LASTEXITCODE；try/catch 兜底保证
# exitcode.txt 必写；5.1 的 *> 输出 UTF-16LE（BOM FF FE），检测到即转 UTF-8——这里才是
# 乱码兜底的真身。v0.1.92：删掉 Add-Type SetConsoleOutputCP（+0.6 s/次、零语义），
# 编码 preamble 按解释器条件化（pwsh 7 整段跳过 preamble）。
# ★ 更正（v0.1.95 实测）：pwsh 7 **并非**「启动即 UTF-8」——它只在 stdout 被重定向时才强制
# UTF-8，进程拥有控制台时保留继承的代码页（schtasks / -WindowStyle Hidden 下实测
# CodePage = 936）⇒ 跳过 preamble 之后，由模板里那行 `try { [Console]::OutputEncoding = $utf8 }
# catch { }`（在 `*>` 之前）统一兜底，job.ps1 与它拉起的 native 子进程同进程继承。
# ★ B1（已修）：模板第 2-3 行落盘 `<jobDir>\run.pid` = 本 run.ps1 的 $PID（= schtasks 任务根），
# 删任务时据此 `taskkill /PID <pid> /T /F` 才杀得穿 node runner 与受限子进程。
# 这两行必须与 lib/scripts.js 的 buildPwshRunner 逐字一致（同一处改动必须双写）。
# 模板用单引号 here-string：$ 与 ' 全为字面量，路径经占位符替换（避免双引号插值陷阱）。
function Test-BgjobsPwsh7Interpreter([object]$Interpreter) {
    # 镜像 lib/scripts.js 的 isPwsh7Interpreter()：判据 = basename；拿不到/认不出 ⇒ 当 5.1（fail-safe）。
    $baseName = [System.IO.Path]::GetFileName([string]$Interpreter).ToLowerInvariant()
    return ($baseName -eq 'pwsh' -or $baseName -eq 'pwsh.exe')
}

function New-BgjobsPwshRunner([object]$Job) {
    $scriptPath = if ($Job.meta.scriptPath) { $Job.meta.scriptPath } else { Join-Path (Split-Path $Job.meta.jsonPath -Parent) 'job.ps1' }
    $jobDir = Split-Path $Job.meta.jsonPath -Parent
    $tpl = @'
# bgjobs pwsh runner: 重定向 + exitcode + 自删任务计划
$pidPath = '__JOBDIR__\run.pid'
try { [System.IO.File]::WriteAllText($pidPath, [string]$PID, (New-Object System.Text.UTF8Encoding($false))) } catch { }
__ENCPREAMBLE__$utf8 = New-Object System.Text.UTF8Encoding($false)
Set-Location -LiteralPath '__WORKDIR__'
$logPath = '__LOGPATH__'
$code = 0
try {
    try { [Console]::OutputEncoding = $utf8 } catch { }
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
    # 编码 preamble 占位符：5.1 注入一行（含换行），pwsh 7 注入空串（整段跳过）。
    $encPreamble = if (Test-BgjobsPwsh7Interpreter $Job.meta.interpreter) { '' } else { 'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }' + "`r`n" }
    $out = $tpl.Replace('__ENCPREAMBLE__', $encPreamble).Replace('__JOBDIR__', $jobDir).Replace('__WORKDIR__', $Job.meta.workdir).Replace('__LOGPATH__', $Job.meta.logPath).Replace('__SCRIPTPATH__', $scriptPath).Replace('__EXITCODEPATH__', $Job.meta.exitcodePath).Replace('__TASKNAME__', $Job.meta.taskName)
    return (($out -replace "`r?`n", "`r`n") + "`r`n")
}

# ── pwsh engine: job.ps1 (MUST mirror buildPs1() in lib/scripts.js) ──────────
# 编码 preamble（**仅 5.1**，v0.1.92 起）+ 用户命令原样（CRLF 归一）。注意：写入文件时
# 必须加 UTF-8 BOM（Windows PowerShell 5.1 解析无 BOM 文件按 ANSI/GBK 读，中文会乱）。
# v0.1.92 删掉 Add-Type SetConsoleOutputCP：每次启动现编译 C#（实测 +0.6 s/次），
# 而 5.1 的 *> 产物与是否设置控制台代码页无关（字节相同，都是 FF FE UTF-16LE）——
# 真正救回乱码的是 New-BgjobsPwshRunner 里的 FF FE 检测转换。
# ★ 更正（v0.1.95，镜像 lib/scripts.js 的 buildPs1 注释）：pwsh 7 **并非**「启动即 UTF-8」——
# 它只在 stdout 被重定向时才强制 UTF-8，进程拥有控制台时（schtasks / -WindowStyle Hidden）
# 保留继承的代码页（实测 CodePage = 936）。job.ps1 之所以仍可整段跳过 preamble：
# `& job.ps1` 是 call operator、与 run.ps1 同进程，而 run.ps1 已在 `*>` 之前设过一次
# [Console]::OutputEncoding（见 New-BgjobsPwshRunner），job.ps1 与其拉起的 native 子进程
# 直接继承 ⇒ 无需在这里重复设置。
function New-BgjobsPs1([object]$Job) {
    $preambleLines = if (Test-BgjobsPwsh7Interpreter $Job.meta.interpreter) {
        @()
    } else {
        @(
            '# bgjobs: 强制 UTF-8 输出（Windows PowerShell 5.1 重定向默认 UTF-16 会乱码）',
            'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
            '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'
        )
    }
    $preamble = ($preambleLines -join "`r`n")
    $head = if ($preamble.Length -gt 0) { $preamble + "`r`n" } else { '' }
    return $head + (([string]$Job.meta.command -split "\r?\n") -join "`r`n") + "`r`n"
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
# ★ -FileName：与宿主侧 runSchtasks 同口径的"通用外部命令执行器"（argv[0] 才是可执行文件）。
# 缺省仍是 schtasks.exe；taskkill 这类其它可执行文件必须显式传 -FileName——
# 早期版本把可执行文件写死成 schtasks.exe，把 'taskkill.exe' 当参数塞进去会被 schtasks
# 判成"无效参数/选项"（exit 1，实机验收抓到过一次），于是 CLI 的树杀从未真正执行。
function Invoke-BgjobsSchtasks([string[]]$Arguments, [string]$Cwd, [string]$FileName = '') {
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = if ($FileName) { $FileName } else { $script:BgjobsSchtasks }
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

# ── kill helpers (MUST mirror lib/kill-tree.js 的语义) ────────────────────
# B1：`schtasks /End` 打印 SUCCESS 却**够不到任务根起的后代**。沙箱 pwsh 任务的真实工作由
# 三层组成：pwsh.exe -File run.ps1（schtasks 任务根）→ node.exe sandbox-runner.js →
# pwsh.exe -File job.ps1（用户命令）。只有 `taskkill /PID <run.ps1 的 pid> /T /F` 一次杀穿。
# 因此 run.ps1 启动第一件事落盘 `<jobDir>\run.pid` = 自己的 $PID
# （宿主侧 lib/scripts.js 的 buildPwshRunner；离线侧 New-BgjobsPwshRunner，两处逐字一致）。
$script:BgjobsPidFileNames = @('run.pid', 'mcp-server.pid')

# 读任务目录里落盘的 pid。返回 @{ pid; file; pidPath } 或 $null
# （无 pid 文件 = 老任务 ⇒ 调用方退化为既有的 /End + /Delete 行为，不报错）。
function Get-BgjobsJobPid([string]$JobDir) {
    foreach ($name in $script:BgjobsPidFileNames) {
        $pidPath = Join-Path $JobDir $name
        if (-not (Test-Path -LiteralPath $pidPath)) { continue }
        try {
            $parsed = 0
            if ([int]::TryParse([System.IO.File]::ReadAllText($pidPath).Trim(), [ref]$parsed) -and $parsed -gt 0) {
                return @{ pid = $parsed; file = $name; pidPath = $pidPath }
            }
        } catch { }
    }
    return $null
}

# 只读核验：pid 是否存在、以及是否**属于本任务**（命令行含任一 needle 如 jobDir/taskName）。
# 返回 @{ state = 'gone'|'alive'|'unknown'; owned = $bool }；'unknown' = 探针不可用
# （拿不到 CIM 结果）——调用方按"无法核验"处理：照杀，但绝不谎称已证实整树退出。
function Get-BgjobsProcessProbe([int]$ProcessId, [string[]]$Needles) {
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    } catch {
        return @{ state = 'unknown'; owned = $false }
    }
    if ($null -eq $proc) { return @{ state = 'gone'; owned = $false } }
    $cmdline = ([string]$proc.CommandLine).ToLowerInvariant()
    $owned = $false
    foreach ($needle in @($Needles)) {
        if (-not $needle) { continue }
        if ($cmdline.Contains(([string]$needle).ToLowerInvariant())) { $owned = $true; break }
    }
    return @{ state = 'alive'; owned = $owned }
}

# 轮询到 pid 消失（≤ TimeoutMs）。返回 'gone' | 'alive' | 'unknown'
# （'unknown' 不能当作"仍活"，否则会把删得掉的任务判成失败）。
function Wait-BgjobsProcessGone([int]$ProcessId, [string[]]$Needles, [int]$TimeoutMs = 2000) {
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ($true) {
        $probe = Get-BgjobsProcessProbe $ProcessId $Needles
        if ($probe.state -ne 'alive') { return $probe.state }
        if ((Get-Date) -ge $deadline) { return 'alive' }
        Start-Sleep -Milliseconds 100
    }
}

# ── reverse lookup（缺口 B；MUST mirror buildProcessQueryScript/killByReverseLookup in lib/kill-tree.js）──
# 为什么需要：bat 引擎的任务根是 `wscript.exe launch.vbs`，**没有** run.pid；`schtasks /End`
# 只杀得掉 wscript，后代 cmd.exe / PING.EXE / conhost 照跑 ⇒ job 目录被占住 ⇒ EBUSY + 半删。
# 仅按"命令行含 jobDir/taskName"筛出任务根还不够：`PING.EXE -n 60 127.0.0.1` 这类孙进程的
# 命令行里**不含** jobDir。因此必须再按 ParentProcessId 递归展开后代，才等于 pid 路径的 `/T` 语义。
# ★ 实测澄清（2026-10-07，与宿主侧逐字同源）：后代"命令行不含 jobDir"**不会**导致漏杀 ——
#   展开后它们以 matched=$false 进击杀集逐个 taskkill /T /F；当时现场像是"后代没被纳入"，
#   **真因是回报口径**：killedPids 只回 matched 根（后代杀了不入账）。现口径：killedPids =
#   实际下过 taskkill 的每个 pid（根 + 后代，按击杀顺序），matched = 只含命令行直接命中的根；
#   整棵子树都核验（survivors 如实列出）。
# ★★ 实机复验又抓到两个只有真跑才会现形的回归（2026-10-07，已修，勿改回）：
#   ① 查询进程自命中：反查脚本正文里就含 needle（$cmdline.Contains('<jobDir>')）⇒ 正在跑查询的
#      powershell 必然命中自己、连它的 conhost 也按后代被卷进击杀集。⇒ 先算 $selfPids
#      （$PID + 其后代）整段跳过，并排除命令行带本插件 marker（BGJOBS-PROC / BGJOBS-PID）的巡检进程。
#   ② "非零 ≠ 失败"：最外层根的 /T 已经把 matched 子根带走后再对子根 taskkill，返回 128
#      （找不到进程）—— 那是"已经死了"。⇒ 判定一律以核验（survivors）为准，非零输出只当证据。
# 安全约束（务必守住）：needle 只允许**本任务唯一且随机**的 jobDir / taskName / jobId；
# 绝不按通用模式（如"所有 pwsh.exe"）杀；筛不到就**不杀**并如实报 unknown。
# 杀之前把击杀集（pid + 命令行片段）打进 Write-Warning **与**返回值，供事后追溯。
function ConvertTo-BgjobsBase64([string]$Text) {
    return [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$Text))
}

# 命令行片段（回传证据用）：压成单行 + 截断到 200 字符（与 lib/kill-tree.js 的 CMDLINE_SNIPPET_CHARS 对齐）。
function Get-BgjobsCmdlineSnippet([string]$Text) {
    $flat = ([string]$Text -replace '\s+', ' ').Trim()
    if ($flat.Length -gt 200) { return $flat.Substring(0, 200) + '…' }
    return $flat
}

# 击杀集排序（mirror orderKillSet in lib/kill-tree.js）：matched（命令行直接命中 = 任务根）在前，
# 两者各自"最外层根 → 最内层后代"，并按 pid 去重。先杀最外层 ⇒ 一次 /T 带走整棵子树。
# 父链断掉（父进程早退）认不到祖先 ⇒ 退回 pid 排序兜底，绝不因为排序失败丢进程。
function Sort-BgjobsKillSet([object[]]$Entries) {
    $byPid = @{}
    foreach ($entry in @($Entries)) { $byPid[[int]$entry.pid] = $entry }
    $ranked = @()
    foreach ($entry in @($Entries)) {
        $depth = 0
        $cursor = $entry
        $walked = @{ [int]$entry.pid = $true }
        while ($depth -lt 64) {
            $parentId = [int]$cursor.ppid
            if (-not $byPid.ContainsKey($parentId)) { break }
            if ($walked.ContainsKey($parentId)) { break }
            $walked[$parentId] = $true
            $cursor = $byPid[$parentId]
            $depth++
        }
        $ranked += @{
            entry = $entry
            rank = $(if ($entry.matched) { 0 } else { 1 })
            depth = $depth
            processId = [int]$entry.pid
        }
    }
    $ordered = @()
    $seenPids = @{}
    foreach ($item in @($ranked | Sort-Object -Property rank, depth, processId)) {
        $currentId = [int]$item.entry.pid
        if ($seenPids.ContainsKey($currentId)) { continue }
        $seenPids[$currentId] = $true
        $ordered += $item.entry
    }
    return @($ordered)
}

# 按 jobDir/taskName 反查"属于本任务"的进程（含后代）。
# 返回 @{ entries = @(@{ pid; ppid; matched; cmdline }); matchedCount; error }；失败 ⇒ 空集 + error。
function Get-BgjobsJobProcesses([string[]]$Needles) {
    $lowered = @()
    foreach ($needle in @($Needles)) {
        if ($needle) { $lowered += ([string]$needle).ToLowerInvariant() }
    }
    $entries = @()
    try {
        $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    } catch {
        return @{ entries = @(); matchedCount = 0; error = 'process query failed: ' + $_.Exception.Message }
    }
    # ★ 自排除（实机踩到的真回归）：本函数所在脚本的正文里就含 needle ⇒ 正在跑巡检的 powershell
    # 必然自命中，连它的 conhost 也会按后代被卷进击杀集。先算出"自己 + 自己的后代"，整段跳过。
    $selfPids = @{ [int]$PID = $true }
    $selfQueue = @([int]$PID)
    while ($selfQueue.Count -gt 0) {
        $selfNext = @()
        foreach ($selfParent in $selfQueue) {
            foreach ($selfChild in @($all | Where-Object { $_.ParentProcessId -eq $selfParent })) {
                if ($selfPids.ContainsKey([int]$selfChild.ProcessId)) { continue }
                $selfPids[[int]$selfChild.ProcessId] = $true
                $selfNext += [int]$selfChild.ProcessId
            }
        }
        $selfQueue = @($selfNext)
    }
    foreach ($process in $all) {
        if ($selfPids.ContainsKey([int]$process.ProcessId)) { continue }
        $cmdline = ([string]$process.CommandLine).ToLowerInvariant()
        # 本插件自己的查询/探针进程（命令行 = 脚本正文，含 marker）一并排除
        if ($cmdline.Contains('bgjobs-proc') -or $cmdline.Contains('bgjobs-pid')) { continue }
        $matched = $false
        foreach ($needle in $lowered) {
            if ($cmdline.Contains($needle)) { $matched = $true; break }
        }
        $entries += @{
            pid = [int]$process.ProcessId
            ppid = [int]$process.ParentProcessId
            cmdline = [string]$process.CommandLine
            matched = $matched
        }
    }
    $seen = @{}
    $ordered = @()
    foreach ($entry in @($entries | Where-Object { $_.matched })) {
        if ($seen.ContainsKey($entry.pid)) { continue }
        $seen[$entry.pid] = $true
        $ordered += $entry
    }
    $queue = @($ordered)
    while ($queue.Count -gt 0) {
        $next = @()
        foreach ($parent in $queue) {
            foreach ($child in @($entries | Where-Object { $_.ppid -eq $parent.pid })) {
                if ($seen.ContainsKey($child.pid)) { continue }
                $seen[$child.pid] = $true
                $ordered += $child
                $next += $child
            }
        }
        $queue = @($next)
    }
    return @{ entries = @($ordered); matchedCount = @($ordered | Where-Object { $_.matched }).Count; error = $null }
}

# 反查兜底（mirror killByReverseLookup in lib/kill-tree.js）：matched（命令行直接命中）与
# 按父链展开的后代**全部**纳入击杀集，最外层根先杀（`/T` 一次带走子树），逐个补刀后代。
# 返回 @{ ok; skipped; matched; killedPids; killed; survivors; stderr; error; processFound; note }；
#   skipped ∈ 'no-match'；processFound = 有没有本任务的活进程（$true / $false / $null=无法判定）。
#   killedPids = 实际下过 taskkill 的每个 pid（根 + 后代）；killed = 每个 pid 的证据（含命令行片段）。
# 筛不到任何匹配进程 ⇒ **绝不杀**（skipped='no-match'，由调用方如实回"未发现活进程"——
# kill 什么都不删；要清记录是**调用方**去调 delete 的事）。
function Stop-BgjobsJobProcessesByLookup([string[]]$Needles, [string]$Workdir, [int]$TimeoutMs = 2000, [string]$Status = '') {
    $found = Get-BgjobsJobProcesses $Needles
    if ($found.error) { return @{ ok = $false; error = $found.error; processFound = $null } }
    $matched = @($found.entries | Where-Object { $_.matched })
    if ($matched.Count -eq 0) {
        # ★ 用户裁定（2026-10-08 更正边界）：**未发现活进程** ⇒ 无论 status 记的是 running 还是 done，
        #   只要筛不到任何匹配进程就不是失败（没什么可杀）⇒ kill 如实回"未发现活进程"、**什么都不删**；
        #   要清记录**由调用方**去调 delete（kill 内部绝不转 delete）。running 时附 note 说明。
        #   （旧口径在这里回 ok=$false「无法证实已退出」，已按裁定作废。）
        return @{
            ok = $true; skipped = 'no-match'; processFound = $false
            note = $(if ($Status -eq 'running') { 'no pid file and no process matched jobDir/taskName —— 未发现该任务的活进程 ⇒ 无可终止（kill 只终止进程，本次未删除任何记录）；要清记录请调用 delete' } else { '' })
        }
    }
    # ★ 动手前把击杀集（pid + 命令行片段）打进日志**和**返回值 —— 事后可追溯、可复核。
    $killSet = @()
    foreach ($entry in @(Sort-BgjobsKillSet @($found.entries))) {
        $killSet += @{
            pid = [int]$entry.pid
            ppid = [int]$entry.ppid
            matched = [bool]$entry.matched
            cmdline = (Get-BgjobsCmdlineSnippet $entry.cmdline)
        }
    }
    $summary = @($killSet | ForEach-Object { "$(if ($_.matched) { 'root' } else { 'desc' }) $($_.pid) «$($_.cmdline)»" }) -join ' | '
    Write-Warning "[bgjobs] reverse lookup kill set: $($matched.Count) matched + $($killSet.Count - $matched.Count) descendant(s) —— $summary"
    $rootNotes = @()
    $descendantNotes = @()
    $killedPids = @()
    foreach ($spec in $killSet) {
        $killedPids += [int]$spec.pid
        $kill = Invoke-BgjobsSchtasks @('/PID', [string]$spec.pid, '/T', '/F') $Workdir $script:BgjobsTaskkill
        if ($kill.exitCode -ne 0) {
            $detail = ([string]$kill.stderr + [string]$kill.stdout).Trim()
            $line = "taskkill /PID $($spec.pid) /T /F exit $($kill.exitCode)" + $(if ($detail) { ": $detail" } else { '' })
            # ★ 非零 ≠ 失败（实机踩到）：最外层根的 /T 已把 matched 子根带走时，对子根再 taskkill
            # 会返回 128（找不到进程）——那是"已经死了"。成败一律以核验（survivors）为准。
            if ($spec.matched) { $rootNotes += $line } else { $descendantNotes += $line }
        }
    }
    # ★ 核验整棵子树（不只根）：共用一份 TimeoutMs 预算逐个轮询到消失；还在的如实列出。
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $survivors = @()
    foreach ($spec in $killSet) {
        $remaining = [int][Math]::Max(0, ($deadline - (Get-Date)).TotalMilliseconds)
        $observed = Wait-BgjobsProcessGone ([int]$spec.pid) $Needles $remaining
        if ($observed -eq 'alive') { $survivors += [int]$spec.pid }
    }
    $matchedPids = @($matched | ForEach-Object { [int]$_.pid })
    $stderr = (@($rootNotes) + @($descendantNotes)) -join ' | '
    if ($survivors.Count -gt 0) {
        return @{ ok = $false; error = "reverse lookup: $($survivors.Count)/$($killedPids.Count) 个进程在 taskkill 后仍存活（$($survivors -join ', ')）" + $(if ($stderr) { "（taskkill stderr: $stderr）" } else { '' }); matched = $matchedPids; killedPids = $killedPids; killed = $killSet; survivors = $survivors; stderr = $stderr; processFound = $true }
    }
    return @{ ok = $true; matched = $matchedPids; killedPids = $killedPids; killed = $killSet; stderr = $stderr; processFound = $true }
}

# ── kill / delete：**两种语义**（镜像 lib/core/web.js 的 killJob / removeJob；用户裁定 2026-10-07，
#    边界 2026-10-08 更正）──
# ★★ 更正（2026-10-08）：**kill 内部【没有】delete 分支** —— 一个 kill 请求永远只是"终止进程"，
#   绝不偷偷变成"删除记录"。「进程不存在 ⇒ delete 语义」的正确读法是**「调用方在无活进程时该去调
#   delete」**，不是"kill 替它转 delete"；两个动作各自纯粹，"谁该做什么"由**调用方**决定。
#   落地：无活进程 ⇒ kill 回 `mode = 'absent'` + `killed = $false` + note「未发现该任务的活进程…」，
#   **不杀进程、不删任何记录、也不动计划任务注册**。
# ★ kill = **只终止进程**（`Stop-BgjobsJobProcesses`）：pid 文件 → 归属核验 → taskkill /PID /T /F
#   → ≤2s 核验整树消失；无 pid 文件（bat 引擎 / 0.1.94 前的历史任务）⇒ 按 jobDir/taskName 反查进程树；
#   原路径失败 ⇒ 再试一次反查兜底（归属核验失败除外：pid 与本任务无关，反查只会把无关进程的后代卷进来）。
#   ★ kill **不删任何记录**：job 目录 / 中央索引**全部保留**；杀成后补写被终止的终态
#   （exitcode.txt = 1（taskkill /F 记录的真值）+ job.json 的 exitCodeSource:'killed'/killedAt/killedBy）
#   ⇒ 之后 `bgjob_wait` / 面板读到的是**非 0 退出码**，绝不被读成"成功完成"。要彻底清掉 ⇒ 之后**再调** delete。
# ★ delete = **只删记录**（`Remove-BgjobsJob`）：先确认没有活进程（有 ⇒ 拒绝并提示先 kill），
#   再删 job 目录 + sandbox 临时根 + 中央索引。★ 清理与报告解耦（缺口 A）：目录删不净**不再提前
#   return** —— 中央索引清理**无条件执行**（否则留下指向已不存在目录的僵尸条目）；失败先记 failures/
#   warnings，最后据此定 ok 与 error。★ delete 也**不越界到 kill**（不为"对称"去杀进程）。
# ★ 判据是 Get-BgjobsJobProcessState 的三态（live / absent / unknown），**不靠错误文案猜**。
# ★★ unknown ⇒ **默认什么也不做**（用户裁定，2026-10-08）：无法判定有没有活进程时，两条路径都只回
#   警告 + `needsForce = $true`（不杀进程、不删任何记录）；**只有显式 force**（CLI `-Force` /
#   GUI 确认框，宿主侧还有 HTTP `?force=1`）才越过这道门槛 ⇒ 返回值带 `forced = $true`。
#   边界：live（kill 语义）与 absent（**未发现活进程**）**完全不受 force 影响**：传不传一个样，也不打 forced。

# 只读判定："本任务到底有没有活进程"（delete 的前置条件；绝不杀任何东西、绝不改状态）。
# 镜像 lib/kill-tree.js 的 detectJobProcesses，返回 @{ state; ... }，state ∈ live|absent|unknown：
#   live    = 有活进程（pid 文件指向的进程存活且属于本任务；或反查到 matched 根）；
#   absent  = 确认没有本任务的活进程（reason ∈ pid-gone / pid-reused / no-match）；
#   unknown = **无法判定**（探针或反查本身跑不起来）——调用方必须保守处理，绝不可当 absent 去删记录。
function Get-BgjobsJobProcessState([object]$Job, [string]$TaskName) {
    $needles = @($Job.jobDir, $TaskName, $Job.id) | Where-Object { $_ }
    $found = Get-BgjobsJobPid $Job.jobDir
    if ($null -ne $found) {
        $probe = Get-BgjobsProcessProbe ([int]$found.pid) $needles
        if ($probe.state -eq 'gone') { return @{ state = 'absent'; reason = 'pid-gone'; pid = [int]$found.pid; file = $found.file } }
        if ($probe.state -eq 'unknown') {
            return @{ state = 'unknown'; pid = [int]$found.pid; file = $found.file; error = "进程存活核验不可用（探针无输出）：无法判定 PID $($found.pid) ($($found.file)) 是否仍在运行" }
        }
        # pid 复用防护：run.pid 记的一定是 run.ps1（命令行必然含 jobDir/taskName）；不含 ⇒ 该 pid 已被系统
        # 复用给无关进程 ⇒ **本任务的进程不存在**（不是"有活进程"）。绝不误杀，也不据此拒绝删除。
        if ($found.file -eq 'run.pid' -and -not $probe.owned) {
            return @{ state = 'absent'; reason = 'pid-reused'; pid = [int]$found.pid; file = $found.file }
        }
        return @{ state = 'live'; pid = [int]$found.pid; file = $found.file }
    }
    $listed = Get-BgjobsJobProcesses $needles
    if ($listed.error) { return @{ state = 'unknown'; error = [string]$listed.error } }
    $matched = @($listed.entries | Where-Object { $_.matched })
    if ($matched.Count -eq 0) { return @{ state = 'absent'; reason = 'no-match' } }
    return @{ state = 'live'; matched = @($matched | ForEach-Object { [int]$_.pid }) }
}

# kill 成功后的**终态补写**（镜像 lib/core/web.js 的 markJobKilled；★ 只动任务自己的终态，不删记录）：
#   ① 计划任务注册收尾：/End（running）+ /Delete（幂等）—— 计划任务**不是任务记录**；
#   ② `exitcode.txt` = 1（= $script:BgjobsKilledExitCode）：runner 被 taskkill /F 杀掉时根本没机会写，
#      host 侧必须补（否则 wait 会一直等到超时、面板永远显示 running）；1 = `taskkill /F` 在内核里
#      记录的**真值**（退出码由终止方传入），与 lib/kill-tree.js 的 KILLED_EXIT_CODE 同值；
#   ③ job.json 落 status/exitCode/finishedAt + exitCodeSource:'killed' + killedAt/killedBy
#      ⇒ **来源**只能靠这三个字段判：补写的 1 与"任务自己以 1 退出"同值，schtasks 的 Last Result
#      也分不清"runner 自己报了 1"与"runner 被杀成 1"（不能当证据）；
#   ④ 任务已 done（典型：mcp 任务的孤儿 server）被 kill：终态与退出码**保持原样**，绝不覆盖。
function Set-BgjobsJobKilled([object]$Job, [string]$TaskName) {
    $out = @{ ok = $true; exitcodeWritten = $false; jobJsonUpdated = $false; terminalKept = $false; warnings = @() }
    if ($Job.status -eq 'running') {
        $end = Invoke-BgjobsSchtasks @('/End', '/TN', $TaskName) $Job.workdir
        if ($end.exitCode -ne 0) { $out.warnings += "schtasks /End exit $($end.exitCode): " + ([string]$end.stderr + [string]$end.stdout).Trim() }
    }
    $del = Invoke-BgjobsSchtasks @('/Delete', '/TN', $TaskName, '/F') $Job.workdir
    if ($del.exitCode -ne 0) { $out.warnings += "schtasks /Delete exit $($del.exitCode): " + ([string]$del.stderr + [string]$del.stdout).Trim() }
    if ($Job.status -eq 'done') { $out.terminalKept = $true; return $out }
    $at = Get-BgjobsNowMs
    $exitcodePath = if ($Job.exitcodePath) { $Job.exitcodePath } else { Join-Path $Job.jobDir 'exitcode.txt' }
    try {
        [System.IO.File]::WriteAllText($exitcodePath, [string]$script:BgjobsKilledExitCode, (New-Object System.Text.UTF8Encoding($false)))
        $out.exitcodeWritten = $true
    } catch {
        $out.ok = $false
        $out.error = 'write exitcode.txt failed: ' + $_.Exception.Message
    }
    $jsonPath = Join-Path $Job.jobDir 'job.json'
    try {
        $meta = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $meta.status = 'done'
        $meta.exitCode = $script:BgjobsKilledExitCode
        $meta.finishedAt = $at
        $meta.exitCodeSource = 'killed'
        $meta.killedAt = $at
        $meta.killedBy = 'cli'
        [System.IO.File]::WriteAllText($jsonPath, ($meta | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
        $out.jobJsonUpdated = $true
    } catch {
        $out.ok = $false
        $out.error = (if ($out.error) { [string]$out.error + ' | ' } else { '' }) + 'write job.json failed: ' + $_.Exception.Message
    }
    return $out
}

# ── kill：只终止进程（记录一律保留）────────────────────────────────────────
# -Force：**只用于越过 unknown 门槛**（无法判定有没有活进程 ⇒ 默认什么都不做）。
function Stop-BgjobsJobProcesses([string]$Id, [switch]$Force) {
    $job = Get-BgjobsJob $Id
    if ($null -eq $job) { return @{ ok = $false; error = "job not found: $Id" } }
    $taskName = if ($job.taskName) { $job.taskName } else { 'dsh-bgj-' + $Id }
    $warnings = @()
    $failures = @()
    $killedPid = $null
    $killedFile = ''
    $killedVerified = $false
    $processFound = $null
    # 反查兜底的证据（mirror lib/core/web.js 的 killedPids / matchedPids / killedProcesses / survivors）：
    # killedPids = 实际下过 taskkill 的每个 pid（根 + 后代）；killedProcesses = 每个 pid + 命令行片段。
    $killedPids = @()
    $matchedPids = @()
    $killedProcesses = @()
    $survivors = @()
    # ① 进程树终止（必须排在 /End 之前：/End 够不到后代 runner 与受限子进程）
    $needles = @($job.jobDir, $taskName, $Id)
    $found = Get-BgjobsJobPid $job.jobDir
    if ($null -ne $found) {
        $before = Get-BgjobsProcessProbe ([int]$found.pid) $needles
        # 归属硬门禁只对 run.pid 生效（它一定是 run.ps1 进程，命令行必然含 jobDir/taskName）；
        # mcp-server.pid 记的是用户配置的 stdio server 子进程，命令行天然不含 jobDir ⇒
        # 沿用既有"尽力而为"语义，不因归属不明拒绝（否则正常孤儿回收全被误判）。
        # ★ 门禁只在 state='alive' 时生效（与 lib/kill-tree.js 逐字同源）：'unknown'（探针跑不起来）
        #   是"无法核验"而非"归属不明"⇒ 按既有口径照杀（只是拿不到 verified）。
        $strict = ($found.file -eq 'run.pid')
        if ($before.state -eq 'gone') {
            # 进程已退出：pid 文件是陈迹，无需杀（done 任务的常态）⇒ 本任务进程不存在（delete 语义）
            $processFound = $false
        } elseif ($strict -and $before.state -eq 'alive' -and -not $before.owned) {
            $reason = "pid reuse guard: PID $($found.pid) ($($found.file)) 的命令行不含本任务 jobDir/taskName —— 拒绝 kill（不误杀无关进程）"
            # running + 该 pid 上的活进程不是本任务的：保守按 kill 失败如实报（绝不误杀无关进程）；
            # done 任务则是陈旧 pid 文件 ⇒ 本任务进程不存在，记 warning 即可（不阻断 delete）。
            $processFound = $true
            if ($job.status -eq 'running') {
                # pid 与本任务无关 ⇒ 不触发反查（反查只会把无关进程的后代卷进来），只如实报
                $failures += $reason
            } else {
                $warnings += $reason
            }
        } else {
            $processFound = $true
            $primaryError = ''
            $kill = Invoke-BgjobsSchtasks @('/PID', [string]$found.pid, '/T', '/F') $job.workdir $script:BgjobsTaskkill
            if ($kill.exitCode -ne 0) {
                $detail = ([string]$kill.stderr + [string]$kill.stdout).Trim()
                $primaryError = "taskkill /PID $($found.pid) /T /F exit $($kill.exitCode)" + $(if ($detail) { ": $detail" } else { '' })
            } else {
                $after = Wait-BgjobsProcessGone $found.pid $needles 2000
                if ($after -eq 'alive') {
                    $primaryError = "PID $($found.pid) ($($found.file)) 在 taskkill 后 2000ms 内仍存活"
                } else {
                    $killedPid = $found.pid
                    $killedFile = $found.file
                    $killedVerified = ($after -eq 'gone')
                    if ($after -eq 'unknown') { $warnings += 'pid 存活核验不可用（探针不可用）：taskkill 已执行但未证实整树退出' }
                }
            }
            if ($primaryError) {
                # 原路径失败 ⇒ 再试反查兜底（反查自身"筛不到"不算错误，保留原错误）
                $fallback = Stop-BgjobsJobProcessesByLookup $needles $job.workdir 2000 $job.status
                if ($fallback.ok -and $fallback.skipped -ne 'no-match') {
                    $killedPid = $found.pid
                    $killedFile = $found.file
                    $killedVerified = $true
                    $killedPids = @($fallback.killedPids)
                    $matchedPids = @($fallback.matched)
                    $killedProcesses = @($fallback.killed)
                    $warnings += $primaryError + ' ⇒ 已按 jobDir/taskName 反查进程树兜底并击杀成功'
                } else {
                    $extra = if ($fallback.ok -and $fallback.skipped -eq 'no-match') { '；按 jobDir/taskName 反查亦未匹配到任何进程' } else { '；反查兜底亦失败: ' + [string]$fallback.error }
                    $failures += $primaryError + $extra
                    # 失败也把证据带上（哪些 pid 杀过 / 哪些还活着），供事后追溯
                    if ($fallback.killedPids) { $killedPids = @($fallback.killedPids) }
                    if ($fallback.matched) { $matchedPids = @($fallback.matched) }
                    if ($fallback.killed) { $killedProcesses = @($fallback.killed) }
                    if ($fallback.survivors) { $survivors = @($fallback.survivors) }
                }
            }
        }
    } else {
        # 无 pid 文件（bat 引擎 / 历史任务）⇒ 只走反查
        $fallback = Stop-BgjobsJobProcessesByLookup $needles $job.workdir 2000 $job.status
        $processFound = $fallback.processFound
        if (-not $fallback.ok) {
            $failures += 'kill process tree failed: ' + [string]$fallback.error
            if ($fallback.killedPids) { $killedPids = @($fallback.killedPids) }
            if ($fallback.matched) { $matchedPids = @($fallback.matched) }
            if ($fallback.killed) { $killedProcesses = @($fallback.killed) }
            if ($fallback.survivors) { $survivors = @($fallback.survivors) }
        } elseif ($fallback.skipped -eq 'no-match') {
            $warnings += $(if ($fallback.note) { [string]$fallback.note } else { 'no pid file and no process matched jobDir/taskName —— 进程不存在 ⇒ delete 语义（只删记录，不杀任何进程）' })
        } else {
            $killedVerified = $true
            $killedPids = @($fallback.killedPids)
            $matchedPids = @($fallback.matched)
            $killedProcesses = @($fallback.killed)
            $warnings += 'no pid file ⇒ killed by reverse lookup (jobDir/taskName): ' + (@($fallback.killedPids) -join ',')
        }
    }
    # ── 返回值：mode 标明本次实际走了哪种语义；★ 记录一律保留（recordsKept = 契约，不是提示）──
    # ★★ mode = 'absent'：**未发现本任务的活进程**（不是"转 delete"—— 本函数里没有任何删除记录
    #    的代码路径；要清记录请调用方去调 Remove-BgjobsJob）。字段名与其余取值一字未改。
    $mode = if ($processFound -eq $true) { 'kill' } elseif ($processFound -eq $false) { 'absent' } else { 'unknown' }
    $result = @{
        mode = $mode
        jobId = $Id
        killed = ($processFound -eq $true -and @($failures).Count -eq 0)
        recordsKept = $true
    }
    if ($null -ne $killedPid) {
        $result.killedPid = [int]$killedPid
        $result.killedFile = $killedFile
        $result.killedVerified = $killedVerified
    }
    # 反查兜底证据（与宿主侧 /bgjobs/kill 的 JSON 字段同名同义）
    if (@($killedPids).Count -gt 0) { $result.killedPids = @($killedPids) }
    if (@($matchedPids).Count -gt 0) { $result.matchedPids = @($matchedPids) }
    if (@($killedProcesses).Count -gt 0) { $result.killedProcesses = @($killedProcesses) }
    if (@($survivors).Count -gt 0) { $result.survivors = @($survivors) }
    # ★★ unknown 门槛（用户裁定，2026-10-08）：无法判定有没有活进程 ⇒ 默认什么都不做，只警告 + 要求 force。
    #    kill 在 unknown 下本来就无从下手（反查查询本身跑不起来 ⇒ 连"杀谁"都不知道）⇒ force 只解除门槛、
    #    绝不谎报成功：真杀掉了才会是 ok = $true（文案与宿主 lib/core/web.js 的 unknownWarning/unknownError 同源）。
    if ($mode -eq 'unknown') {
        $unknownReason = if (@($failures).Count -gt 0) { (@($failures) -join ' | ') } else { '进程查询本身跑不起来' }
        if (-not $Force) {
            $result.ok = $false
            $result.needsForce = $true
            $result.warnings = @($warnings) + @('无法判定该任务的进程状态（' + $unknownReason + '）：按裁定默认不执行，仅警告')
            $result.error = '无法判定本任务是否仍有活进程：' + $unknownReason + ' —— 已按裁定不执行（未终止任何进程，记录原封不动）；如确认要继续，请显式加 force（HTTP ?force=1 / CLI -Force / GUI 确认框）'
            return $result
        }
        $result.forced = $true
        $warnings += '无法判定该任务的进程状态：已按显式 force 继续执行（' + $unknownReason + '）'
    }
    if (@($failures).Count -gt 0) {
        # ★ 唯一的"kill 失败"：进程还在、且杀不掉（归属核验失败 / taskkill 非零且核验仍活 / 杀后仍活）。
        $result.ok = $false
        $result.error = (@($failures) -join ' | ')
        if (@($warnings).Count -gt 0) { $result.warnings = @($warnings) }
        return $result
    }
    if ($mode -eq 'absent') {
        # ★★ 未发现活进程 ⇒ kill **只如实回**「未发现该任务的活进程」：不杀任何进程、不删任何记录，
        #    也不替调用方转 delete（2026-10-08 更正掉的就是这个"内部转 delete"的分支）。
        $result.ok = $true
        $result.note = '未发现该任务的活进程 ⇒ 无可终止；kill 只终止进程，本次未删除任何记录（job 目录/索引/注册表原封不动），要清记录请调用 delete'
        if (@($warnings).Count -gt 0) { $result.warnings = @($warnings) }
        return $result
    }
    # 有活进程且整树已消失 ⇒ /End + /Delete（计划任务注册收尾）+ 被终止的终态补写（★ 记录一律保留）
    $terminal = Set-BgjobsJobKilled $job $taskName
    $warnings += @($terminal.warnings)
    $result.ok = [bool]$terminal.ok
    $result.exitCode = $script:BgjobsKilledExitCode
    $result.exitcodeWritten = [bool]$terminal.exitcodeWritten
    $result.jobJsonUpdated = [bool]$terminal.jobJsonUpdated
    $result.terminalKept = [bool]$terminal.terminalKept
    if (-not $terminal.ok) { $result.error = [string]$terminal.error }
    if (@($warnings).Count -gt 0) { $result.warnings = @($warnings) }
    return $result
}

# ── delete：只删记录（"进程不存在"才允许；有活进程 ⇒ 拒绝并提示先 kill）────────────────
# -Force：**只用于越过 unknown 门槛**（无法判定有没有活进程 ⇒ 默认不删任何记录）。
function Remove-BgjobsJob([string]$Id, [switch]$NoDeleteDir, [switch]$Force) {
    $job = Get-BgjobsJob $Id
    if ($null -eq $job) { return @{ ok = $false; error = "job not found: $Id" } }
    $taskName = if ($job.taskName) { $job.taskName } else { 'dsh-bgj-' + $Id }
    $warnings = @()
    $failures = @()
    $forced = $false
    # ⓪ 前置判定：delete 只删记录 ⇒ 先确认没有本任务的活进程（有活进程是 kill 的事）。
    $state = Get-BgjobsJobProcessState $job $taskName
    if ($state.state -eq 'live') {
        $where = if ($null -ne $state.pid) { "PID $($state.pid) ($($state.file)) 仍存活" } else { '按 jobDir/taskName 反查到活进程 ' + (@($state.matched) -join ', ') }
        $rejected = @{
            ok = $false; mode = 'kill'; removed = $Id
            jobDirRemoved = $false; registryRemoved = $false; indexRemoved = $false
            error = "job is still running（$where）—— delete 只删记录、不杀进程：请先 kill（Stop-BgjobsJobProcesses），再 delete"
        }
        if ($null -ne $state.pid) { $rejected.livePid = [int]$state.pid; $rejected.liveFile = $state.file }
        return $rejected
    }
    if ($state.state -eq 'unknown') {
        # ★★ unknown 门槛（用户裁定，2026-10-08）：**无法判定**有没有活进程 ⇒ **不删任何记录**，只警告 + 要求 force。
        #    删记录有可能删出一个"看不见但还在跑"的孤儿 ⇒ 默认一律拦下（running / done 同口径，不再有例外：
        #    旧口径"done 记 warning 后放行"已作废）。
        $unknownReason = [string]$state.error
        if (-not $Force) {
            return @{
                ok = $false; mode = 'unknown'; removed = $Id
                jobDirRemoved = $false; registryRemoved = $false; indexRemoved = $false
                needsForce = $true
                warnings = @('无法判定该任务的进程状态（' + $unknownReason + '）：按裁定默认不执行，仅警告')
                error = '无法判定本任务是否仍有活进程：' + $unknownReason + ' —— 已按裁定不执行（未删除任何记录，job 目录/注册表/索引原封不动）；如确认要继续，请显式加 force（HTTP ?force=1 / CLI -Force / GUI 确认框）'
            }
        }
        $forced = $true
        $warnings += '无法判定该任务的进程状态：已按显式 force 继续执行 delete（只删记录，不杀任何进程）—— ' + $unknownReason
    }
    if ($state.reason -eq 'pid-reused') {
        $warnings += "pid reuse guard: PID $($state.pid) ($($state.file)) 的命令行不含本任务 jobDir/taskName —— 该 pid 已被系统复用给无关进程；本任务进程不存在（不误杀）"
    }
    # ① 计划任务注册收尾（**不是任务记录**）：/End（running）+ /Delete（幂等：任务已自删时非零属正常）
    if ($job.status -eq 'running') {
        $end = Invoke-BgjobsSchtasks @('/End', '/TN', $taskName) $job.workdir
        if ($end.exitCode -ne 0) {
            $warnings += "schtasks /End exit $($end.exitCode): " + ([string]$end.stderr + [string]$end.stdout).Trim()
        }
    }
    $del = Invoke-BgjobsSchtasks @('/Delete', '/TN', $taskName, '/F') $job.workdir
    if ($del.exitCode -ne 0) {
        $warnings += "schtasks /Delete exit $($del.exitCode): " + ([string]$del.stderr + [string]$del.stdout).Trim()
    }
    # ② 删 job 目录（删不掉如实报；★ 不再提前 return —— 索引清理必须照跑）
    $jobDirRemoved = $true
    if ((-not $NoDeleteDir) -and (Test-Path -LiteralPath $job.jobDir)) {
        try {
            Remove-Item -LiteralPath $job.jobDir -Recurse -Force -ErrorAction Stop
        } catch {
            $jobDirRemoved = $false
            $failures += 'remove job dir failed: ' + $_.Exception.Message
        }
    }
    # ③ sandbox 私有临时根（宿主提交时写进 job.json）：尽力而为，失败记 warning
    if ($job.sandboxTempPath -and (Test-Path -LiteralPath $job.sandboxTempPath)) {
        try {
            Remove-Item -LiteralPath $job.sandboxTempPath -Recurse -Force -ErrorAction Stop
        } catch {
            $warnings += 'remove sandbox temp failed: ' + $_.Exception.Message
        }
    }
    # ④ remove from central index：**无条件执行**（缺口 A 的核心：目录删不净也要清掉僵尸条目）
    $idx = Get-BgjobsIndex
    $newJobs = @($idx.jobs | Where-Object { $_.id -ne $Id })
    $payload = @{ version = 1; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); jobs = $newJobs }
    [System.IO.File]::WriteAllText($script:BgjobsIndexPath, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    $result = @{
        ok = (@($failures).Count -eq 0)
        mode = 'delete'
        removed = $Id
        jobDirRemoved = $jobDirRemoved
        registryRemoved = $true
        indexRemoved = $true
    }
    if ($forced) { $result.forced = $true }
    if (@($failures).Count -gt 0) { $result.error = (@($failures) -join ' | ') }
    if (@($warnings).Count -gt 0) { $result.warnings = @($warnings) }
    return $result
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
    'gui.kill' = if ($script:BgjobsLangZh) { '⏹ 终止进程' } else { '⏹ Kill' }
    'gui.delete' = if ($script:BgjobsLangZh) { '🗑 删除记录' } else { '🗑 Delete' }
    'gui.cleanup' = if ($script:BgjobsLangZh) { '🧹 清理' } else { '🧹 Cleanup' }
    'gui.index' = if ($script:BgjobsLangZh) { '🗺 重建索引' } else { '🗺 Rebuild index' }
    'col.id' = 'ID'
    'col.name' = if ($script:BgjobsLangZh) { '名称' } else { 'Name' }
    'col.status' = if ($script:BgjobsLangZh) { '状态' } else { 'Status' }
    'col.exit' = if ($script:BgjobsLangZh) { '退出码' } else { 'Exit' }
    'col.notify' = if ($script:BgjobsLangZh) { '通知' } else { 'Notified' }
    'notify.done' = if ($script:BgjobsLangZh) { '已通知' } else { 'notified' }
    'notify.pending' = if ($script:BgjobsLangZh) { '待通知' } else { 'pending' }
    'col.finished' = if ($script:BgjobsLangZh) { '完成时间' } else { 'Finished' }
    'col.workdir' = if ($script:BgjobsLangZh) { '工作目录' } else { 'Workdir' }
    'status.count' = if ($script:BgjobsLangZh) { '任务数：{0}    索引：{1}' } else { 'Jobs: {0}    Index: {1}' }
    'detail.log' = if ($script:BgjobsLangZh) { '-- 最近日志 --' } else { '-- recent log --' }
    'detail.nolog' = '(no log yet)'
    'detail.garbled' = if ($script:BgjobsLangZh) { '（⚠ 此日志在写入时发生编码损坏：任务进程以 GBK 输出却被按 UTF-8 记录，中文已不可恢复。pwsh 引擎的新任务已修复此问题。）' } else { '(⚠ This log was corrupted while being written: the job emitted GBK but it was recorded as UTF-8, so Chinese is unrecoverable. New pwsh-engine jobs are fixed.)' }
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
    'msg.kill' = if ($script:BgjobsLangZh) { '终止任务 {0}（{1}）的进程树？只杀进程，任务记录（目录/索引）保留；要彻底清掉请随后用【删除记录】。' } else { 'Terminate the process tree of job {0} ({1})? Processes only — the job records (dir/index) are KEPT; use Delete to remove them afterwards.' }
    'msg.kill.done' = if ($script:BgjobsLangZh) { '任务 {0}（{1}）已完成：回收它可能残留的进程（如 MCP server 子进程）？不删任何记录。' } else { 'Job {0} ({1}) is finished: reap any leftover processes (e.g. an MCP server child)? No records are removed.' }
    'msg.kill.failed' = if ($script:BgjobsLangZh) { '终止失败：{0}' } else { 'Kill failed: {0}' }
    # ★ absent 提示的"下一步"指引（用户裁定，2026-10-08）：kill 回 ok:true + mode:'absent' 时，
    #   "未终止任何东西、记录原封未动"这句话由 host 如实回传（$r.note，唯一来源 = lib/core/web.js
    #   的 absent 分支），GUI 不复制；这里只补一句"要清记录该点哪个按钮"。
    'msg.kill.absent.hint' = if ($script:BgjobsLangZh) { '要清记录请用「🗑 删除记录」。' } else { 'Use "🗑 Delete records" to remove the records.' }
    'msg.delete' = if ($script:BgjobsLangZh) { '删除任务 {0}（{1}）的记录（job 目录 + 中央索引）？只删记录、不杀进程；还有活进程时会被拒绝。' } else { 'Delete the records of job {0} ({1}) (job dir + central index)? Records only, no process is killed; refused while a live process remains.' }
    'msg.delete.failed' = if ($script:BgjobsLangZh) { '删除失败：{0}' } else { 'Delete failed: {0}' }
    'msg.delete.hint' = if ($script:BgjobsLangZh) { '提示：该任务可能仍在运行 —— 请先【终止进程】，再删除记录。' } else { 'Hint: the job may still be running — kill it first, then delete the records.' }
    # ★ unknown 门槛（用户裁定，2026-10-08）：无法判定进程状态 ⇒ 默认什么都不做；GUI 用**警告型确认框**
    #   把"继续将直接清理/删除"讲清楚，用户点「是」= force（口径见 docs/developer.md 的「kill / delete 语义」）。
    'msg.unknown.title' = if ($script:BgjobsLangZh) { '无法判定进程状态' } else { 'Cannot determine process state' }
    'msg.unknown.kill' = if ($script:BgjobsLangZh) { "无法判定任务 {0}（{1}）的进程状态：进程探针/反查本身跑不起来，因此既不能确认它还在跑、也不能确认它已经停了。`n`n继续将直接终止其进程树（任务记录仍保留）。确定继续吗？" } else { "Cannot determine the process state of job {0} ({1}): the process probe/lookup itself failed, so it is impossible to tell whether it is still running or already gone.`n`nContinuing will terminate its process tree directly (the job records are still kept). Continue?" }
    'msg.unknown.delete' = if ($script:BgjobsLangZh) { "无法判定任务 {0}（{1}）的进程状态：进程探针/反查本身跑不起来，因此既不能确认它还在跑、也不能确认它已经停了。`n`n继续将直接清理删除其记录（job 目录 + 中央索引），可能留下一个看不见却仍在运行的孤儿进程。确定继续吗？" } else { "Cannot determine the process state of job {0} ({1}): the process probe/lookup itself failed, so it is impossible to tell whether it is still running or already gone.`n`nContinuing will remove its records (job dir + central index) and may leave an orphan process you can no longer see. Continue?" }
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
    # auto-done: run shutdown / hibernate / a script after all jobs finish
    'gui.autodone' = if ($script:BgjobsLangZh) { '🌙 完成后…' } else { '🌙 Auto-off…' }
    'gui.autodone.cancel' = if ($script:BgjobsLangZh) { '✖ 取消预约' } else { '✖ Cancel schedule' }
    'dlg.autodone.title' = if ($script:BgjobsLangZh) { '所有任务完成后自动执行' } else { 'Auto action when all jobs finish' }
    'dlg.autodone.action' = if ($script:BgjobsLangZh) { '动作：' } else { 'Action: ' }
    'dlg.autodone.action.shutdown' = if ($script:BgjobsLangZh) { '关机' } else { 'Shutdown' }
    'dlg.autodone.action.hibernate' = if ($script:BgjobsLangZh) { '休眠' } else { 'Hibernate' }
    'dlg.autodone.action.script' = if ($script:BgjobsLangZh) { '执行脚本' } else { 'Run script' }
    'dlg.autodone.delay' = if ($script:BgjobsLangZh) { '延迟（秒）：' } else { 'Delay (s): ' }
    'dlg.autodone.delay30' = if ($script:BgjobsLangZh) { '30 秒' } else { '30 s' }
    'dlg.autodone.delay60' = if ($script:BgjobsLangZh) { '60 秒' } else { '60 s' }
    'dlg.autodone.script' = if ($script:BgjobsLangZh) { '脚本路径：' } else { 'Script path: ' }
    'dlg.autodone.args' = if ($script:BgjobsLangZh) { '脚本参数：' } else { 'Script args: ' }
    'dlg.autodone.exampleToast' = if ($script:BgjobsLangZh) { '示例：完成后倒计时 + Toast 通知' } else { 'Example: countdown + Toast on finish' }
    'dlg.autodone.noRunning' = if ($script:BgjobsLangZh) { '当前没有运行中的任务，无需预约。' } else { 'No running jobs; nothing to schedule.' }
    'dlg.autodone.noscript' = if ($script:BgjobsLangZh) { '请填写要执行的脚本路径。' } else { 'Please provide the script path.' }
    'status.autodone.armed' = if ($script:BgjobsLangZh) { '已预约：所有任务完成后{0}' } else { 'Scheduled: {0} when all jobs finish' }
    'status.autodone.waiting' = if ($script:BgjobsLangZh) { '等待 {0} 个任务完成...' } else { 'Waiting for {0} job(s)...' }
    'status.autodone.countdown' = if ($script:BgjobsLangZh) { '{0} 秒后将{1}（点“取消预约”可中止）' } else { '{0}s until {1} (Cancel to abort)' }
    'status.autodone.norunning' = if ($script:BgjobsLangZh) { '无运行中的任务，已自动跳过。' } else { 'No running jobs; skipped.' }
    'status.autodone.cancelled' = if ($script:BgjobsLangZh) { '已取消完成动作。' } else { 'Auto action cancelled.' }
    'status.autodone.done' = if ($script:BgjobsLangZh) { '已完成动作：{0}' } else { 'Action done: {0}' }
    'dlg.autodone.ok' = if ($script:BgjobsLangZh) { '确定' } else { 'OK' }
    'msg.autodone.armed' = if ($script:BgjobsLangZh) { '已在预约中，请先取消预约再重新设定。' } else { 'Already scheduled. Cancel it first to reschedule.' }
    # desktop shortcut (v0.1.65)
    'gui.shortcut' = if ($script:BgjobsLangZh) { '📌 桌面快捷方式' } else { '📌 Desktop shortcut' }
    'gui.shortcut.done' = if ($script:BgjobsLangZh) { '已在桌面创建快捷方式：' } else { 'Shortcut created on your desktop:' }
    'gui.shortcut.fail' = if ($script:BgjobsLangZh) { '创建快捷方式失败：{0}' } else { 'Failed to create shortcut: {0}' }
}

# Resolve a UI text key. Templates with placeholders are formatted by the
# caller with -f, e.g. (Get-BgjobsText 'status.count') -f $n, $path
function Get-BgjobsText([string]$Key) {
    $tpl = $script:BgjobsText[$Key]
    if ($null -eq $tpl) { return $Key }
    return $tpl
}
