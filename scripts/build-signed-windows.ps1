param(
  [string]$CertificatePath = (Join-Path $HOME ".work-fold-signing\work-fold-Personal-Code-Signing.pfx"),
  [string]$PasswordFile = (Join-Path $HOME ".work-fold-signing\work-fold-Personal-Code-Signing.password.dpapi"),
  # Defaults to the node on PATH; use fnm or nvm to put Node 24 first.
  [string]$Node = "",
  # A test build has no update feed and ends with SHA256SUMS and a build record.
  [switch]$TestBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $Node) {
  $found = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) { throw "Node was not found on PATH. Put Node 24 first on PATH (for example with fnm) or pass -Node." }
  $Node = $found.Source
}
$nodeVersion = [version](& $Node -p "process.versions.node")
if ($nodeVersion -lt [version]"22.19.0") { throw "work-fold needs Node 22.19 or newer (Node 24 for release builds); $Node is $nodeVersion." }
# Use the npm that ships with this Node, never an older one elsewhere on PATH.
$nodeDir = Split-Path -Parent $Node
$npmCli = Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js"

if (-not (Test-Path -LiteralPath $CertificatePath)) { throw "Signing certificate not found: $CertificatePath. Run scripts\create-personal-signing-certificate.ps1 first." }
if (-not (Test-Path -LiteralPath $PasswordFile)) { throw "DPAPI password file not found: $PasswordFile" }
if (-not (Test-Path -LiteralPath $npmCli)) { throw "npm was not found beside $Node." }

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
  if ($TestBuild) { $env:WORKFOLD_WINDOWS_TEST_BUILD = "1" }

  Push-Location $repoRoot
  try {
    & $node $npmCli run desktop:make
    if ($LASTEXITCODE -ne 0) { throw "Signed work-fold build failed with exit code $LASTEXITCODE." }
    if ($TestBuild) {
      & $node (Join-Path $repoRoot "scripts\windows-test-build-record.mjs")
      if ($LASTEXITCODE -ne 0) { throw "Recording the test build failed with exit code $LASTEXITCODE." }
    }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:\WIN_CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:\WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:\WORKFOLD_REQUIRE_CODE_SIGNING -ErrorAction SilentlyContinue
  Remove-Item Env:\WORKFOLD_TRUSTED_CODE_SIGNING -ErrorAction SilentlyContinue
  Remove-Item Env:\CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
  Remove-Item Env:\WORKFOLD_WINDOWS_TEST_BUILD -ErrorAction SilentlyContinue
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $plainPassword = $null
  $securePassword.Dispose()
}
