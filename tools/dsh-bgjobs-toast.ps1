# dsh-bgjobs-toast.ps1 - Windows 通知帮助脚本（bgjobs）
#
# 参考 windows-notification.ps1：优先 Windows 10/11 Toast 通知（现代化弹窗），失败回退
# 经典气泡通知（System.Windows.Forms.NotifyIcon），支持自定义标题/消息/AppId。
# 退出码：0=成功（Toast 或气泡），1=两种均失败。
#
# Toast 必须在 Windows PowerShell 5.1 下运行：pwsh 7（.NET Core）无法加载 WinRT 类型
# （[Windows.UI.Notifications...] 解析失败），调用方需经
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File 本脚本 -Title ... -Message ...
# 委托给 5.1 执行。
#
# 首次 Toast 调用会创建带 AppUserModelID 的开始菜单快捷方式（bgjobs.lnk）——Windows Toast
# 显示的必要条件：App 必须有 Start Menu 快捷方式且带 PKEY_AppUserModel_ID，否则
# Show() 抛 0x803E0105 或静默不显示。
param(
    [string]$Title = '',
    [string]$Message = '',
    [string]$AppId = 'bgjobs'
)
$ErrorActionPreference = 'Stop'

# Follow the Windows UI language for the default texts; explicit -Title/-Message win.
$toastZh = [System.Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh*'
if (-not $Title) { $Title = if ($toastZh) { 'bgjobs 提醒' } else { 'bgjobs reminder' } }
if (-not $Message) { $Message = if ($toastZh) { '任务完成' } else { 'Job finished' } }

# ── Method 1: WinRT Toast（5.1 原生可加载 WinRT 类型）────────────────────
function Send-BgjobsToast {


# 发 Toast（5.1 原生可加载 WinRT 类型）

    # 非 Windows PowerShell 5.x（如 pwsh 7/.NET Core，无法加载 WinRT 类型）：用 5.1 重启本脚本
    if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
        & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Title $Title -Message $Message -AppId $AppId
        exit $LASTEXITCODE
    }




    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
        [Windows.UI.Notifications.ToastTemplateType]::ToastText02
    )
    $xml = [xml]$template.GetXml()
    ($xml.toast.visual.binding.text | Where-Object {$_.id -eq "1"}).AppendChild($xml.CreateTextNode($Title)) | Out-Null
    ($xml.toast.visual.binding.text | Where-Object {$_.id -eq "2"}).AppendChild($xml.CreateTextNode($Message)) | Out-Null
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml.OuterXml)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)

return $true
}

# ── Method 2: 经典气泡通知（回退；参考 windows-notification.ps1）─────────
function Send-BgjobsBalloon {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $notification = New-Object System.Windows.Forms.NotifyIcon
    $notification.Icon = [System.Drawing.SystemIcons]::Information
    $notification.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $notification.BalloonTipTitle = $Title
    $notification.BalloonTipText = $Message
    $notification.Visible = $true
    $notification.ShowBalloonTip(5000)
    Start-Sleep -Milliseconds 5000
    $notification.Dispose()
}

# ── 按顺序尝试：Toast 优先，失败回退气泡 ────────────────────────────────
$toastFallback = if ($toastZh) { 'Toast 通知失败，回退气泡通知...' } else { 'Toast failed, falling back to balloon...' }
$toastFatal = if ($toastZh) { 'bgjobs 通知失败：Toast 与气泡通知均不可用' } else { 'bgjobs notification failed: neither Toast nor balloon is available' }
try { Send-BgjobsToast; exit 0 } catch { [Console]::WriteLine($toastFallback) }
try { Send-BgjobsBalloon; exit 0 } catch { }
[Console]::Error.WriteLine($toastFatal)
exit 1
