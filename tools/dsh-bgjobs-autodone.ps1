# dsh-bgjobs-autodone.ps1 - reusable watcher: run an action when ALL jobs finish.
#
# Polls all bgjobs until none is running, then counts down Delay seconds and
# runs the action (shutdown / hibernate / run a script). Designed to be armed
# from dsh-bgjobs-gui.ps1 or invoked standalone.
#
# SAFETY: the action only fires if at least one running job was actually
# observed. If the very first scan finds no running job, the watcher writes
# 'norunning' and exits WITHOUT acting, so arming with nothing in flight can
# never trigger an accidental shutdown.
#
# Progress is reported through an optional StatusFile using ASCII tokens
# (the GUI localizes them): waiting:N / countdown:N / norunning / cancelled /
# done:<action> / err:noscript. Existence of an optional CancelFile aborts.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-bgjobs-autodone.ps1 -Action shutdown -Delay 30
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-bgjobs-autodone.ps1 -Action hibernate -Delay 60
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-bgjobs-autodone.ps1 -Action script -Delay 30 -ScriptPath C:\x\y.ps1 -ScriptArgs "-Seconds 5"
param(
    [ValidateSet('shutdown', 'hibernate', 'script')]
    [string]$Action = 'shutdown',
    [ValidateRange(0, 3600)]
    [int]$Delay = 30,
    [string]$ScriptPath = '',
    [string]$ScriptArgs = '',
    [string]$StatusFile = '',
    [string]$CancelFile = ''
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'dsh-bgjobs-lib.ps1')

function Write-AutoStatus([string]$s) {
    if (-not $StatusFile) { return }
    try {
        [System.IO.File]::WriteAllText($StatusFile, $s, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Test-AutoCancel {
    if ($CancelFile -and (Test-Path -LiteralPath $CancelFile)) { return $true }
    return $false
}

# Tokenize a script-args string, honoring double quotes (so values with spaces stay one token).
function Split-BgjobsArgs([string]$s) {
    $tokens = New-Object System.Collections.Generic.List[string]
    $cur = ''; $inQ = $false
    foreach ($c in $s.ToCharArray()) {
        if ($c -eq '"') { $inQ = -not $inQ; continue }
        if ($c -eq ' ' -and -not $inQ) { if ($cur) { $tokens.Add($cur); $cur = '' }; continue }
        $cur += $c
    }
    if ($cur) { $tokens.Add($cur) }
    return $tokens
}

# Poll until no job is running (2s interval). Honor cancel marker at each tick.
$observedRunning = $false
$jobs = @(Get-BgjobsJobs)
while ($true) {
    $running = @($jobs | Where-Object { $_.status -eq 'running' })
    if ($running.Count -gt 0) {
        $observedRunning = $true
        if (Test-AutoCancel) { Write-AutoStatus 'cancelled'; exit 0 }
        Write-AutoStatus ("waiting:" + $running.Count)
        Start-Sleep -Seconds 2
        $jobs = @(Get-BgjobsJobs)
        continue
    }
    break
}

# Safety guard: nothing to wait for -> do NOT act.
if (-not $observedRunning) {
    Write-AutoStatus 'norunning'
    exit 0
}

# Countdown (still cancellable at every second).
for ($i = $Delay; $i -ge 1; $i--) {
    if (Test-AutoCancel) { Write-AutoStatus 'cancelled'; exit 0 }
    Write-AutoStatus ("countdown:" + $i)
    Start-Sleep -Seconds 1
}

# Execute the chosen action.
switch ($Action) {
    'shutdown' {
        & "$env:SystemRoot\System32\shutdown.exe" /s /t 0 /c "bgjobs: all jobs done" | Out-Null
    }
    'hibernate' {
        & "$env:SystemRoot\System32\shutdown.exe" /h | Out-Null
    }
    'script' {
        if (-not $ScriptPath) { Write-AutoStatus 'err:noscript'; exit 1 }
        $scriptTokens = if ($ScriptArgs) { @(Split-BgjobsArgs $ScriptArgs) } else { @() }
        if ($ScriptPath -match '\.ps1$') {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @scriptTokens
        } elseif ($ScriptPath -match '\.(bat|cmd)$') {
            & cmd.exe /c $ScriptPath @scriptTokens
        } else {
            & $ScriptPath @scriptTokens
        }
    }
}
Write-AutoStatus ("done:" + $Action)
exit 0
