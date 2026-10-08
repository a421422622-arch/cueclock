<#
  让这台电脑信任「Fawen」代码签名证书：之后 CueClock.exe 的发布者显示为 Fawen 且签名验证为有效。
  只需要运行一次，需要「以管理员身份运行 PowerShell」。
    .\trust-fawen-certificate.ps1
  做了什么：把同目录的 Fawen-CodeSigning.cer 导入「受信任的根证书颁发机构」和「受信任的发布者」（本机）。
  撤销：certmgr.msc → 受信任的根证书颁发机构 / 受信任的发布者 → 删除 Fawen。
  注意：这张是自签名证书，只对你信任它的电脑有效；这只影响签名验证，不会让 Windows SmartScreen 的「下载文件」提示消失
        （那个提示取决于文件来源和信誉，右键文件 → 属性 → 勾选「解除锁定」可以去掉）。
#>
$ErrorActionPreference = 'Stop'
$cer = Join-Path $PSScriptRoot 'Fawen-CodeSigning.cer'
if (-not (Test-Path $cer)) { throw "找不到 $cer" }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw '请「以管理员身份运行」PowerShell 再执行' }
foreach ($store in 'Root', 'TrustedPublisher') { Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\LocalMachine\$store" | Out-Null }
$c = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $cer
Write-Host "已信任：$($c.Subject)  指纹 $($c.Thumbprint)"
