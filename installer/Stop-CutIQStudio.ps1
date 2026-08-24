$ErrorActionPreference = "SilentlyContinue"
$installRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$localRoot = if ($env:CUTIQ_LOCAL_ROOT) { [IO.Path]::GetFullPath($env:CUTIQ_LOCAL_ROOT) } else { Join-Path $env:LOCALAPPDATA "Cut IQ Studio" }
$dataRoot = Join-Path $localRoot "Data"
$targets = @(
  @{ PidFile = Join-Path $dataRoot "cut-iq.pid"; Executable = Join-Path $installRoot "runtime\node\node.exe" },
  @{ PidFile = Join-Path $dataRoot "mariadb.pid"; Executable = Join-Path $installRoot "runtime\mariadb\bin\mariadbd.exe" }
)
foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target.PidFile)) { continue }
  $processId = [int](Get-Content -LiteralPath $target.PidFile -Raw)
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process -and $process.Path -eq $target.Executable) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    $process.WaitForExit(10000)
  }
  Remove-Item -LiteralPath $target.PidFile -Force -ErrorAction SilentlyContinue
}
