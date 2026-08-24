param(
  [switch]$SkipRuntime,
  [switch]$SkipQualityGates
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Push-Location $repo
try {
  if (-not $SkipQualityGates) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw "TypeScript check failed." }
    & npm.cmd run lint
    if ($LASTEXITCODE -ne 0) { throw "Lint failed." }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Production build failed." }
  }
  if (-not $SkipRuntime) { & (Join-Path $PSScriptRoot "prepare-runtime.ps1") }

  $compiler = @(
    $env:INNO_ISCC,
    "C:\Program Files\Inno Setup 7\ISCC.exe",
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 7\ISCC.exe"),
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $compiler) { throw "Inno Setup 7 is required. Install it from https://jrsoftware.org/isdl.php" }

  $process = Start-Process -FilePath $compiler -ArgumentList (Join-Path $PSScriptRoot "CutIQStudio.iss") -WorkingDirectory $PSScriptRoot -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Inno Setup failed with exit code $($process.ExitCode)." }
  $installer = Join-Path $PSScriptRoot "output\Cut-IQ-Studio-Setup.exe"
  if (-not (Test-Path -LiteralPath $installer)) { throw "Installer output was not created." }
  Get-FileHash -Algorithm SHA256 -LiteralPath $installer | ForEach-Object { "$($_.Hash)  Cut-IQ-Studio-Setup.exe" } | Set-Content -LiteralPath (Join-Path $PSScriptRoot "output\SHA256SUMS.txt") -Encoding ASCII
  Get-Item -LiteralPath $installer | Select-Object FullName, Length, LastWriteTime
} finally {
  Pop-Location
}
