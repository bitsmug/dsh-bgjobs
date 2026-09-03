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

# case A: done job WITHOUT finishedAt but WITH an OLD exitcode.txt (finished while DSH
# was offline) -> 24h cleanup uses exitcode.txt mtime as finish time -> removed
$id2 = 'bg-smoke-2'
$jobDir2 = Join-Path $jobsRoot $id2
New-Item -ItemType Directory -Force -Path $jobDir2 | Out-Null
$exit2 = Join-Path $jobDir2 'exitcode.txt'
[System.IO.File]::WriteAllText($exit2, '0', (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::SetLastWriteTimeUtc($exit2, (Get-Date).ToUniversalTime().AddHours(-25))
$meta2 = @{
    id = $id2; name = 'smoke-null-finished'; workdir = $workdir; taskName = 'dsh-bgj-' + $id2; jobDir = $jobDir2
    logPath = (Join-Path $jobDir2 'stdout.log'); exitcodePath = $exit2
    jsonPath = (Join-Path $jobDir2 'job.json'); command = 'echo smoke2'; status = 'done'
    exitCode = 0; createdAt = (Get-BgjobsNowMs)   # finishedAt intentionally absent
}
[System.IO.File]::WriteAllText((Join-Path $jobDir2 'job.json'), ($meta2 | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

# case B: done job WITHOUT finishedAt AND WITHOUT exitcode.txt -> no way to age it -> kept by 24h
$id3 = 'bg-smoke-3'
$jobDir3 = Join-Path $jobsRoot $id3
New-Item -ItemType Directory -Force -Path $jobDir3 | Out-Null
$meta3 = @{
    id = $id3; name = 'smoke-no-exitcode'; workdir = $workdir; taskName = 'dsh-bgj-' + $id3; jobDir = $jobDir3
    logPath = (Join-Path $jobDir3 'stdout.log'); exitcodePath = (Join-Path $jobDir3 'exitcode.txt')
    jsonPath = (Join-Path $jobDir3 'job.json'); command = 'echo smoke3'; status = 'done'
    exitCode = 0; createdAt = (Get-BgjobsNowMs)   # finishedAt intentionally absent
}
[System.IO.File]::WriteAllText((Join-Path $jobDir3 'job.json'), ($meta3 | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

$null = Write-BgjobsIndexRebuild @($workdir)
$removed = Clear-BgjobsDone 24
Assert-True (@($removed).Count -eq 1 -and $removed -contains $id2) 'old exitcode.txt fallback: NULL-finishedAt done job removed by 24h cleanup'
Assert-True (-not (Test-Path -LiteralPath $jobDir2)) 'job dir (old exitcode fallback) deleted after 24h cleanup'
Assert-True (Test-Path -LiteralPath $jobDir3) 'done job with neither finishedAt nor exitcode.txt kept by 24h cleanup'
$removed = Clear-BgjobsDone 0
Assert-True (@($removed).Count -eq 1 -and $removed -contains $id3) 'NULL-finishedAt/no-exitcode job removed by full cleanup (0)'
Assert-True (-not (Test-Path -LiteralPath $jobDir3)) 'job dir (no exitcode) deleted after full cleanup'

# case D: boundary -> finished 24h-minus-1s ago is KEPT by cleanup 24 (strictly older only)
$id5 = 'bg-smoke-5'
$jobDir5 = Join-Path $jobsRoot $id5
New-Item -ItemType Directory -Force -Path $jobDir5 | Out-Null
$meta5 = @{
    id = $id5; name = 'smoke-24h-minus1s'; workdir = $workdir; taskName = 'dsh-bgj-' + $id5; jobDir = $jobDir5
    logPath = (Join-Path $jobDir5 'stdout.log'); exitcodePath = (Join-Path $jobDir5 'exitcode.txt')
    jsonPath = (Join-Path $jobDir5 'job.json'); command = 'echo smoke5'; status = 'done'
    exitCode = 0; createdAt = (Get-BgjobsNowMs); finishedAt = (Get-BgjobsNowMs) - 24 * 3600 * 1000 + 1000
}
[System.IO.File]::WriteAllText((Join-Path $jobDir5 'job.json'), ($meta5 | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
$null = Write-BgjobsIndexRebuild @($workdir)
$removed = Clear-BgjobsDone 24
Assert-True (@($removed).Count -eq 0) 'job finished just under 24h ago kept by 24h cleanup (strictly older required)'
Assert-True (Test-Path -LiteralPath $jobDir5) 'near-24h boundary job dir still exists'
$removed = Clear-BgjobsDone 0
Assert-True (@($removed).Count -eq 1 -and $removed -contains $id5) 'near-24h boundary job removed by full cleanup (0)'
Assert-True (-not (Test-Path -LiteralPath $jobDir5)) 'near-24h boundary job dir deleted after full cleanup'

# case C: custom hours -> a job finished 2h ago is removed by cleanup 1
$id4 = 'bg-smoke-4'
$jobDir4 = Join-Path $jobsRoot $id4
New-Item -ItemType Directory -Force -Path $jobDir4 | Out-Null
$meta4 = @{
    id = $id4; name = 'smoke-2h-old'; workdir = $workdir; taskName = 'dsh-bgj-' + $id4; jobDir = $jobDir4
    logPath = (Join-Path $jobDir4 'stdout.log'); exitcodePath = (Join-Path $jobDir4 'exitcode.txt')
    jsonPath = (Join-Path $jobDir4 'job.json'); command = 'echo smoke4'; status = 'done'
    exitCode = 0; createdAt = (Get-BgjobsNowMs); finishedAt = (Get-BgjobsNowMs) - 2 * 3600 * 1000
}
[System.IO.File]::WriteAllText((Join-Path $jobDir4 'job.json'), ($meta4 | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
$null = Write-BgjobsIndexRebuild @($workdir)
$removed = Clear-BgjobsDone 1
Assert-True (@($removed).Count -eq 1 -and $removed -contains $id4) 'custom hours (1h) removes a 2h-old done job'
Assert-True (-not (Test-Path -LiteralPath $jobDir4)) 'job dir (2h old) deleted by 1h cleanup'
# index consistency: nothing left to list
Assert-True (@(Get-BgjobsJobs).Count -eq 0) 'index empty after all cleanup'

# ── exit-code parse (mirror check) ────────────────────────────────────────
Assert-True ((ConvertFrom-BgjobsExitCode '0') -eq 0) 'parse exit 0'
Assert-True ((ConvertFrom-BgjobsExitCode '-1') -eq -1) 'parse exit -1'
Assert-True ($null -eq (ConvertFrom-BgjobsExitCode 'abc')) 'parse non-numeric -> null'

# ── pwsh engine: run.ps1 / job.ps1 generation (mirror check; no real schtasks) ──
$pwshJob = [pscustomobject]@{
    meta = [pscustomobject]@{
        workdir = $workdir; jsonPath = (Join-Path $jobDir 'job.json')
        interpreter = 'C:\fake\pwsh.exe'; scriptPath = (Join-Path $jobDir 'job.ps1')
        logPath = (Join-Path $jobDir 'stdout.log'); exitcodePath = (Join-Path $jobDir 'exitcode.txt')
        taskName = 'dsh-bgj-smoke-pwsh'; command = "Write-Output 'hello pwsh'`r`n1..3 | ForEach-Object { `"step `$_`" }"
    }
}
$pwshRunner = New-BgjobsPwshRunner $pwshJob
Assert-True ($pwshRunner.Contains("& 'C:") -and $pwshRunner.Contains(" *> `$logPath")) 'pwsh run.ps1 redirects job output via & ... *>'
Assert-True ($pwshRunner.IndexOf('[BGJOB] exit code') -gt $pwshRunner.IndexOf('*>')) 'pwsh run.ps1 writes exitcode after redirect'
Assert-True ($pwshRunner.IndexOf("schtasks /Delete /TN 'dsh-bgj-smoke-pwsh' /F") -gt $pwshRunner.IndexOf('WriteAllText')) 'pwsh run.ps1 self-deletes after exitcode write'
Assert-True ($pwshRunner.Contains('0xFF') -and $pwshRunner.Contains('0xFE')) 'pwsh run.ps1 converts UTF-16LE log on PS 5.1'
$ps1 = New-BgjobsPs1 $pwshJob
Assert-True ($ps1.StartsWith('# bgjobs:')) 'job.ps1 has UTF-8 preamble (first line)'
Assert-True ($ps1.Contains('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)')) 'job.ps1 sets Console.OutputEncoding to UTF-8'
Assert-True ($ps1.Contains("Write-Output 'hello pwsh'")) 'job.ps1 keeps user command as-is'

Write-Host ''
if ($failed -gt 0) { Write-Host "SMOKE FAILED: $failed failure(s)"; exit 1 }
Write-Host 'SMOKE PASSED'
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
