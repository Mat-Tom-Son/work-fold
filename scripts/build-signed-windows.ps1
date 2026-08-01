param(
  [string]$CertificatePath = (Join-Path $HOME ".work-fold-signing\work-fold-Personal-Code-Signing.pfx"),
  [string]$PasswordFile = (Join-Path $HOME ".work-fold-signing\work-fold-Personal-Code-Signing.password.dpapi")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$nodeDir = "C:\Users\mat_t\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
$node = Join-Path $nodeDir "node.exe"
$npmCli = "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"

if (-not (Test-Path -LiteralPath $CertificatePath)) { throw "Signing certificate not found: $CertificatePath" }
if (-not (Test-Path -LiteralPath $PasswordFile)) { throw "DPAPI password file not found: $PasswordFile" }
if (-not (Test-Path -LiteralPath $node)) { throw "Supported bundled Node runtime not found: $node" }
if (-not (Test-Path -LiteralPath $npmCli)) { throw "npm CLI not found: $npmCli" }

$securePassword = Get-Content -Raw -LiteralPath $PasswordFile | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$plainPassword = $null

try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $env:Path = "$nodeDir;$env:Path"
  $env:WIN_CSC_LINK = (Resolve-Path -LiteralPath $CertificatePath).Path
  $env:WIN_CSC_KEY_PASSWORD = $plainPassword
  $env:WORKFOLD_REQUIRE_CODE_SIGNING = "1"
  $env:WORKFOLD_TRUSTED_CODE_SIGNING = "0"
  $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

  Push-Location $repoRoot
  try {
    & $node $npmCli run desktop:make
    if ($LASTEXITCODE -ne 0) { throw "Signed work-fold build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:\WIN_CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:\WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:\WORKFOLD_REQUIRE_CODE_SIGNING -ErrorAction SilentlyContinue
  Remove-Item Env:\WORKFOLD_TRUSTED_CODE_SIGNING -ErrorAction SilentlyContinue
  Remove-Item Env:\CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $plainPassword = $null
  $securePassword.Dispose()
}
