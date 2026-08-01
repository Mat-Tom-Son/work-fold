param(
  [string]$Publisher = "Mat-Tom-Son work-fold",
  [string]$OutputDirectory = (Join-Path $HOME ".work-fold-signing"),
  [ValidateRange(1, 10)][int]$ValidYears = 3
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$pfxPath = Join-Path $OutputDirectory "work-fold-Personal-Code-Signing.pfx"
$publicPath = Join-Path $OutputDirectory "work-fold-Personal-Code-Signing.cer"
$passwordPath = Join-Path $OutputDirectory "work-fold-Personal-Code-Signing.password.dpapi"
$metadataPath = Join-Path $OutputDirectory "work-fold-Personal-Code-Signing.json"

$existing = @(@($pfxPath, $publicPath, $passwordPath, $metadataPath) | Where-Object { Test-Path -LiteralPath $_ })
if ($existing.Count -eq 4) {
  Write-Host "work-fold personal signing certificate already exists at $OutputDirectory."
  Get-Content -Raw -LiteralPath $metadataPath
  exit 0
}
if ($existing.Count -gt 0) {
  throw "Signing directory contains a partial certificate set. Move or remove it deliberately before creating another identity: $OutputDirectory"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$plainPassword = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$securePassword = ConvertTo-SecureString -String $plainPassword -AsPlainText -Force

$certificate = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=$Publisher" `
  -FriendlyName "work-fold personal code signing" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyAlgorithm RSA `
  -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears($ValidYears)

Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassword | Out-Null
Export-Certificate -Cert $certificate -FilePath $publicPath -Type CERT | Out-Null
$securePassword | ConvertFrom-SecureString | Set-Content -LiteralPath $passwordPath -Encoding ascii -NoNewline

$metadata = [ordered]@{
  subject = $certificate.Subject
  thumbprint = $certificate.Thumbprint
  notBefore = $certificate.NotBefore.ToUniversalTime().ToString("o")
  notAfter = $certificate.NotAfter.ToUniversalTime().ToString("o")
  pfxPath = $pfxPath
  publicCertificatePath = $publicPath
  passwordProtection = "Windows DPAPI for the current user"
  publiclyTrusted = $false
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, "FullControl", $inheritance, $propagation, $allow)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", $inheritance, $propagation, $allow)))
Set-Acl -LiteralPath $OutputDirectory -AclObject $acl

[Array]::Clear($bytes, 0, $bytes.Length)
$plainPassword = $null
$securePassword.Dispose()

Write-Host "Created work-fold personal code-signing certificate."
$metadata | ConvertTo-Json
