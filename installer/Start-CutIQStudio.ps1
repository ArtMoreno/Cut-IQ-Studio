param(
  [switch]$NoOpen,
  [switch]$SmokeTest
)

$ErrorActionPreference = "Stop"
$installRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$localRoot = if ($env:CUTIQ_LOCAL_ROOT) { [IO.Path]::GetFullPath($env:CUTIQ_LOCAL_ROOT) } else { Join-Path $env:LOCALAPPDATA "Cut IQ Studio" }
$dataRoot = Join-Path $localRoot "Data"
$logRoot = Join-Path $localRoot "Logs"
$browserRoot = Join-Path $localRoot "Browser"
$clipsRoot = if ($env:CUTIQ_CLIPS_ROOT) { [IO.Path]::GetFullPath($env:CUTIQ_CLIPS_ROOT) } else { Join-Path ([Environment]::GetFolderPath("MyVideos")) "Cut IQ Studio\Clips" }
$configPath = Join-Path $localRoot "config.json"
$appPidPath = Join-Path $dataRoot "cut-iq.pid"
$nodePath = Join-Path $installRoot "runtime\node\node.exe"
# One SQLite file beside the user's other app data. The app creates and
# migrates it on first launch; there is no database server to start.
$databaseFile = Join-Path $dataRoot "cut-iq-studio.db"
$migrationsPath = Join-Path $installRoot "resources\migrations"
$bootPath = Join-Path $installRoot "app\dist\boot.js"

function New-Secret { return ([Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")) }

function Test-PortFree([int]$Port) {
  $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  return -not ($listeners | Where-Object { $_.Port -eq $Port })
}

function Get-FreePort([int]$Start, [int]$End) {
  foreach ($candidate in $Start..$End) { if (Test-PortFree $candidate) { return $candidate } }
  throw "Cut IQ could not find a free local port between $Start and $End."
}

function Test-HttpReady([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Headers @{ Accept = "text/html" } -Uri $Url -TimeoutSec 2
    return $response.StatusCode -eq 200 -and $response.Content -match "Cut IQ Studio"
  } catch { return $false }
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$Failure) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw $Failure
}

try {
  foreach ($folder in @($localRoot, $dataRoot, $logRoot, $browserRoot, $clipsRoot)) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
  }
  foreach ($required in @($nodePath, $migrationsPath, $bootPath)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "The Cut IQ installation is incomplete: $required" }
  }

  if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  } else {
    $config = [pscustomobject]@{
      appPort = Get-FreePort 3127 3137
      appSecret = New-Secret
    }
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
  }

  $appPort = [int]$config.appPort

  $url = "http://127.0.0.1:$appPort/"
  if (-not (Test-HttpReady $url)) {
    if (-not (Test-PortFree $appPort)) { throw "Local app port $appPort is already in use by another application." }
    $env:NODE_ENV = "production"
    $env:PORT = [string]$appPort
    $env:APP_ID = "cut-iq-studio"
    $env:APP_SECRET = [string]$config.appSecret
    $env:CUTIQ_DATABASE_FILE = $databaseFile
    $env:CUTIQ_MIGRATIONS_DIR = $migrationsPath
    $env:CLIPSIFT_APP_ROOT = Join-Path $installRoot "app"
    $env:CLIPSIFT_INSTALL_ROOT = $installRoot
    $env:CLIPSIFT_RUNTIME_DIR = Join-Path $installRoot "runtime"
    $env:CLIPS_DIR = $clipsRoot
    $env:CLIPSIFT_PACKAGE_OUTPUT_DIR = Join-Path $clipsRoot "Clip Packages"
    $env:CLIPSIFT_LOCAL_GOOGLE_DRIVE_ROOT = ""
    $appOut = Join-Path $logRoot "app.log"
    $appErr = Join-Path $logRoot "app-error.log"
    # Quoted: the default install path contains spaces, and Start-Process would
    # otherwise hand node a path truncated at the first one.
    $appProcess = Start-Process -FilePath $nodePath -WorkingDirectory (Join-Path $installRoot "app") -ArgumentList "`"$bootPath`"" -WindowStyle Hidden -RedirectStandardOutput $appOut -RedirectStandardError $appErr -PassThru
    Set-Content -LiteralPath $appPidPath -Value $appProcess.Id -Encoding ASCII
    Wait-Until -Seconds 60 -Failure "Cut IQ Studio did not become ready. See $appErr" -Condition { Test-HttpReady $url }
  }

  if ($SmokeTest) {
    [pscustomobject]@{ status = "ready"; url = $url; clips = $clipsRoot; data = $dataRoot } | ConvertTo-Json -Compress
    exit 0
  }

  if (-not $NoOpen) {
    $edge = Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
    $chrome = Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"
    if (Test-Path -LiteralPath $edge) {
      Start-Process -FilePath $edge -ArgumentList @("--app=$url", "--window-size=1500,950", "--user-data-dir=$browserRoot") | Out-Null
    } elseif (Test-Path -LiteralPath $chrome) {
      Start-Process -FilePath $chrome -ArgumentList @("--app=$url", "--window-size=1500,950", "--user-data-dir=$browserRoot") | Out-Null
    } else {
      Start-Process $url | Out-Null
    }
  }
} catch {
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $message = "$(Get-Date -Format o) $($_.Exception.Message)"
  Add-Content -LiteralPath (Join-Path $logRoot "launcher-error.log") -Value $message
  if ($SmokeTest) { Write-Error $_; exit 1 }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($_.Exception.Message, "Cut IQ Studio", "OK", "Error") | Out-Null
  exit 1
}
