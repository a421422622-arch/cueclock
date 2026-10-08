<#
  可选：用「任务计划程序」给 CueClock 做崩溃后自动重启（Windows 版目前没有 macOS 那种系统守护）。
    登录时自动启动（隐藏到托盘）；程序异常退出（退出码非 0）后每 1 分钟重试，最多 999 次；正常退出不会被拉起。
  用法（PowerShell，用当前用户运行，不需要管理员）：
    .\install-guard-task.ps1 -Exe "C:\CueClock\CueClock.exe"          # 安装
    .\install-guard-task.ps1 -Remove                                   # 卸载
  注意：
    - 和界面里的「开机自动启动」选一个用就行；两个都开也没事（程序只允许一个实例，后启动的会自己退出），但没必要。
    - 这个脚本没有在真实 Windows 现场验证过，装好后请注销再登录、再手动结束进程测试一次。
#>
param(
  [string]$Exe = "$PSScriptRoot\CueClock.exe",
  [switch]$Remove
)
$name = 'CueClock Guard'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已卸载任务：$name"
  return
}
if (-not (Test-Path $Exe)) { throw "找不到 $Exe；用 -Exe 指定 CueClock.exe 的完整路径" }
$action   = New-ScheduledTaskAction -Execute (Resolve-Path $Exe).Path -Argument '--hidden'
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "已安装任务：$name（下次登录生效）。立即启动：Start-ScheduledTask -TaskName '$name'"
