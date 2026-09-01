# dsh-bgjobs-gui.ps1 - bgjobs standalone management window (works WITHOUT DSH).
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
        [System.Windows.Forms.MessageBox]::Show('bgjobs 管理面板已在运行（可能最小化到了托盘）。', 'bgjobs', 'OK', 'Information')
        exit 0
    }
} catch { /* mutex unavailable: allow running anyway */ }

# Hide the console window right after startup.
try {
    Add-Type -Namespace BgjobsWin -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
'@
    $null = [BgjobsWin.Native]::ShowWindow([BgjobsWin.Native]::GetConsoleWindow(), 0)
} catch { /* cosmetic only */ }

# ── helpers ───────────────────────────────────────────────────────────────
function Format-GuiTime([object]$Ms) {
    $dt = ConvertFrom-BgjobsTimeMs $Ms
    if ($null -eq $dt) { return '-' }
    return $dt.ToLocalTime().ToString('MM-dd HH:mm')
}

# Refresh the job list from disk (live job.json; index only locates dirs).
function Update-GuiList {
    $jobs = @(Get-BgjobsJobs)
    $script:list.BeginUpdate()
    $script:list.Items.Clear()
    foreach ($j in $jobs) {
        $exit = if ($null -eq $j.exitCode) { '-' } else { [string]$j.exitCode }
        $item = New-Object System.Windows.Forms.ListViewItem($j.id)
        $item.SubItems.Add($j.name) | Out-Null
        $item.SubItems.Add($j.status) | Out-Null
        $item.SubItems.Add($exit) | Out-Null
        $item.SubItems.Add((Format-GuiTime $j.finishedAt)) | Out-Null
        $item.SubItems.Add($j.workdir) | Out-Null
        $item.Tag = $j
        $script:list.Items.Add($item) | Out-Null
    }
    $script:list.EndUpdate()
    $script:statusLabel.Text = "任务数：$(@($jobs).Count)    索引：$($script:BgjobsIndexPath)"
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
    [void]$sb.AppendLine("Workdir:  $($j.workdir)")
    [void]$sb.AppendLine("JobDir:   $($j.jobDir)")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('-- 最近日志 --')
    if (Test-Path -LiteralPath $j.logPath) {
        foreach ($l in (Get-Content -LiteralPath $j.logPath -Tail 200 -Encoding UTF8)) { [void]$sb.AppendLine($l) }
    } else {
        [void]$sb.AppendLine('(no log yet)')
    }
    $script:detail.Text = $sb.ToString()
}

# ── 示例：倒计时（每 1 秒打印剩余时间，15 秒后发 Toast 系统通知）─────────
# Toast 经 dsh-bgjobs-toast.ps1（5.1 WinRT 帮助脚本）发出：pwsh 7/.NET Core 无法加载
# WinRT 类型（实测 TYPE LOAD FAIL），示例在 pwsh 7 下委托 powershell.exe 执行；路径由
# Set-GuiCountdownExample 用 __TOAST_HELPER__ 占位符替换为插件 tools 目录绝对路径。
$script:CountdownExampleName = '倒计时演示'
$script:CountdownExampleWorkdir = [Environment]::GetFolderPath('MyDocuments')
$script:CountdownExample = @'
$n = 3
for ($i = $n; $i -ge 1; $i--) {
    '{0,3} 秒后结束...' -f $i
    Start-Sleep -Seconds 1
}
'倒计时结束！'
$toastHelper = '__TOAST_HELPER__'
try {
    if ($PSVersionTable.PSEdition -eq 'Core') {
        # pwsh 7：WinRT 类型不可用，委托给 Windows PowerShell 5.1
        & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $toastHelper -Title 'bgjobs 提醒' -Message "倒计时结束（$n 秒）"
        if ($LASTEXITCODE -ne 0) { throw "toast helper exit code $LASTEXITCODE" }
    } else {
        & $toastHelper -Title 'bgjobs 提醒' -Message "倒计时结束（$n 秒）"
    }
} catch { '（Toast 通知失败：' + $_.Exception.Message + '）' }
'@

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
    $dlg.Text = '提交后台任务'
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
    $null = New-GuiLabel '示例：' $y
    $comboExample = New-Object System.Windows.Forms.ComboBox
    $comboExample.DropDownStyle = 'DropDownList'
    $comboExample.Location = New-Object System.Drawing.Point($x, ($y + 18))
    $comboExample.Size = New-Object System.Drawing.Size($w, 22)
    [void]$comboExample.Items.Add('（无）')
    [void]$comboExample.Items.Add('倒计时（每1秒打印剩余时间，结束Toast提醒）')
    $comboExample.SelectedIndex = 0
    $dlg.Controls.Add($comboExample)
    $y += 48

    $script:submitInputs = @()
    # 任务名
    $script:submitInputs += (New-GuiField '任务名（给任务起个名字，如：倒计时演示）' $y 22)
    $y += 48
    # 命令（可多行）
    $script:submitInputs += (New-GuiField '命令（要执行的命令，可多行）' $y 74)
    $y += 96
    # 命令提示（灰字，仅提示）
    $hint = New-GuiLabel '提示：不知道怎么写？用上方【示例】下拉选【倒计时】一键填充。' $y
    $hint.ForeColor = [System.Drawing.Color]::Gray
    $y += 22
    # 工作目录
    $script:submitInputs += (New-GuiField '工作目录（任务运行目录，如 C:\logs）' $y 22)
    $y += 48
    # 引擎单选列表：bat（cmd，默认） / pwsh（PowerShell，pwsh 优先）
    $null = New-GuiLabel '引擎：' $y
    $radioBat = New-Object System.Windows.Forms.RadioButton
    $radioBat.Text = 'bat（cmd）'
    $radioBat.Location = New-Object System.Drawing.Point($x, ($y + 18))
    $radioBat.Size = New-Object System.Drawing.Size(110, 22)
    $radioBat.Checked = $true
    $dlg.Controls.Add($radioBat)
    $script:submitRadioPwsh = New-Object System.Windows.Forms.RadioButton
    $script:submitRadioPwsh.Text = 'pwsh（PowerShell）'
    $script:submitRadioPwsh.Location = New-Object System.Drawing.Point(($x + 140), ($y + 18))
    $script:submitRadioPwsh.Size = New-Object System.Drawing.Size(190, 22)
    $dlg.Controls.Add($script:submitRadioPwsh)
    $y += 44

    # 提交 / 取消（右下角，完整可见）
    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = '提交'
    $btnOk.Location = New-Object System.Drawing.Point(360, $y)
    $btnOk.Size = New-Object System.Drawing.Size(90, 30)
    $btnOk.DialogResult = 'OK'
    $dlg.Controls.Add($btnOk)
    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = '取消'
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
        [System.Windows.Forms.MessageBox]::Show('任务名、命令、工作目录都不能为空。', 'bgjobs', 'OK', 'Warning')
        return
    }
    $engine = if ($script:submitRadioPwsh.Checked) { 'pwsh' } else { 'bat' }
    $r = Submit-BgjobsJob $name $command $workdir '' -Engine $engine
    if (-not $r.ok) {
        [System.Windows.Forms.MessageBox]::Show("提交失败：$($r.error)", 'bgjobs', 'OK', 'Error')
        return
    }
    Update-GuiList
}

# ── main window ───────────────────────────────────────────────────────────
$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = 'bgjobs 后台任务管理'
$script:form.Size = New-Object System.Drawing.Size(900, 620)
$script:form.StartPosition = 'CenterScreen'
$script:form.MinimumSize = New-Object System.Drawing.Size(640, 420)

# toolbar
$script:toolbar = New-Object System.Windows.Forms.ToolStrip
$script:btnRefresh = New-Object System.Windows.Forms.ToolStripButton('🔄 刷新')
$script:btnSubmit = New-Object System.Windows.Forms.ToolStripButton('➕ 提交')
$script:btnKill = New-Object System.Windows.Forms.ToolStripButton('⏹ 终止')
$script:btnCleanup = New-Object System.Windows.Forms.ToolStripButton('🧹 清理')
$script:btnIndex = New-Object System.Windows.Forms.ToolStripButton('🗺 重建索引')
$script:toolbar.Items.Add($script:btnRefresh) | Out-Null
$script:toolbar.Items.Add($script:btnSubmit) | Out-Null
$script:toolbar.Items.Add($script:btnKill) | Out-Null
$script:toolbar.Items.Add($script:btnCleanup) | Out-Null
$script:toolbar.Items.Add($script:btnIndex) | Out-Null
$script:form.Controls.Add($script:toolbar)

# status strip
$script:statusLabel = New-Object System.Windows.Forms.ToolStripStatusLabel
$script:statusStrip = New-Object System.Windows.Forms.StatusStrip
$script:statusStrip.Items.Add($script:statusLabel) | Out-Null
$script:form.Controls.Add($script:statusStrip)

# job list (top, ~55%)
$script:list = New-Object System.Windows.Forms.ListView
$script:list.View = 'Details'
$script:list.FullRowSelect = $true
$script:list.GridLines = $true
$script:list.MultiSelect = $false
$script:list.Columns.Add('ID', 190) | Out-Null
$script:list.Columns.Add('名称', 140) | Out-Null
$script:list.Columns.Add('状态', 70) | Out-Null
$script:list.Columns.Add('退出码', 60) | Out-Null
$script:list.Columns.Add('完成时间', 110) | Out-Null
$script:list.Columns.Add('工作目录', 300) | Out-Null
$script:list.Anchor = 'Top, Left, Right'
$script:list.Location = New-Object System.Drawing.Point(10, 30)
$script:list.Size = New-Object System.Drawing.Size(870, 300)
$script:list.Add_SelectedIndexChanged({ Show-GuiDetail })
$script:form.Controls.Add($script:list)

# detail + log (bottom)
$script:detail = New-Object System.Windows.Forms.TextBox
$script:detail.Multiline = $true
$script:detail.ReadOnly = $true
$script:detail.ScrollBars = 'Vertical'
$script:detail.Font = New-Object System.Drawing.Font('Consolas', 9)
$script:detail.Anchor = 'Top, Bottom, Left, Right'
$script:detail.Location = New-Object System.Drawing.Point(10, 340)
$script:detail.Size = New-Object System.Drawing.Size(870, 220)
$script:form.Controls.Add($script:detail)

$script:btnRefresh.Add_Click({ Update-GuiList })
$script:btnSubmit.Add_Click({ Show-GuiSubmitDialog })
$script:btnKill.Add_Click({
    if ($script:list.SelectedItems.Count -eq 0) { return }
    $j = $script:list.SelectedItems[0].Tag
    $ask = [System.Windows.Forms.MessageBox]::Show("终止任务 $($j.name)（$($j.id)）？", 'bgjobs', 'YesNo', 'Question')
    if ($ask -ne 'Yes') { return }
    $r = Stop-BgjobsJob $j.id
    if (-not $r.ok) { [System.Windows.Forms.MessageBox]::Show("终止失败：$($r.error)", 'bgjobs', 'OK', 'Error') }
    Update-GuiList
})
$script:btnCleanup.Add_Click({
    $ask = [System.Windows.Forms.MessageBox]::Show('清理超过 24h 的已完成任务目录？', 'bgjobs', 'YesNo', 'Question')
    if ($ask -ne 'Yes') { return }
    $removed = @(Clear-BgjobsDone 24)
    [System.Windows.Forms.MessageBox]::Show("已清理 $(@($removed).Count) 个任务", 'bgjobs', 'OK', 'Information')
    Update-GuiList
})
$script:btnIndex.Add_Click({
    # Index rebuild needs workdirs; prompt for one root (repeatable manually).
    $dir = (New-Object System.Windows.Forms.FolderBrowserDialog)
    $dir.Description = '选择工作区根目录（扫描其 .dsh/bgjobs 下的任务）'
    if ($dir.ShowDialog($script:form) -ne 'OK') { return }
    $payload = Write-BgjobsIndexRebuild @($dir.SelectedPath)
    [System.Windows.Forms.MessageBox]::Show("索引重建完成：$(@($payload.jobs).Count) 个任务", 'bgjobs', 'OK', 'Information')
    Update-GuiList
})

# auto-refresh every 2s (cheap: reads index + small job.json files)
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 2000
$script:timer.Add_Tick({ Update-GuiList })
$script:timer.Start()

# cleanup on close
$script:form.Add_FormClosed({
    $script:timer.Stop()
    try { if ($script:guiMutex) { $script:guiMutex.ReleaseMutex(); $script:guiMutex.Dispose() } } catch { }
})

Update-GuiList
[System.Windows.Forms.Application]::Run($script:form)
