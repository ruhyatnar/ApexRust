# ApexRust Quant Windows Bootstrapper (PowerShell)
# Checks prerequisites, offers winget installation for missing tools, refreshes PATH,
# and hands off to `node scripts/apexrust.mjs setup`.
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PassThruArgs
)

$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Refresh-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $extra = @(
    "$env:USERPROFILE\.cargo\bin",
    "$env:ProgramFiles\nodejs",
    "$env:ProgramFiles\Git\cmd"
  )
  $parts = @()
  foreach ($chunk in @($machine, $user, ($extra -join ';'))) {
    if ($chunk) { $parts += ($chunk -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }) }
  }
  $env:Path = ($parts | Select-Object -Unique) -join ';'
}

function Test-NodeOk {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  & node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>=23 ? 0 : 1)" 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Test-RustOk {
  $rustc = Get-Command rustc -ErrorAction SilentlyContinue
  $cargo = Get-Command cargo -ErrorAction SilentlyContinue
  if (-not $rustc -or -not $cargo) { return $false }
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = (& rustc --version) 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    if ($out -match '(\d+)\.(\d+)\.') {
      $maj = [int]$Matches[1]; $min = [int]$Matches[2]
      return ($maj -gt 1 -or ($maj -eq 1 -and $min -ge 85))
    }
    return $false
  } finally {
    $ErrorActionPreference = $prevPref
  }
}

function Test-MsvcOk {
  if (Get-Command cl.exe -ErrorAction SilentlyContinue) { return $true }
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { return $false }
  $found = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  return [bool]($found -and $found.Trim().Length -gt 0)
}

$AutoYes = ($PassThruArgs -contains '-y') -or ($PassThruArgs -contains '--yes') -or ($PassThruArgs -contains '--non-interactive')
$NeedRust = $true
for ($i = 0; $i -lt $PassThruArgs.Count; $i++) {
  if ($PassThruArgs[$i] -eq '--components=web') { $NeedRust = $false }
  elseif ($PassThruArgs[$i] -eq '--components' -and ($i + 1) -lt $PassThruArgs.Count -and $PassThruArgs[$i + 1] -eq 'web') {
    $NeedRust = $false
  }
}

function Confirm-WingetInstall([string]$Label, [string]$WingetId, [string]$ExtraOverride = '') {
  $hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
  if (-not $hasWinget) {
    Write-Error "$Label is missing and winget is unavailable. Please install $Label manually and re-run install.ps1."
  }
  $proceed = $AutoYes
  if (-not $proceed) {
    $ans = Read-Host "$Label is missing. Install via winget ($WingetId)? [Y/n]"
    $proceed = ($ans -eq '' -or $ans -match '^[yY]')
  }
  if (-not $proceed) {
    Write-Error "$Label is required."
  }
  $args = @('install', '--id', $WingetId, '-e', '--accept-source-agreements', '--accept-package-agreements')
  if ($ExtraOverride) { $args += @('--override', $ExtraOverride) }
  Write-Host "==> Installing $Label ($WingetId)..." -ForegroundColor Cyan
  & winget @args
  if ($LASTEXITCODE -ne 0) {
    Write-Error "winget failed to install $Label."
  }
  Refresh-SessionPath
}

Write-Host '==> Checking Windows prerequisites for ApexRust Quant...' -ForegroundColor Cyan
Refresh-SessionPath

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Confirm-WingetInstall 'Git' 'Git.Git'
}

if (-not (Test-NodeOk)) {
  Confirm-WingetInstall 'Node.js LTS' 'OpenJS.NodeJS.LTS'
}

if ($NeedRust) {
  if (-not (Test-RustOk)) {
    if (Get-Command rustup -ErrorAction SilentlyContinue) {
      Write-Host '==> Updating Rust toolchain via rustup...' -ForegroundColor Cyan
      & rustup default stable
      if ($LASTEXITCODE -ne 0) { Write-Error 'rustup default stable failed.' }
    } else {
      Confirm-WingetInstall 'Rustup (Rust toolchain)' 'Rustlang.Rustup'
      if (Get-Command rustup -ErrorAction SilentlyContinue) {
        & rustup default stable
        if ($LASTEXITCODE -ne 0) { Write-Error 'rustup default stable failed.' }
      }
    }
  }
  if (-not (Test-MsvcOk)) {
    Confirm-WingetInstall 'Visual Studio 2022 C++ Build Tools' 'Microsoft.VisualStudio.2022.BuildTools' '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
  }
}

Write-Host '==> Launching ApexRust setup CLI...' -ForegroundColor Cyan
& node "$RepoDir\scripts\apexrust.mjs" setup @PassThruArgs
exit $LASTEXITCODE
