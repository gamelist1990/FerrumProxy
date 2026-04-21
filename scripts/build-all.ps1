param(
  [ValidateSet("release", "debug")]
  [string]$BuildProfile = "release",
  [string[]]$Targets = @(
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin"
  ),
  [switch]$StopOnError
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutRoot = Join-Path $ProjectRoot "target/build"
$Cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $Cargo -and $env:USERPROFILE) {
  $Candidate = Join-Path $env:USERPROFILE ".cargo/bin/cargo.exe"
  if (Test-Path $Candidate) {
    $CargoPath = $Candidate
  }
}
if ($Cargo) {
  $CargoPath = $Cargo.Source
}
if (-not $Cargo) {
  if (-not $CargoPath) {
    throw "cargo was not found. Install Rust or add %USERPROFILE%\.cargo\bin to PATH."
  }
}

$Rustup = Get-Command rustup -ErrorAction SilentlyContinue
if (-not $Rustup -and $env:USERPROFILE) {
  $Candidate = Join-Path $env:USERPROFILE ".cargo/bin/rustup.exe"
  if (Test-Path $Candidate) {
    $RustupPath = $Candidate
  }
}
if ($Rustup) {
  $RustupPath = $Rustup.Source
}

function Get-PlatformName([string]$Target) {
  switch ($Target) {
    "x86_64-pc-windows-msvc" { "windows-x64"; break }
    "aarch64-pc-windows-msvc" { "windows-arm64"; break }
    "x86_64-unknown-linux-gnu" { "linux-x64"; break }
    "aarch64-unknown-linux-gnu" { "linux-arm64"; break }
    "x86_64-apple-darwin" { "macos-x64"; break }
    "aarch64-apple-darwin" { "macos-arm64"; break }
    default { $Target; break }
  }
}

function Get-BinaryName([string]$Target) {
  if ($Target -like "*windows*") {
    "ferrum-proxy.exe"
  } else {
    "ferrum-proxy"
  }
}

New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null
$Results = @()

foreach ($Target in $Targets) {
  $Platform = Get-PlatformName $Target
  $BinaryName = Get-BinaryName $Target
  $ProfileDir = if ($BuildProfile -eq "release") { "release" } else { "debug" }
  $BuiltBinary = Join-Path $ProjectRoot "target/$Target/$ProfileDir/$BinaryName"
  $PlatformDir = Join-Path $OutRoot $Platform
  $OutBinary = Join-Path $PlatformDir $BinaryName

    Write-Host "==> Building $Platform ($Target)"

  try {
    if ($RustupPath) {
      & $RustupPath target add $Target
    }

    $CargoArgs = @("build", "--target", $Target)
    if ($BuildProfile -eq "release") {
      $CargoArgs += "--release"
    }
    & $CargoPath @CargoArgs

    New-Item -ItemType Directory -Force -Path $PlatformDir | Out-Null
    Copy-Item -Force $BuiltBinary $OutBinary
    $Results += [pscustomobject]@{
      platform = $Platform
      target = $Target
      ok = $true
      binary = $OutBinary
      error = $null
    }
  } catch {
    $Results += [pscustomobject]@{
      platform = $Platform
      target = $Target
      ok = $false
      binary = $null
      error = $_.Exception.Message
    }
    Write-Warning "Failed to build $Platform ($Target): $($_.Exception.Message)"
    if ($StopOnError) {
      throw
    }
  }
}

$ManifestPath = Join-Path $OutRoot "manifest.json"
$ManifestJson = ConvertTo-Json -InputObject @($Results) -Depth 4
Set-Content -Encoding UTF8 -Path $ManifestPath -Value $ManifestJson

Write-Host ""
Write-Host "Build output: $OutRoot"
Write-Host "Manifest: $ManifestPath"
$Results | Format-Table -AutoSize

if (($Results | Where-Object { -not $_.ok }).Count -gt 0 -and $StopOnError) {
  exit 1
}
