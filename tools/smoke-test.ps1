# dsh-bgjobs smoke test - exercises the offline CLI against a temporary area
# WITHOUT touching real schtasks (schtasks is skipped by only testing the
# read/index paths; submit/kill need a live Task Scheduler and are listed as
# manual checks). Run: powershell -ExecutionPolicy Bypass -File smoke-test.ps1
$ErrorActionPreference = 'Stop'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('bgjobs-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$env:DSH_HOME = Join-Path $tmp 'home'
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
$workdir = Join-Path $tmp 'work'
New-Item -ItemType Directory -Force -Path $workdir | Out-Null
$jobsRoot = Join-Path $workdir '.dsh\bgjobs'
$script = Join-Path $PSScriptRoot 'dsh-bgjobs-lib.ps1'
. $script

$failed = 0
function Assert-True([bool]$Cond, [string]$Msg) {
    if (-not $Cond) { Write-Host "FAIL: $Msg"; $script:failed++ }
    else { Write-Host "ok: $Msg" }
}

# ── index rebuild ─────────────────────────────────────────────────────────
$id = 'bg-smoke-1'
$jobDir = Join-Path $jobsRoot $id
New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
$meta = @{
    id = $id; name = 'smoke'; workdir = $workdir; taskName = 'dsh-bgj-' + $id; jobDir = $jobDir
    logPath = (Join-Path $jobDir 'stdout.log'); exitcodePath = (Join-Path $jobDir 'exitcode.txt')
    jsonPath = (Join-Path $jobDir 'job.json'); command = 'echo smoke'; status = 'done'
    exitCode = 0; createdAt = (Get-BgjobsNowMs); finishedAt = (Get-BgjobsNowMs)
}
[System.IO.File]::WriteAllText((Join-Path $jobDir 'job.json'), ($meta | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $jobDir 'stdout.log'), "line1`r`nline2`r`n", (New-Object System.Text.UTF8Encoding($false)))

$payload = Write-BgjobsIndexRebuild @($workdir)
Assert-True (@($payload.jobs).Count -eq 1) 'index rebuild finds 1 job'

# ── list / status / log ───────────────────────────────────────────────────
$jobs = Get-BgjobsJobs
Assert-True (@($jobs).Count -eq 1) 'list finds 1 job'
Assert-True ($jobs[0].status -eq 'done' -and $jobs[0].exitCode -eq 0) 'job parsed from job.json (status/exit)'
$single = Get-BgjobsJob $id
Assert-True ($null -ne $single -and $single.jobDir -eq $jobDir) 'get job by id'

$tail = Get-Content -LiteralPath $single.logPath -Tail 100
Assert-True (@($tail).Count -eq 2) 'log tail reads lines'

# ── cleanup ───────────────────────────────────────────────────────────────
# finishedAt = now -> NOT older than 24h -> kept
$removed = Clear-BgjobsDone 24
Assert-True (@($removed).Count -eq 0) 'fresh done job kept by cleanup'
# now mark it old
$meta.finishedAt = (Get-BgjobsNowMs) - 25 * 3600 * 1000
[System.IO.File]::WriteAllText((Join-Path $jobDir 'job.json'), ($meta | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
$removed = Clear-BgjobsDone 24
Assert-True (@($removed).Count -eq 1) 'old done job removed by cleanup'
Assert-True (-not (Test-Path -LiteralPath $jobDir)) 'job dir deleted after cleanup'

# ── exit-code parse (mirror check) ────────────────────────────────────────
Assert-True ((ConvertFrom-BgjobsExitCode '0') -eq 0) 'parse exit 0'
Assert-True ((ConvertFrom-BgjobsExitCode '-1') -eq -1) 'parse exit -1'
Assert-True ($null -eq (ConvertFrom-BgjobsExitCode 'abc')) 'parse non-numeric -> null'

# ── pwsh engine: bat / ps1 generation (mirror check; no real schtasks) ────
$pwshJob = [pscustomobject]@{
    meta = [pscustomobject]@{
        workdir = $workdir; jsonPath = (Join-Path $jobDir 'job.json')
        interpreter = 'C:\fake\pwsh.exe'; scriptPath = (Join-Path $jobDir 'job.ps1')
        logPath = (Join-Path $jobDir 'stdout.log'); exitcodePath = (Join-Path $jobDir 'exitcode.txt')
        taskName = 'dsh-bgj-smoke-pwsh'; command = "Write-Output 'hello pwsh'`r`n1..3 | ForEach-Object { `"step `$_`" }"
    }
}
$pwshBat = New-BgjobsPwshBat $pwshJob
Assert-True ($pwshBat -match 'C:\\fake\\pwsh\.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".*job\.ps1" >>') 'pwsh run.bat invokes interpreter -File job.ps1 with redirect'
Assert-True ($pwshBat.IndexOf('echo [BGJOB] exit code') -lt $pwshBat.IndexOf('exitcode.txt" echo')) 'pwsh run.bat writes exitcode after log marker'
Assert-True ($pwshBat.IndexOf('schtasks /Delete /TN dsh-bgj-smoke-pwsh /F') -gt $pwshBat.IndexOf('exitcode.txt" echo')) 'pwsh run.bat self-deletes last'
$ps1 = New-BgjobsPs1 $pwshJob
Assert-True ($ps1.StartsWith('# bgjobs:')) 'job.ps1 has UTF-8 preamble (first line)'
Assert-True ($ps1.Contains('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)')) 'job.ps1 sets Console.OutputEncoding to UTF-8'
Assert-True ($ps1.Contains("Write-Output 'hello pwsh'")) 'job.ps1 keeps user command as-is'

Write-Host ''
if ($failed -gt 0) { Write-Host "SMOKE FAILED: $failed failure(s)"; exit 1 }
Write-Host 'SMOKE PASSED'
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
