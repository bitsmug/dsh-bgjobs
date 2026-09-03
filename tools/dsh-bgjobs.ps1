# dsh-bgjobs.ps1 - offline bgjobs management CLI (works WITHOUT DSH running).
#
# Usage:
#   .\dsh-bgjobs.ps1 list                              # all jobs (id/name/status/exit/time/workdir)
#   .\dsh-bgjobs.ps1 status -Id <id>                   # one job: details + log tail
#   .\dsh-bgjobs.ps1 log -Id <id> [-Tail 100]          # job log (last N lines)
#   .\dsh-bgjobs.ps1 submit -Name <n> -Command <c> -Workdir <dir> [-Pwsh]   # submit a new task offline (-Pwsh: use the PowerShell engine, pwsh preferred)
#   .\dsh-bgjobs.ps1 kill -Id <id> [-NoDeleteDir]      # stop a task (+ delete job dir unless -NoDeleteDir)
#   .\dsh-bgjobs.ps1 cleanup [-OlderThanHours 24]      # remove done job dirs: >24h (default) or all when -OlderThanHours 0
#   .\dsh-bgjobs.ps1 index -Workdir <dir>            # rebuild the central index from disk (repeatable)
#   .\dsh-bgjobs.ps1 help                              # this usage
#
# Data lives at <workdir>/.dsh/bgjobs/<id>/ (shared with the bgjobs DSH plugin);
# the central index at $DSH_HOME/bgjobs/index.json locates jobs. Offline submit
# uses schtasks directly (same as the plugin), so the task runs even with DSH down.

param(
    [Parameter(Position = 0)]
    [ValidateSet('list', 'status', 'log', 'submit', 'kill', 'cleanup', 'index', 'help')]
    [string]$Command = 'help',
    [string]$Id = '',
    [string]$Name = '',
    [string]$CommandText = '',
    [string[]]$Workdir = @(),
    [int]$Tail = 100,
    [int]$OlderThanHours = 24,
    [switch]$NoDeleteDir,
    [switch]$Pwsh
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dsh-bgjobs-lib.ps1')

function Format-BgjobsTime([object]$Ms) {
    $dt = ConvertFrom-BgjobsTimeMs $Ms
    if ($null -eq $dt) { return '-' }
    return $dt.ToLocalTime().ToString('MM-dd HH:mm:ss')
}

switch ($Command) {
    'list' {
        $jobs = Get-BgjobsJobs
        if (@($jobs).Count -eq 0) { Write-Host 'No bgjobs found. (Index empty or missing; try: index rebuild)'; break }
        Write-Host ('{0,-24} {1,-14} {2,-8} {3,-8} {4,-18} {5}' -f 'ID', 'NAME', 'STATUS', 'EXIT', 'FINISHED', 'WORKDIR')
        foreach ($j in $jobs) {
            $exit = if ($null -eq $j.exitCode) { '-' } else { [string]$j.exitCode }
            Write-Host ('{0,-24} {1,-14} {2,-8} {3,-8} {4,-18} {5}' -f $j.id, $j.name, $j.status, $exit, (Format-BgjobsTime $j.finishedAt), $j.workdir)
        }
        Write-Host "Index: $($script:BgjobsIndexPath)"
    }
    'status' {
        if (-not $Id) { throw 'status requires -Id <id>' }
        $j = Get-BgjobsJob $Id
        if ($null -eq $j) { Write-Host "job not found: $Id (index stale? try: index rebuild)"; exit 1 }
        Write-Host "ID:       $($j.id)"
        Write-Host "Name:     $($j.name)"
        Write-Host "Status:   $($j.status)"
        Write-Host "Exit:     $(if ($null -eq $j.exitCode) { '-' } else { $j.exitCode })"
        Write-Host "Created:  $(Format-BgjobsTime $j.createdAt)"
        Write-Host "Finished: $(Format-BgjobsTime $j.finishedAt)"
        Write-Host "Workdir:  $($j.workdir)"
        Write-Host "JobDir:   $($j.jobDir)"
        Write-Host "Log:      $($j.logPath)"
        # exitcode.txt raw
        if (Test-Path -LiteralPath $j.exitcodePath) {
            Write-Host "ExitCode file: $(Get-Content -LiteralPath $j.exitcodePath -Raw -Encoding UTF8).Trim()"
        }
        # log tail
        if (Test-Path -LiteralPath $j.logPath) {
            $lines = Get-Content -LiteralPath $j.logPath -Tail $Tail -Encoding UTF8
            Write-Host ''
            Write-Host "-- last $($lines.Count) log lines --"
            foreach ($l in $lines) { Write-Host $l }
        } else {
            Write-Host ''
            Write-Host '(no log yet)'
        }
    }
    'log' {
        if (-not $Id) { throw 'log requires -Id <id>' }
        $j = Get-BgjobsJob $Id
        if ($null -eq $j) { Write-Host "job not found: $Id (index stale? try: index rebuild)"; exit 1 }
        if (-not (Test-Path -LiteralPath $j.logPath)) { Write-Host '(no log yet)'; break }
        $lines = Get-Content -LiteralPath $j.logPath -Tail $Tail -Encoding UTF8
        foreach ($l in $lines) { Write-Host $l }
    }
    'submit' {
        if (-not $Name -or -not $CommandText -or -not $Workdir) {
            throw 'submit requires -Name <n> -Command <c> -Workdir <dir> [-Pwsh]'
        }
        $engine = if ($Pwsh) { 'pwsh' } else { 'bat' }
        $r = Submit-BgjobsJob $Name $CommandText $Workdir '' -Engine $engine
        if (-not $r.ok) { Write-Host "submit failed: $($r.error)"; exit 1 }
        Write-Host "Submitted: $($r.jobId) (task $($r.taskName), engine $engine)"
        Write-Host "Log: $($r.logPath)"
        Write-Host 'Note: the task runs under Windows Task Scheduler; DSH will pick it up (recover) once online and notify the creator if a session is present.'
    }
    'kill' {
        if (-not $Id) { throw 'kill requires -Id <id>' }
        $r = Stop-BgjobsJob $Id -NoDeleteDir:$NoDeleteDir
        if (-not $r.ok) { Write-Host "kill failed: $($r.error)"; exit 1 }
        Write-Host "Killed: $($r.removed)$(if ($NoDeleteDir) { ' (job dir kept)' } else { ' (job dir deleted)' })"
    }
    'cleanup' {
        $removed = Clear-BgjobsDone $OlderThanHours
        if (@($removed).Count -eq 0) { Write-Host "No done jobs older than ${OlderThanHours}h to clean." }
        else { Write-Host "Removed done jobs: $($removed -join ', ')" }
    }
    'index' {
        if (@($Workdir).Count -eq 0) {
            Write-Host 'index rebuild requires -Workdir <dir> (repeatable)'
            Write-Host 'Each dir is scanned for <dir>/.dsh/bgjobs/<id>/job.json.'
            break
        }
        $payload = Write-BgjobsIndexRebuild $Workdir
        Write-Host "Index rebuilt: $(@($payload.jobs).Count) job(s) -> $($script:BgjobsIndexPath)"
    }
    'help' {
        Get-Content -LiteralPath $PSCommandPath | Select-String -Pattern '^#\s' | ForEach-Object { Write-Host $_.Line.Substring(2) }
    }
}
