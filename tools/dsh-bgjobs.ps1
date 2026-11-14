# dsh-bgjobs.ps1 - offline bgjobs management CLI (works WITHOUT DSH running).
#
# Usage:
#   .\dsh-bgjobs.ps1 list                              # all jobs (id/name/status/exit/time/workdir)
#   .\dsh-bgjobs.ps1 status -Id <id>                   # one job: details + log tail
#   .\dsh-bgjobs.ps1 log -Id <id> [-Tail 100]          # job log (last N lines)
#   .\dsh-bgjobs.ps1 submit -Name <n> -Command <c> -Workdir <dir> [-Pwsh]   # submit a new task offline (-Pwsh: use the PowerShell engine, pwsh preferred)
#   .\dsh-bgjobs.ps1 kill -Id <id> [-Force]                    # KILL = terminate the task's process tree ONLY
#   .\dsh-bgjobs.ps1 delete -Id <id> [-NoDeleteDir] [-Force]    # DELETE = remove the job records (dir + central index)
#   .\dsh-bgjobs.ps1 cleanup [-OlderThanHours 24]      # remove done job dirs: >24h (default) or all when -OlderThanHours 0
#   .\dsh-bgjobs.ps1 index -Workdir <dir>            # rebuild the central index from disk (repeatable)
#   .\dsh-bgjobs.ps1 help                              # this usage
#
# kill and delete are TWO different semantics (mirrors the plugin's /bgjobs/kill and /bgjobs/delete):
#   kill   = terminate the process tree only; job dir / central index are KEPT and a non-zero exit code
#            (1 = the value taskkill /F actually records; the exit code is whatever the terminator passes
#            to TerminateProcess, we hold no handle to the schtasks-started task) is written so
#            wait/notify report a FAILURE, never "completed";
#   delete = remove the records only, and only when no live process of that job remains
#            ("process does not exist" belongs here); a live process => refused, kill first.
#   kill NEVER falls back to delete: with no live process it reports mode 'absent'
#   ("no live process found"), touches nothing at all, and it is the CALLER's choice to run delete.
#
# -Force = ONLY for the "cannot determine whether the job still has live processes" case
#   (the process probe/lookup itself failed): kill/delete then do NOTHING by default and only warn
#   (needsForce in the result); -Force really performs the action (forced = true in the result).
#   Exit code 3 = "cannot determine -> nothing was done; re-run with -Force" (0 = done, 1 = failed).
#   A live process is NEVER forced through: -Force does not change the live/absent behaviour at all.
#
# Data lives at <workdir>/.dsh/bgjobs/<id>/ (shared with the bgjobs DSH plugin);
# the central index at $DSH_HOME/bgjobs/index.json locates jobs. Offline submit
# uses schtasks directly (same as the plugin), so the task runs even with DSH down.

param(
    [Parameter(Position = 0)]
    [ValidateSet('list', 'status', 'log', 'submit', 'kill', 'delete', 'cleanup', 'index', 'help')]
    [string]$Command = 'help',
    [string]$Id = '',
    [string]$Name = '',
    [string]$CommandText = '',
    [string[]]$Workdir = @(),
    [int]$Tail = 100,
    [int]$OlderThanHours = 24,
    [switch]$NoDeleteDir,
    [switch]$Force,
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
        Write-Host "Command:  $($j.command)"
        Write-Host "Log:      $($j.logPath)"
        # exitcode.txt raw
        if (Test-Path -LiteralPath $j.exitcodePath) {
            Write-Host "ExitCode file: $(Get-Content -LiteralPath $j.exitcodePath -Raw -Encoding UTF8).Trim()"
        }
        # log tail
        if (Test-Path -LiteralPath $j.logPath) {
            $lines = Read-BgjobsLogTail $j.logPath $Tail
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
        $lines = Read-BgjobsLogTail $j.logPath $Tail
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
        # ★ kill = **只终止进程**（不删任何记录）：记录保留在磁盘/索引里，任务变成"已被终止"的终态
        # （exitcode.txt = 1（taskkill /F 记录的真值）+ job.json 的 exitCodeSource:'killed'）⇒ 要彻底清掉请随后 delete。
        # ★ 退出码由终止方传入 ⇒ 计划任务的 Last Result 分不清"runner 自己报了 1"与"runner 被杀成 1"，来源只看 exitCodeSource。
        # ★ -Force = 只用于越过 "无法判定有没有活进程" 的门槛（默认什么都不做，只警告 + 退出码 3）。
        $r = Stop-BgjobsJobProcesses $Id -Force:$Force
        if (-not $r.ok) {
            if ($r.needsForce) {
                Write-Host "kill skipped: cannot determine whether job $Id still has live processes."
                foreach ($w in @($r.warnings)) { Write-Host "  warning: $w" }
                Write-Host "  nothing was done (no process was terminated, no record was touched)."
                Write-Host "  Re-run with -Force to proceed: .\dsh-bgjobs.ps1 kill -Id $Id -Force"
                exit 3
            }
            Write-Host "kill failed: $($r.error)"
            exit 1
        }
        if ($r.mode -eq 'absent') {
            # ★ 未发现活进程（kill 只终止进程、不删任何记录）⇒ 如实回，**不把它说成 delete**；
            #   要清记录是调用方自己再跑一次 `delete` 的事（镜像 host 侧 /bgjobs/kill 的 mode:'absent'）。
            Write-Host "Nothing to kill: $($r.jobId) — no live process found; nothing was terminated and no record was touched. Use 'delete' to remove the records."
        } else {
            $which = if ($null -ne $r.killedPid) { "PID $($r.killedPid) ($($r.killedFile))" } elseif ($r.killedPids) { 'PIDs ' + (@($r.killedPids) -join ',') } else { 'process tree' }
            $note = if ($r.forced) { ' [forced]' } else { '' }
            Write-Host "Killed: $which — process terminated; exit code $($r.exitCode) written; records kept (use 'delete' to remove them)$note"
        }
    }
    'delete' {
        if (-not $Id) { throw 'delete requires -Id <id>' }
        # ★ delete = **只删记录**（job 目录 + 中央索引）：只在没有活进程时允许；有活进程 ⇒ 先 kill。
        # ★ -Force = 只用于越过 "无法判定有没有活进程" 的门槛（默认什么都不做，只警告 + 退出码 3）。
        $r = Remove-BgjobsJob $Id -NoDeleteDir:$NoDeleteDir -Force:$Force
        if (-not $r.ok) {
            if ($r.needsForce) {
                Write-Host "delete skipped: cannot determine whether job $Id still has live processes."
                foreach ($w in @($r.warnings)) { Write-Host "  warning: $w" }
                Write-Host "  nothing was done (no record was removed)."
                Write-Host "  Re-run with -Force to proceed: .\dsh-bgjobs.ps1 delete -Id $Id -Force"
                exit 3
            }
            Write-Host "delete failed: $($r.error)"
            if ($r.mode -eq 'kill' -or $r.mode -eq 'unknown') { Write-Host 'Hint: this job may still be running — run kill first, then delete.' }
            exit 1
        }
        $note = if ($r.forced) { ' [forced]' } else { '' }
        Write-Host "Deleted records: $($r.removed)$(if ($NoDeleteDir) { ' (job dir kept)' } else { ' (job dir deleted)' })$note"
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
