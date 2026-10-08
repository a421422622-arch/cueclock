<#
  给 CueClock.exe 做 Authenticode 数字签名（发布者显示为证书里的名字，这里是「Fawen」）。
  证书从环境变量读取（GitHub Actions 里来自仓库 Secrets，私钥不进仓库）：
    CUECLOCK_SIGN_PFX_BASE64    PFX 文件的 base64
    CUECLOCK_SIGN_PFX_PASSWORD  PFX 密码
  用法：.\sign.ps1 -File path\to\CueClock.exe
  说明：这是**自签名**证书。签名本身有效（改动文件会让签名失效），发布者显示为 Fawen；但别的电脑默认不信任这张证书，
        需要运行 trust-fawen-certificate.ps1 导入一次，否则仍会提示「未知发布者」。要让所有电脑直接信任，需要向证书机构购买代码签名证书。
#>
param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'
if (-not $env:CUECLOCK_SIGN_PFX_BASE64 -or -not $env:CUECLOCK_SIGN_PFX_PASSWORD) { throw '没有签名证书（CUECLOCK_SIGN_PFX_BASE64 / CUECLOCK_SIGN_PFX_PASSWORD）' }
if (-not (Test-Path $File)) { throw "找不到 $File" }
$pfx = Join-Path ([IO.Path]::GetTempPath()) ("cc-sign-" + [guid]::NewGuid().ToString('N') + '.pfx')
try {
  [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:CUECLOCK_SIGN_PFX_BASE64))
  $secure = ConvertTo-SecureString $env:CUECLOCK_SIGN_PFX_PASSWORD -AsPlainText -Force
  $cert = Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $secure
  try {
    $signed = $false
    foreach ($ts in 'http://timestamp.digicert.com', 'http://timestamp.sectigo.com', 'http://timestamp.globalsign.com/tsa/r6advanced1') {
      try {
        $r = Set-AuthenticodeSignature -FilePath $File -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $ts
        if ($r.SignerCertificate) { $signed = $true; Write-Host "已签名（时间戳 $ts）"; break }
      } catch { Write-Host "时间戳服务器 $ts 失败：$($_.Exception.Message)" }
    }
    if (-not $signed) { throw '签名失败（所有时间戳服务器都不可用）' }
  } finally { Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue }
} finally { Remove-Item $pfx -Force -ErrorAction SilentlyContinue }
$sig = Get-AuthenticodeSignature $File
Write-Host "签名状态：$($sig.Status)；发布者：$($sig.SignerCertificate.Subject)"
if (($sig.Status -in @('NotSigned', 'HashMismatch')) -or ($sig.SignerCertificate.Subject -notmatch 'CN=Fawen')) { throw "签名无效：$($sig.Status) $($sig.StatusMessage)" }
