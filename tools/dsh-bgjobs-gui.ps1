﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿# dsh-bgjobs-gui.ps1 - bgjobs standalone management window (works WITHOUT DSH).
# Mirrors dsh-undo-savepoint-gui.ps1: single-instance mutex, hidden console,
# WinForms list with refresh/submit/kill/cleanup, live log tail panel.
# Open via dsh-bgjobs-gui.bat or a desktop shortcut.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'dsh-bgjobs-lib.ps1')

# ── single-instance guard ─────────────────────────────────────────────────
$script:guiMutex = $null
try {
    $script:guiMutex = New-Object System.Threading.Mutex($false, 'DSHBgjobsGUI')
    if (-not $script:guiMutex.WaitOne(0, $false)) {
        [System.Windows.Forms.MessageBox]::Show((Get-BgjobsText 'mutex.already'), 'bgjobs', 'OK', 'Information')
        exit 0
    }
} catch { } # mutex unavailable: allow running anyway

# Hide the console window right after startup.
try {
    Add-Type -Namespace BgjobsWin -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
'@
    $null = [BgjobsWin.Native]::ShowWindow([BgjobsWin.Native]::GetConsoleWindow(), 0)
} catch { } # cosmetic only

# ── helpers ───────────────────────────────────────────────────────────────
function Format-GuiTime([object]$Ms) {
    $dt = ConvertFrom-BgjobsTimeMs $Ms
    if ($null -eq $dt) { return '-' }
    return $dt.ToLocalTime().ToString('MM-dd HH:mm')
}

# 按 job 填一行（新建与原位刷新共用；7 列 + Tag 携带最新 job 对象）。
# 逐格比较、仅在值有差异时才赋值：静止数据下不触发无效重绘；
# 返回本次是否有实际变化（供 Update-GuiList 决定是否刷新状态栏）。
function Set-GuiListItem([System.Windows.Forms.ListViewItem]$item, $j) {
    $exit = if ($null -eq $j.exitCode) { '-' } else { [string]$j.exitCode }
    $newName    = $j.name
    $newStatus  = $j.status
    $newNotify  = if ($j.notified) { Get-BgjobsText 'notify.done' } else { Get-BgjobsText 'notify.pending' }
    $newFinish  = (Format-GuiTime $j.finishedAt)
    $newWorkdir = $j.workdir
    $changed = $false
    if ($item.SubItems.Count -gt 1) {
        if ($item.Text -ne [string]$j.id) { $item.Text = [string]$j.id; $changed = $true }
        if ($item.SubItems[1].Text -ne $newName)    { $item.SubItems[1].Text = $newName;    $changed = $true }
        if ($item.SubItems[2].Text -ne $newStatus)  { $item.SubItems[2].Text = $newStatus;  $changed = $true }
        if ($item.SubItems[3].Text -ne $exit)       { $item.SubItems[3].Text = $exit;       $changed = $true }
        if ($item.SubItems[4].Text -ne $newNotify)  { $item.SubItems[4].Text = $newNotify;  $changed = $true }
        if ($item.SubItems[5].Text -ne $newFinish)  { $item.SubItems[5].Text = $newFinish;  $changed = $true }
        if ($item.SubItems[6].Text -ne $newWorkdir) { $item.SubItems[6].Text = $newWorkdir; $changed = $true }
    } else {
        $item.Text = [string]$j.id
        $item.SubItems.Add($newName)    | Out-Null
        $item.SubItems.Add($newStatus)  | Out-Null
        $item.SubItems.Add($exit)       | Out-Null
        $item.SubItems.Add($newNotify)  | Out-Null
        $item.SubItems.Add($newFinish)  | Out-Null
        $item.SubItems.Add($newWorkdir) | Out-Null
        $changed = $true
    }
    $item.Tag = $j
    return $changed
}

# Refresh the job list from disk (live job.json; index only locates dirs).
# 就地合并更新（按 id 匹配既有行）：不清空 Items → 滚动位置与选中自然保留，
# 不会因每 2s 自动刷新而跳回顶部；仅增删/原位刷新文本与 Tag。
function Update-GuiList {
    $jobs = @(Get-BgjobsJobs)
    $script:list.BeginUpdate()
    $changed = $false
    $existing = @{}
    foreach ($it in $script:list.Items) {
        if ($null -ne $it.Tag -and $null -ne $it.Tag.id) { $existing[[string]$it.Tag.id] = $it }
    }
    $seen = @{}
    foreach ($j in $jobs) {
        $key = [string]$j.id
        $seen[$key] = $true
        if ($existing.ContainsKey($key)) {
            if (Set-GuiListItem $existing[$key] $j) { $changed = $true }   # 仅值有变化才算脏
        } else {
            $item = New-Object System.Windows.Forms.ListViewItem([string]$j.id)
            Set-GuiListItem $item $j | Out-Null
            [void]$script:list.Items.Add($item)
            $changed = $true
        }
    }
    # 剔除已消失任务（被删行若正被选中，WinForms 自行清空选中）
    foreach ($key in @($existing.Keys)) {
        if (-not $seen.ContainsKey($key)) { [void]$script:list.Items.Remove($existing[$key]); $changed = $true }
    }
    $script:list.EndUpdate()
    if ($changed) {
        $script:statusLabel.Text = (Get-BgjobsText 'status.count') -f @($jobs).Count, $script:BgjobsIndexPath
    }
}

# Show the selected job's details + last log lines.
function Show-GuiDetail {
    if ($script:list.SelectedItems.Count -eq 0) { return }
    $j = $script:list.SelectedItems[0].Tag
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("ID:       $($j.id)")
    [void]$sb.AppendLine("Name:     $($j.name)")
    [void]$sb.AppendLine("Status:   $($j.status)")
    [void]$sb.AppendLine("Exit:     $(if ($null -eq $j.exitCode) { '-' } else { $j.exitCode })")
    [void]$sb.AppendLine("Created:  $(Format-GuiTime $j.createdAt)")
    [void]$sb.AppendLine("Finished: $(Format-GuiTime $j.finishedAt)")
    $notifyTxt = if ($j.notified) { if ($j.notifiedBy) { (Get-BgjobsText 'notify.done') + ' (' + $j.notifiedBy + ')' } else { Get-BgjobsText 'notify.done' } } else { Get-BgjobsText 'notify.pending' }
    [void]$sb.AppendLine("Notify:   $notifyTxt")
    [void]$sb.AppendLine("Workdir:  $($j.workdir)")
    [void]$sb.AppendLine("JobDir:   $($j.jobDir)")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine((Get-BgjobsText 'detail.log'))
    if (Test-Path -LiteralPath $j.logPath) {
        foreach ($l in (Get-Content -LiteralPath $j.logPath -Tail 200 -Encoding UTF8)) { [void]$sb.AppendLine($l) }
    } else {
        [void]$sb.AppendLine((Get-BgjobsText 'detail.nolog'))
    }
    $script:detail.Text = $sb.ToString()
}

# ── 示例：倒计时（每 1 秒打印剩余时间，15 秒后发 Toast 系统通知）─────────
# Toast 经 dsh-bgjobs-toast.ps1（5.1 WinRT 帮助脚本）发出：pwsh 7/.NET Core 无法加载
# WinRT 类型（实测 TYPE LOAD FAIL），示例在 pwsh 7 下委托 powershell.exe 执行；路径由
# Set-GuiCountdownExample 用 __TOAST_HELPER__ 占位符替换为插件 tools 目录绝对路径。
$script:CountdownExampleName = Get-BgjobsText 'example.countdown.name'
$script:CountdownExampleWorkdir = [Environment]::GetFolderPath('MyDocuments')

# Countdown sample command, localized once at GUI start. __TOAST_HELPER__ is
# swapped for the real helper path by Set-GuiCountdownExample when applied.
function New-GuiCountdownExample {
    $secs = Get-BgjobsText 'example.countdown.secs'
    $done = Get-BgjobsText 'example.countdown.done'
    $toastTitle = Get-BgjobsText 'example.countdown.toast.title'
    $toastMsg = Get-BgjobsText 'example.countdown.toast.msg'
    $toastFail = Get-BgjobsText 'example.countdown.toast.fail'
    $L = New-Object System.Collections.Generic.List[string]
    $L.Add('$n = 3')
    $L.Add('for ($i = $n; $i -ge 1; $i--) {')
    $L.Add("    '$secs' -f `$i")
    $L.Add('    Start-Sleep -Seconds 1')
    $L.Add('}')
    $L.Add("'$done'")
    $L.Add("`$toastHelper = '__TOAST_HELPER__'")
    $L.Add('try {')
    $L.Add("    if (`$PSVersionTable.PSEdition -eq 'Core') {")
    $L.Add('        # pwsh 7: WinRT types unavailable, delegate to Windows PowerShell 5.1')
    $L.Add("        & `"`$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -ExecutionPolicy Bypass -File `$toastHelper -Title '$toastTitle' -Message ('$toastMsg' -f `$n)")
    $L.Add("        if (`$LASTEXITCODE -ne 0) { throw `"toast helper exit code `$LASTEXITCODE`" }")
    $L.Add('    } else {')
    $L.Add("        & `$toastHelper -Title '$toastTitle' -Message ('$toastMsg' -f `$n)")
    $L.Add('    }')
    $L.Add("} catch { ('$toastFail' -f `$_.Exception.Message) }")
    return ($L -join "`r`n")
}
$script:CountdownExample = New-GuiCountdownExample

function Set-GuiCountdownExample {
    # 填充三个输入框 + 自动选 pwsh 引擎（命令是 PowerShell 语法，bat 引擎无法运行）
    $script:submitInputs[0].Text = $script:CountdownExampleName
    $script:submitInputs[1].Text = $script:CountdownExample.Replace('__TOAST_HELPER__', (Join-Path $PSScriptRoot 'dsh-bgjobs-toast.ps1'))
    $script:submitInputs[2].Text = $script:CountdownExampleWorkdir
    $script:submitRadioPwsh.Checked = $true
}

# ── submit dialog (name / command / workdir / engine radio + example) ─────
function Show-GuiSubmitDialog {
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = (Get-BgjobsText 'dlg.submit.title')
    $dlg.Size = New-Object System.Drawing.Size(560, 400)
    $dlg.StartPosition = 'CenterParent'
    $dlg.FormBorderStyle = 'FixedDialog'
    $dlg.MaximizeBox = $false
    $dlg.MinimizeBox = $false

    $x = 16
    $w = 528
    function New-GuiLabel([string]$text, [int]$y) {
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $text
        $l.Location = New-Object System.Drawing.Point($x, $y)
        $l.Size = New-Object System.Drawing.Size($w, 16)
        $dlg.Controls.Add($l)
        return $l
    }
    function New-GuiField([string]$labelText, [int]$y, [int]$height) {
        $null = New-GuiLabel $labelText $y
        $txt = New-Object System.Windows.Forms.TextBox
        $txt.Location = New-Object System.Drawing.Point($x, ($y + 18))
        $txt.Size = New-Object System.Drawing.Size($w, [Math]::Max($height, 22))
        if ($height -gt 22) { $txt.Multiline = $true; $txt.Height = $height }
        $dlg.Controls.Add($txt)
        return $txt
    }

    $y = 12
    # 示例下拉：一键填充三框
    $null = New-GuiLabel (Get-BgjobsText 'dlg.example') $y
    $comboExample = New-Object System.Windows.Forms.ComboBox
    $comboExample.DropDownStyle = 'DropDownList'
    $comboExample.Location = New-Object System.Drawing.Point($x, ($y + 18))
    $comboExample.Size = New-Object System.Drawing.Size($w, 22)
    [void]$comboExample.Items.Add((Get-BgjobsText 'dlg.example.none'))
    [void]$comboExample.Items.Add((Get-BgjobsText 'dlg.example.countdown'))
    $comboExample.SelectedIndex = 0
    $dlg.Controls.Add($comboExample)
    $y += 48

    $script:submitInputs = @()
    # 任务名
    $script:submitInputs += (New-GuiField (Get-BgjobsText 'dlg.name') $y 22)
    $y += 48
    # 命令（可多行）
    $script:submitInputs += (New-GuiField (Get-BgjobsText 'dlg.command') $y 74)
    $y += 96
    # 命令提示（灰字，仅提示）
    $hint = New-GuiLabel (Get-BgjobsText 'dlg.hint') $y
    $hint.ForeColor = [System.Drawing.Color]::Gray
    $y += 22
    # 工作目录
    $script:submitInputs += (New-GuiField (Get-BgjobsText 'dlg.workdir') $y 22)
    $y += 48
    # 引擎单选列表：bat（cmd，默认） / pwsh（PowerShell，pwsh 优先）
    $null = New-GuiLabel (Get-BgjobsText 'dlg.engine') $y
    $radioBat = New-Object System.Windows.Forms.RadioButton
    $radioBat.Text = (Get-BgjobsText 'dlg.engine.bat')
    $radioBat.Location = New-Object System.Drawing.Point($x, ($y + 18))
    $radioBat.Size = New-Object System.Drawing.Size(110, 22)
    $radioBat.Checked = $true
    $dlg.Controls.Add($radioBat)
    $script:submitRadioPwsh = New-Object System.Windows.Forms.RadioButton
    $script:submitRadioPwsh.Text = (Get-BgjobsText 'dlg.engine.pwsh')
    $script:submitRadioPwsh.Location = New-Object System.Drawing.Point(($x + 140), ($y + 18))
    $script:submitRadioPwsh.Size = New-Object System.Drawing.Size(190, 22)
    $dlg.Controls.Add($script:submitRadioPwsh)
    $y += 44

    # 提交 / 取消（右下角，完整可见）
    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = (Get-BgjobsText 'dlg.ok')
    $btnOk.Location = New-Object System.Drawing.Point(360, $y)
    $btnOk.Size = New-Object System.Drawing.Size(90, 30)
    $btnOk.DialogResult = 'OK'
    $dlg.Controls.Add($btnOk)
    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = (Get-BgjobsText 'dlg.cancel')
    $btnCancel.Location = New-Object System.Drawing.Point(460, $y)
    $btnCancel.Size = New-Object System.Drawing.Size(90, 30)
    $btnCancel.DialogResult = 'Cancel'
    $dlg.Controls.Add($btnCancel)
    $dlg.AcceptButton = $btnOk
    $dlg.CancelButton = $btnCancel

    $comboExample.Add_SelectedIndexChanged({
        if ($comboExample.SelectedIndex -eq 1) { Set-GuiCountdownExample }
    })

    if ($dlg.ShowDialog($script:form) -ne 'OK') { return }
    $name = $script:submitInputs[0].Text.Trim()
    $command = $script:submitInputs[1].Text
    $workdir = $script:submitInputs[2].Text.Trim()
    if (-not $name -or -not $command -or -not $workdir) {
        [System.Windows.Forms.MessageBox]::Show((Get-BgjobsText 'dlg.empty'), 'bgjobs', 'OK', 'Warning')
        return
    }
    $engine = if ($script:submitRadioPwsh.Checked) { 'pwsh' } else { 'bat' }
    $r = Submit-BgjobsJob $name $command $workdir '' -Engine $engine
    if (-not $r.ok) {
        [System.Windows.Forms.MessageBox]::Show(((Get-BgjobsText 'dlg.failed') -f $r.error), 'bgjobs', 'OK', 'Error')
        return
    }
    Update-GuiList
}

# ── cleanup dialog: adjustable age cutoff + explicit buttons ────────────
$script:GuiCleanupHours = 24   # session-memory default; reset to 24 on restart

function Show-GuiCleanupDialog {
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = (Get-BgjobsText 'dlg.cleanup.title')
    $dlg.Size = New-Object System.Drawing.Size(470, 150)
    $dlg.StartPosition = 'CenterParent'
    $dlg.FormBorderStyle = 'FixedDialog'
    $dlg.MaximizeBox = $false
    $dlg.MinimizeBox = $false

    # "仅清理超过 [24] 小时前完成的任务"
    $pre = New-Object System.Windows.Forms.Label
    $pre.Text = (Get-BgjobsText 'dlg.cleanup.older.pre')
    $pre.Location = New-Object System.Drawing.Point(14, 22)
    $pre.Size = New-Object System.Drawing.Size(130, 22)
    $dlg.Controls.Add($pre)

    $num = New-Object System.Windows.Forms.NumericUpDown
    $num.Minimum = 1
    $num.Maximum = 8760
    $num.Value = $script:GuiCleanupHours
    $num.Location = New-Object System.Drawing.Point(152, 20)
    $num.Size = New-Object System.Drawing.Size(60, 22)
    $dlg.Controls.Add($num)

    $post = New-Object System.Windows.Forms.Label
    $post.Text = (Get-BgjobsText 'dlg.cleanup.older.post')
    $post.Location = New-Object System.Drawing.Point(220, 22)
    $post.Size = New-Object System.Drawing.Size(240, 22)
    $dlg.Controls.Add($post)

    $btnOlder = New-Object System.Windows.Forms.Button
    $btnOlder.Text = (Get-BgjobsText 'dlg.cleanup.doOlder')
    $btnOlder.Location = New-Object System.Drawing.Point(60, 64)
    $btnOlder.Size = New-Object System.Drawing.Size(135, 30)
    $dlg.Controls.Add($btnOlder)

    $btnAll = New-Object System.Windows.Forms.Button
    $btnAll.Text = (Get-BgjobsText 'dlg.cleanup.doAll')
    $btnAll.Location = New-Object System.Drawing.Point(205, 64)
    $btnAll.Size = New-Object System.Drawing.Size(135, 30)
    $dlg.Controls.Add($btnAll)

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = (Get-BgjobsText 'dlg.cancel')
    $btnCancel.Location = New-Object System.Drawing.Point(350, 64)
    $btnCancel.Size = New-Object System.Drawing.Size(95, 30)
    $btnCancel.DialogResult = 'Cancel'
    $dlg.Controls.Add($btnCancel)
    $dlg.AcceptButton = $btnOlder
    $dlg.CancelButton = $btnCancel

    # 选择结果经 $script:CleanupChoice 传回（按钮在 ShowDialog 事件循环内触发，
    # 局部变量当时在作用域内可读；写回必须用 script 级变量避免子作用域隔离）。
    $script:CleanupChoice = $null
    $btnOlder.Add_Click({
        $script:CleanupChoice = @{ action = 'older'; hours = [int]$num.Value }
        $dlg.Close()
    })
    $btnAll.Add_Click({
        $script:CleanupChoice = @{ action = 'all' }
        $dlg.Close()
    })

    $null = $dlg.ShowDialog($script:form)
    $dlg.Dispose()
    $choice = $script:CleanupChoice
    $script:CleanupChoice = $null
    if ($null -eq $choice) { return }   # cancelled

    if ($choice.action -eq 'older') {
        $script:GuiCleanupHours = $choice.hours
        $hours = $choice.hours
    } else {
        $hours = 0   # all finished
    }
    $removed = @(Clear-BgjobsDone $hours)
    [System.Windows.Forms.MessageBox]::Show(((Get-BgjobsText 'msg.cleaned') -f @($removed).Count), 'bgjobs', 'OK', 'Information')
    Update-GuiList
}

# ── 完成后自动执行（关机/休眠/脚本）：预约对话框 + 看守进程管理 ──────────────
function Get-GuiAutoDoneActionLabel([string]$Action) {
    switch ($Action) {
        'shutdown'  { return (Get-BgjobsText 'dlg.autodone.action.shutdown') }
        'hibernate' { return (Get-BgjobsText 'dlg.autodone.action.hibernate') }
        'script'    { return (Get-BgjobsText 'dlg.autodone.action.script') }
        default     { return $Action }
    }
}

function Show-GuiAutoDoneDialog {
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = (Get-BgjobsText 'dlg.autodone.title')
    $dlg.Size = New-Object System.Drawing.Size(520, 264)
    $dlg.StartPosition = 'CenterParent'
    $dlg.FormBorderStyle = 'FixedDialog'
    $dlg.MaximizeBox = $false
    $dlg.MinimizeBox = $false

    # 动作
    $lblAction = New-Object System.Windows.Forms.Label
    $lblAction.Text = (Get-BgjobsText 'dlg.autodone.action')
    $lblAction.Location = New-Object System.Drawing.Point(16, 18)
    $lblAction.Size = New-Object System.Drawing.Size(90, 18)
    $dlg.Controls.Add($lblAction)
    $comboAction = New-Object System.Windows.Forms.ComboBox
    $comboAction.DropDownStyle = 'DropDownList'
    $comboAction.Location = New-Object System.Drawing.Point(110, 16)
    $comboAction.Size = New-Object System.Drawing.Size(180, 22)
    [void]$comboAction.Items.Add((Get-BgjobsText 'dlg.autodone.action.shutdown'))
    [void]$comboAction.Items.Add((Get-BgjobsText 'dlg.autodone.action.hibernate'))
    [void]$comboAction.Items.Add((Get-BgjobsText 'dlg.autodone.action.script'))
    $comboAction.SelectedIndex = 0
    $dlg.Controls.Add($comboAction)

    # 延迟（秒）：NumericUpDown 支持键盘直接输入任意秒数
    $lblDelay = New-Object System.Windows.Forms.Label
    $lblDelay.Text = (Get-BgjobsText 'dlg.autodone.delay')
    $lblDelay.Location = New-Object System.Drawing.Point(16, 50)
    $lblDelay.Size = New-Object System.Drawing.Size(90, 18)
    $dlg.Controls.Add($lblDelay)
    $numDelay = New-Object System.Windows.Forms.NumericUpDown
    $numDelay.Location = New-Object System.Drawing.Point(110, 48)
    $numDelay.Size = New-Object System.Drawing.Size(120, 22)
    $numDelay.Minimum = 1
    $numDelay.Maximum = 3600
    $numDelay.Increment = 10
    $numDelay.Value = 30
    $dlg.Controls.Add($numDelay)

    # 脚本路径（仅执行脚本时可用；可下拉选示例 Toast 脚本，也可手动输入）
    $lblScript = New-Object System.Windows.Forms.Label
    $lblScript.Text = (Get-BgjobsText 'dlg.autodone.script')
    $lblScript.Location = New-Object System.Drawing.Point(16, 84)
    $lblScript.Size = New-Object System.Drawing.Size(100, 18)
    $dlg.Controls.Add($lblScript)
    $exampleToast = Join-Path $PSScriptRoot 'dsh-bgjobs-autodone-demo.ps1'
    $cmbScript = New-Object System.Windows.Forms.ComboBox
    $cmbScript.DropDownStyle = 'DropDown'
    $cmbScript.Location = New-Object System.Drawing.Point(120, 82)
    $cmbScript.Size = New-Object System.Drawing.Size(380, 22)
    [void]$cmbScript.Items.Add((Get-BgjobsText 'dlg.autodone.exampleToast'))
    $cmbScript.Enabled = $false
    $dlg.Controls.Add($cmbScript)

    # 脚本参数（原样传给脚本，如 -Seconds 5）
    $lblArgs = New-Object System.Windows.Forms.Label
    $lblArgs.Text = (Get-BgjobsText 'dlg.autodone.args')
    $lblArgs.Location = New-Object System.Drawing.Point(16, 116)
    $lblArgs.Size = New-Object System.Drawing.Size(100, 18)
    $dlg.Controls.Add($lblArgs)
    $txtArgs = New-Object System.Windows.Forms.TextBox
    $txtArgs.Location = New-Object System.Drawing.Point(120, 114)
    $txtArgs.Size = New-Object System.Drawing.Size(380, 22)
    $txtArgs.Enabled = $false
    $dlg.Controls.Add($txtArgs)

    $comboAction.Add_SelectedIndexChanged({
        $isScript = ($comboAction.SelectedIndex -eq 2)
        $cmbScript.Enabled = $isScript
        $txtArgs.Enabled = $isScript
    })
    $cmbScript.Add_SelectionChangeCommitted({
        if ($cmbScript.SelectedIndex -eq 0) { $cmbScript.Text = $exampleToast }
    })

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = (Get-BgjobsText 'dlg.autodone.ok')
    $btnOk.Location = New-Object System.Drawing.Point(300, 156)
    $btnOk.Size = New-Object System.Drawing.Size(90, 30)
    $btnOk.DialogResult = 'OK'
    $dlg.Controls.Add($btnOk)
    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = (Get-BgjobsText 'dlg.cancel')
    $btnCancel.Location = New-Object System.Drawing.Point(400, 156)
    $btnCancel.Size = New-Object System.Drawing.Size(90, 30)
    $btnCancel.DialogResult = 'Cancel'
    $dlg.Controls.Add($btnCancel)
    $dlg.AcceptButton = $btnOk
    $dlg.CancelButton = $btnCancel

    $script:AutoDoneChoice = $null
    $btnOk.Add_Click({
        $action = switch ($comboAction.SelectedIndex) { 0 { 'shutdown' } 1 { 'hibernate' } 2 { 'script' } default { 'shutdown' } }
        $script = if ($cmbScript.SelectedIndex -eq 0) { $exampleToast } else { $cmbScript.Text.Trim() }
        $script:AutoDoneChoice = @{
            action = $action
            delay  = [int]$numDelay.Value
            script = $script
            args   = $txtArgs.Text.Trim()
        }
    })

    $null = $dlg.ShowDialog($script:form)
    $dlg.Dispose()
}

function Arm-AutoDone([object]$choice) {
    if ($script:autoDonePid) { return }
    $script:statusFile = Join-Path $env:TEMP 'bgjobs-autodone-status.txt'
    $script:cancelFile = Join-Path $env:TEMP 'bgjobs-autodone-cancel.txt'
    Remove-Item -LiteralPath $script:statusFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:cancelFile -Force -ErrorAction SilentlyContinue
    $helper = Join-Path $PSScriptRoot 'dsh-bgjobs-autodone.ps1'
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $helper,
        '-Action', [string]$choice.action, '-Delay', [string]$choice.delay,
        '-StatusFile', $script:statusFile, '-CancelFile', $script:cancelFile)
    if ($choice.action -eq 'script') {
        $args += @('-ScriptPath', [string]$choice.script)
        if ($choice.args) { $args += @('-ScriptArgs', ('"' + [string]$choice.args + '"')) }   # 含空格需引号包裹，防被拆分
    }
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden -PassThru
    $script:autoDonePid = $p.Id
    $script:autoDoneActionLabel = (Get-GuiAutoDoneActionLabel $choice.action)
    $script:btnAutoDone.Enabled = $false
    $script:btnCancelAutoDone.Enabled = $true
    $script:autoDoneStatus.Text = (Get-BgjobsText 'status.autodone.armed') -f $script:autoDoneActionLabel
    $script:autoDoneTimer = New-Object System.Windows.Forms.Timer
    $script:autoDoneTimer.Interval = 1000
    $script:autoDoneTimer.Add_Tick({ Read-AutoDoneStatus })
    $script:autoDoneTimer.Start()
}

function Disarm-AutoDone {
    if ($script:autoDoneTimer) { $script:autoDoneTimer.Stop(); $script:autoDoneTimer.Dispose(); $script:autoDoneTimer = $null }
    $script:btnAutoDone.Enabled = $true
    $script:btnCancelAutoDone.Enabled = $false
    $script:autoDonePid = $null
    if ($script:statusFile)  { Remove-Item -LiteralPath $script:statusFile  -Force -ErrorAction SilentlyContinue }
    if ($script:cancelFile)  { Remove-Item -LiteralPath $script:cancelFile  -Force -ErrorAction SilentlyContinue }
}

function Read-AutoDoneStatus {
    if (-not $script:statusFile -or -not (Test-Path -LiteralPath $script:statusFile)) { return }
    $s = ''
    try { $s = (Get-Content -LiteralPath $script:statusFile -Raw -Encoding UTF8).Trim() } catch { return }
    if (-not $s) { return }
    if ($s -match '^waiting:(\d+)$') {
        $script:autoDoneStatus.Text = (Get-BgjobsText 'status.autodone.waiting') -f $Matches[1]
    } elseif ($s -match '^countdown:(\d+)$') {
        $script:autoDoneStatus.Text = (Get-BgjobsText 'status.autodone.countdown') -f $Matches[1], $script:autoDoneActionLabel
    } elseif ($s -eq 'norunning') {
        $script:autoDoneStatus.Text = (Get-BgjobsText 'status.autodone.norunning'); Disarm-AutoDone
    } elseif ($s -eq 'cancelled') {
        $script:autoDoneStatus.Text = (Get-BgjobsText 'status.autodone.cancelled'); Disarm-AutoDone
    } elseif ($s -match '^done:(.+)$') {
        $script:autoDoneStatus.Text = (Get-BgjobsText 'status.autodone.done') -f $Matches[1]; Disarm-AutoDone
    } elseif ($s -match '^err:(.+)$') {
        $script:autoDoneStatus.Text = (Get-BgjobsText 'status.autodone.done') -f ('ERR: ' + $Matches[1]); Disarm-AutoDone
    }
}

# ── 桌面快捷方式：在当前用户桌面创建指向本 GUI 的 .lnk（v0.1.65）─────────
function New-GuiDesktopShortcut {
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        if (-not $desktop) {
            [System.Windows.Forms.MessageBox]::Show(((Get-BgjobsText 'gui.shortcut.fail') -f 'Desktop folder unavailable'), 'bgjobs', 'OK', 'Error')
            return
        }
        $lnk = Join-Path $desktop 'bgjobs 后台任务.lnk'
        # 启动器 = 当前解释器（5.1 → powershell.exe；7 → pwsh.exe），参数与 .bat 同款：
        # -WindowStyle Hidden + -File <本脚本>（GUI 自身还会 ShowWindow 隐藏控制台兜底）。
        if ($PSVersionTable.PSEdition -eq 'Core') { $exe = Join-Path $PSHOME 'pwsh.exe' } else { $exe = Join-Path $PSHOME 'powershell.exe' }
        $argsLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '"'
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut($lnk)
        $sc.TargetPath = $exe
        $sc.Arguments = $argsLine
        $sc.WorkingDirectory = $PSScriptRoot
        $sc.Description = 'bgjobs 后台任务管理'
        $sc.Save()
        [System.Windows.Forms.MessageBox]::Show((((Get-BgjobsText 'gui.shortcut.done') + [Environment]::NewLine + $lnk)), 'bgjobs', 'OK', 'Information')
    } catch {
        [System.Windows.Forms.MessageBox]::Show(((Get-BgjobsText 'gui.shortcut.fail') -f $_.Exception.Message), 'bgjobs', 'OK', 'Error')
    }
}

# ── main window ───────────────────────────────────────────────────────────
$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = (Get-BgjobsText 'gui.title')
$script:form.Size = New-Object System.Drawing.Size(900, 620)
$script:form.StartPosition = 'CenterScreen'
$script:form.MinimumSize = New-Object System.Drawing.Size(640, 420)

# toolbar
$script:toolbar = New-Object System.Windows.Forms.ToolStrip
$script:btnRefresh = New-Object System.Windows.Forms.ToolStripButton((Get-BgjobsText 'gui.refresh'))
$script:btnSubmit = New-Object System.Windows.Forms.ToolStripButton((Get-BgjobsText 'gui.submit'))
$script:btnKill = New-Object System.Windows.Forms.ToolStripButton((Get-BgjobsText 'gui.kill'))
$script:btnCleanup = New-Object System.Windows.Forms.ToolStripButton((Get-BgjobsText 'gui.cleanup'))
$script:btnIndex = New-Object System.Windows.Forms.ToolStripButton((Get-BgjobsText 'gui.index'))
$script:btnAutoDone = New-Object System.Windows.Forms.ToolStripButton((Get-BgjobsText 'gui.autodone'))
$script:btnCancelAutoDone = New-Object System.Windows.Forms.ToolStripButton((Get-BgjobsText 'gui.autodone.cancel'))
$script:btnCancelAutoDone.Enabled = $false
$script:btnShortcut = New-Object System.Windows.Forms.ToolStripButton((Get-BgjobsText 'gui.shortcut'))
$script:toolbar.Items.Add($script:btnRefresh) | Out-Null
$script:toolbar.Items.Add($script:btnSubmit) | Out-Null
$script:toolbar.Items.Add($script:btnKill) | Out-Null
$script:toolbar.Items.Add($script:btnCleanup) | Out-Null
$script:toolbar.Items.Add($script:btnIndex) | Out-Null
$script:toolbar.Items.Add($script:btnAutoDone) | Out-Null
$script:toolbar.Items.Add($script:btnCancelAutoDone) | Out-Null
$script:toolbar.Items.Add($script:btnShortcut) | Out-Null
$script:toolbar.Dock = 'Top'
$script:form.Controls.Add($script:toolbar)

# status strip
$script:statusLabel = New-Object System.Windows.Forms.ToolStripStatusLabel
$script:statusStrip = New-Object System.Windows.Forms.StatusStrip
$script:statusStrip.Items.Add($script:statusLabel) | Out-Null
$script:autoDoneStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$script:autoDoneStatus.Spring = $false
$script:autoDoneStatus.Text = ''
$script:statusStrip.Items.Add($script:autoDoneStatus) | Out-Null
$script:form.Controls.Add($script:statusStrip)

# ── 主内容区：可拖分界（上=任务列表，下=详情+日志）──
$script:split = New-Object System.Windows.Forms.SplitContainer
$script:split.Orientation = 'Horizontal'
$script:split.Dock = 'Fill'
$script:split.Panel1MinSize = 120
$script:split.Panel2MinSize = 120

# job list（上层面板，Dock 占满）
$script:list = New-Object System.Windows.Forms.ListView
$script:list.View = 'Details'
$script:list.FullRowSelect = $true
$script:list.GridLines = $true
$script:list.HeaderStyle = [System.Windows.Forms.ColumnHeaderStyle]::Clickable
$script:list.MultiSelect = $false
$script:list.Columns.Add((Get-BgjobsText 'col.id'), 190) | Out-Null
$script:list.Columns.Add((Get-BgjobsText 'col.name'), 140) | Out-Null
$script:list.Columns.Add((Get-BgjobsText 'col.status'), 70) | Out-Null
$script:list.Columns.Add((Get-BgjobsText 'col.exit'), 60) | Out-Null
$script:list.Columns.Add((Get-BgjobsText 'col.notify'), 90) | Out-Null
$script:list.Columns.Add((Get-BgjobsText 'col.finished'), 110) | Out-Null
$script:list.Columns.Add((Get-BgjobsText 'col.workdir'), 300) | Out-Null
# 启用 ListView 双缓冲，消除刷新闪烁（DoubleBuffered 是 Control 的受保护属性，需反射设置）。
$flags = [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
$dbProp = [System.Windows.Forms.ListView].GetProperty('DoubleBuffered', $flags)
if ($dbProp) { $dbProp.SetValue($script:list, $true, $null) }
$setStyle = [System.Windows.Forms.Control].GetMethod('SetStyle', $flags)
$style = [System.Windows.Forms.ControlStyles]::OptimizedDoubleBuffer -bor [System.Windows.Forms.ControlStyles]::AllPaintingInWmPaint
[void]$setStyle.Invoke($script:list, @($style, $true))
$script:list.Dock = 'Fill'
$script:list.Add_SelectedIndexChanged({ Show-GuiDetail })
$script:split.Panel1.Controls.Add($script:list)

# detail + log（下层面板，Dock 占满）
$script:detail = New-Object System.Windows.Forms.TextBox
$script:detail.Multiline = $true
$script:detail.ReadOnly = $true
$script:detail.ScrollBars = 'Vertical'
$script:detail.Font = New-Object System.Drawing.Font('Consolas', 9)
$script:detail.Dock = 'Fill'
$script:split.Panel2.Controls.Add($script:detail)

# 初始列表高度：SplitContainer 布局完成前（Height=0）赋 SplitterDistance 会抛
# 参数越界异常（静默后间距停在默认值、布局畸形）——改在 Shown（布局就绪）时赋值。
$script:form.Add_Shown({
    try { $script:split.SplitterDistance = 300 } catch { /* 保持默认，仍可拖动分界 */ }
})
$script:form.Controls.Add($script:split)
# 关键：把 Fill 的 SplitContainer 提到控件树最前（z-order index 0）。WinForms
# 按反 z-order 停靠：后添加/靠后的控件先停靠。若顺序是 toolbar、statusStrip、split，
# split（靠后）会先停靠占满整个窗体并叠在 toolStrip 之上，把它顶部的列头遮住（列头不显示）。
# 改为 split 停靠最后 → 让出 toolbar/statusStrip 空间，列头可见。
$script:form.Controls.SetChildIndex($script:split, 0)

$script:btnRefresh.Add_Click({ Update-GuiList })
$script:btnSubmit.Add_Click({ Show-GuiSubmitDialog })
$script:btnKill.Add_Click({
    if ($script:list.SelectedItems.Count -eq 0) { return }
    $j = $script:list.SelectedItems[0].Tag
    $ask = [System.Windows.Forms.MessageBox]::Show(((Get-BgjobsText 'msg.kill') -f $j.name, $j.id), 'bgjobs', 'YesNo', 'Question')
    if ($ask -ne 'Yes') { return }
    $r = Stop-BgjobsJob $j.id
    if (-not $r.ok) { [System.Windows.Forms.MessageBox]::Show(((Get-BgjobsText 'msg.kill.failed') -f $r.error), 'bgjobs', 'OK', 'Error') }
    Update-GuiList
})
$script:btnCleanup.Add_Click({ Show-GuiCleanupDialog })
$script:btnIndex.Add_Click({
    # Index rebuild needs workdirs; prompt for one root (repeatable manually).
    $dir = (New-Object System.Windows.Forms.FolderBrowserDialog)
    $dir.Description = (Get-BgjobsText 'msg.index.prompt')
    if ($dir.ShowDialog($script:form) -ne 'OK') { return }
    $payload = Write-BgjobsIndexRebuild @($dir.SelectedPath)
    [System.Windows.Forms.MessageBox]::Show(((Get-BgjobsText 'msg.index.done') -f @($payload.jobs).Count), 'bgjobs', 'OK', 'Information')
    Update-GuiList
})
$script:btnAutoDone.Add_Click({
    if ($script:autoDonePid) {
        [System.Windows.Forms.MessageBox]::Show((Get-BgjobsText 'msg.autodone.armed'), 'bgjobs', 'OK', 'Information')
        return
    }
    Show-GuiAutoDoneDialog
    $choice = $script:AutoDoneChoice
    $script:AutoDoneChoice = $null
    if ($null -eq $choice) { return }   # dialog cancelled
    if ($choice.action -eq 'script' -and -not $choice.script) {
        [System.Windows.Forms.MessageBox]::Show((Get-BgjobsText 'dlg.autodone.noscript'), 'bgjobs', 'OK', 'Warning')
        return
    }
    $running = @(Get-BgjobsJobs | Where-Object { $_.status -eq 'running' })
    if ($running.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show((Get-BgjobsText 'dlg.autodone.noRunning'), 'bgjobs', 'OK', 'Information')
        return
    }
    Arm-AutoDone $choice
})
$script:btnCancelAutoDone.Add_Click({
    if ($script:autoDonePid) {
        if ($script:cancelFile) { New-Item -ItemType File -Force -Path $script:cancelFile | Out-Null }
        Stop-Process -Id $script:autoDonePid -Force -ErrorAction SilentlyContinue
    }
    Disarm-AutoDone
    $script:autoDoneStatus.Text = (Get-BgjobsText 'status.autodone.cancelled')
})
$script:btnShortcut.Add_Click({ New-GuiDesktopShortcut })

# auto-refresh every 2s (cheap: reads index + small job.json files)
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 2000
$script:timer.Add_Tick({ Update-GuiList })
$script:timer.Start()

# cleanup on close
$script:form.Add_FormClosed({
    $script:timer.Stop()
    if ($script:autoDoneTimer) { $script:autoDoneTimer.Stop() }
    try { if ($script:guiMutex) { $script:guiMutex.ReleaseMutex(); $script:guiMutex.Dispose() } } catch { }
})

Update-GuiList
[System.Windows.Forms.Application]::Run($script:form)
