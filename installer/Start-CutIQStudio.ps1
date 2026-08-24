param(
  [switch]$NoOpen,
  [switch]$SmokeTest
)

$ErrorActionPreference = "Stop"
$installRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$localRoot = if ($env:CUTIQ_LOCAL_ROOT) { [IO.Path]::GetFullPath($env:CUTIQ_LOCAL_ROOT) } else { Join-Path $env:LOCALAPPDATA "Cut IQ Studio" }
$dataRoot = Join-Path $localRoot "Data"
$databaseRoot = Join-Path $dataRoot "MariaDB"
$logRoot = Join-Path $localRoot "Logs"
$browserRoot = Join-Path $localRoot "Browser"
$clipsRoot = if ($env:CUTIQ_CLIPS_ROOT) { [IO.Path]::GetFullPath($env:CUTIQ_CLIPS_ROOT) } else { Join-Path ([Environment]::GetFolderPath("MyVideos")) "Cut IQ Studio\Clips" }
$configPath = Join-Path $localRoot "config.json"
$appPidPath = Join-Path $dataRoot "cut-iq.pid"
$dbPidPath = Join-Path $dataRoot "mariadb.pid"
$nodePath = Join-Path $installRoot "runtime\node\node.exe"
$mariaRoot = Join-Path $installRoot "runtime\mariadb"
$mariaBin = Join-Path $mariaRoot "bin"
$mariaServer = Join-Path $mariaBin "mariadbd.exe"
$mariaInstall = Join-Path $mariaBin "mariadb-install-db.exe"
$mariaClient = Join-Path $mariaBin "mariadb.exe"
$mariaAdmin = Join-Path $mariaBin "mariadb-admin.exe"
$schemaPath = Join-Path $installRoot "resources\schema.sql"
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
  foreach ($folder in @($localRoot, $dataRoot, $databaseRoot, $logRoot, $browserRoot, $clipsRoot)) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
  }
  foreach ($required in @($nodePath, $mariaServer, $mariaInstall, $mariaClient, $mariaAdmin, $schemaPath, $bootPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "The Cut IQ installation is incomplete: $required" }
  }

  if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  } else {
    $config = [pscustomobject]@{
      appPort = Get-FreePort 3127 3137
      databasePort = Get-FreePort 3317 3327
      databaseRootPassword = New-Secret
      databaseAppPassword = New-Secret
      appSecret = New-Secret
    }
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
  }

  $dbPort = [int]$config.databasePort
  $appPort = [int]$config.appPort
  $dbInitialized = Test-Path -LiteralPath (Join-Path $databaseRoot "mysql")
  if (-not $dbInitialized) {
    $installArgs = @("--datadir=$databaseRoot", "--password=$($config.databaseRootPassword)", "--port=$dbPort", "--silent")
    $init = Start-Process -FilePath $mariaInstall -WorkingDirectory $mariaRoot -ArgumentList $installArgs -WindowStyle Hidden -Wait -PassThru
    if ($init.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $databaseRoot "mysql"))) {
      throw "The local Cut IQ database could not be initialized."
    }
  }

  $dbRunning = $false
  if (Test-Path -LiteralPath $dbPidPath) {
    $storedPid = [int](Get-Content -LiteralPath $dbPidPath -Raw)
    $storedProcess = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
    $dbRunning = $storedProcess -and $storedProcess.Path -eq $mariaServer
  }
  if (-not $dbRunning) {
    if (-not (Test-PortFree $dbPort)) { throw "Local database port $dbPort is already in use by another application." }
    $dbLog = Join-Path $logRoot "mariadb.log"
    $dbArgs = @("--datadir=$databaseRoot", "--port=$dbPort", "--bind-address=127.0.0.1", "--pid-file=$dbPidPath", "--log-error=$dbLog", "--console")
    Start-Process -FilePath $mariaServer -WorkingDirectory $mariaRoot -ArgumentList $dbArgs -WindowStyle Hidden | Out-Null
  }

  $env:MYSQL_PWD = [string]$config.databaseRootPassword
  Wait-Until -Seconds 40 -Failure "The local Cut IQ database did not become ready." -Condition {
    & $mariaAdmin --protocol=TCP --host=127.0.0.1 --port=$dbPort --user=root ping 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
  }

  $schemaMarker = Join-Path $dataRoot "schema-v1.ready"
  if (-not (Test-Path -LiteralPath $schemaMarker)) {
    $appPassword = [string]$config.databaseAppPassword
    $bootstrap = "CREATE DATABASE IF NOT EXISTS cutiq CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS 'cutiq'@'127.0.0.1' IDENTIFIED BY '$appPassword'; ALTER USER 'cutiq'@'127.0.0.1' IDENTIFIED BY '$appPassword'; GRANT ALL PRIVILEGES ON cutiq.* TO 'cutiq'@'127.0.0.1'; FLUSH PRIVILEGES;"
    $bootstrap | & $mariaClient --protocol=TCP --host=127.0.0.1 --port=$dbPort --user=root
    if ($LASTEXITCODE -ne 0) { throw "The Cut IQ database account could not be created." }
    Get-Content -LiteralPath $schemaPath -Raw | & $mariaClient --protocol=TCP --host=127.0.0.1 --port=$dbPort --user=root cutiq
    if ($LASTEXITCODE -ne 0) { throw "The Cut IQ database schema could not be installed." }
    New-Item -ItemType File -Path $schemaMarker -Force | Out-Null
  }
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue

  $url = "http://127.0.0.1:$appPort/"
  if (-not (Test-HttpReady $url)) {
    if (-not (Test-PortFree $appPort)) { throw "Local app port $appPort is already in use by another application." }
    $env:NODE_ENV = "production"
    $env:PORT = [string]$appPort
    $env:APP_ID = "cut-iq-studio"
    $env:APP_SECRET = [string]$config.appSecret
    $env:DATABASE_URL = "mysql://cutiq:$($config.databaseAppPassword)@127.0.0.1:$dbPort/cutiq"
    $env:CLIPSIFT_APP_ROOT = Join-Path $installRoot "app"
    $env:CLIPSIFT_INSTALL_ROOT = $installRoot
    $env:CLIPSIFT_RUNTIME_DIR = Join-Path $installRoot "runtime"
    $env:CLIPS_DIR = $clipsRoot
    $env:CLIPSIFT_PACKAGE_OUTPUT_DIR = Join-Path $clipsRoot "Clip Packages"
    $env:CLIPSIFT_LOCAL_GOOGLE_DRIVE_ROOT = ""
    $appOut = Join-Path $logRoot "app.log"
    $appErr = Join-Path $logRoot "app-error.log"
    $appProcess = Start-Process -FilePath $nodePath -WorkingDirectory (Join-Path $installRoot "app") -ArgumentList $bootPath -WindowStyle Hidden -RedirectStandardOutput $appOut -RedirectStandardError $appErr -PassThru
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
