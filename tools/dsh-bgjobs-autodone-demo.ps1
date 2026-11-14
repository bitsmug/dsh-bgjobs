# dsh-bgjobs-autodone-demo.ps1 - verification helper: count down to 0, toast at end.
#
# Use it as the -Action script -ScriptPath target of dsh-bgjobs-autodone.ps1 to
# safely observe the whole "all jobs done -> countdown -> run action" pipeline
# and confirm the action really fires, WITHOUT shutting down / hibernating.
# Prints a countdown and finishes with a Toast notification.
#
# Pure ASCII (English defaults); pass -Title / -Message to localize the toast.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-bgjobs-autodone-demo.ps1 -Seconds 5
param(
    [ValidateRange(1, 3600)]
    [int]$Seconds = 1,
    [string]$Title = '',
    [string]$Message = ''
)
$ErrorActionPreference = 'Stop'

$zh = [System.Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh*'
if (-not $Title)   { $Title = if ($zh) { 'bgjobs verify' } else { 'bgjobs verify' } }
if (-not $Message) { $Message = if ($zh) { 'auto-action pipeline verified' } else { 'auto-action pipeline verified' } }

for ($i = $Seconds; $i -ge 1; $i--) {
    [Console]::WriteLine(('{0,3}s left...' -f $i))
    Start-Sleep -Seconds 1
}

# Toast must run under Windows PowerShell 5.1 (WinRT). Delegate per convention.
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dsh-bgjobs-toast.ps1') -Title $Title -Message $Message
exit $LASTEXITCODE
