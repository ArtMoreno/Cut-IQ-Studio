param([string]$RuntimeRoot = (Join-Path $PSScriptRoot "runtime"))

$ErrorActionPreference = "Stop"
$cache = Join-Path $PSScriptRoot ".cache"
$expanded = Join-Path $cache "expanded"
$expectedParent = (Resolve-Path -LiteralPath $PSScriptRoot).Path

function Reset-GeneratedDirectory([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if ([IO.Path]::GetDirectoryName($full) -ne $expectedParent -and [IO.Path]::GetDirectoryName($full) -ne $cache) {
    throw "Refusing to reset unexpected directory: $full"
  }
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
  New-Item -ItemType Directory -Path $full -Force | Out-Null
}

function Save-Verified([string]$Url, [string]$Destination, [string]$Sha256) {
  if (-not (Test-Path -LiteralPath $Destination)) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash
  if ($actual -ne $Sha256.ToUpperInvariant()) { throw "Checksum mismatch for $Destination. Expected $Sha256, got $actual." }
}

New-Item -ItemType Directory -Path $cache -Force | Out-Null
Reset-GeneratedDirectory $RuntimeRoot
Reset-GeneratedDirectory $expanded

$nodeVersion = "24.19.0"
$nodeArchive = Join-Path $cache "node-v$nodeVersion-win-x64.zip"
$nodeChecksums = Join-Path $cache "node-v$nodeVersion-SHASUMS256.txt"
if (-not (Test-Path -LiteralPath $nodeChecksums)) { Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile $nodeChecksums }
$nodeName = Split-Path $nodeArchive -Leaf
$nodeLine = Get-Content -LiteralPath $nodeChecksums | Where-Object { $_ -match "\s+$([regex]::Escape($nodeName))$" } | Select-Object -First 1
if (-not $nodeLine) { throw "Node.js checksum was not found." }
$nodeHash = ($nodeLine -split "\s+")[0]
Save-Verified "https://nodejs.org/dist/v$nodeVersion/$nodeName" $nodeArchive $nodeHash
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $expanded -Force
$nodeSource = Get-ChildItem -LiteralPath $expanded -Directory -Filter "node-v*-win-x64" | Select-Object -First 1
$nodeTarget = Join-Path $RuntimeRoot "node"
New-Item -ItemType Directory -Path $nodeTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeSource.FullName "node.exe") -Destination $nodeTarget
Copy-Item -LiteralPath (Join-Path $nodeSource.FullName "LICENSE") -Destination (Join-Path $nodeTarget "LICENSE.txt")

# No database server is bundled. Cut IQ stores project metadata in a single
# SQLite file, created and migrated by the app on first launch.

# Pinned to a dated autobuild tag, not `latest`. The `latest` tag is rolling:
# upstream republishes it, the bytes change, and the pinned checksum fails a
# build that never changed. This hash comes from the GitHub release asset
# digest, not from a local download.
$ffmpegArchive = Join-Path $cache "ffmpeg-n8.1.2-44-g7c533d0f86-win64-lgpl-8.1.zip"
Save-Verified "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-25-13-06/ffmpeg-n8.1.2-44-g7c533d0f86-win64-lgpl-8.1.zip" $ffmpegArchive "1C0D36FB52EB7B4112950E7D2C7BF4BCD55876FEC590EAE81813F9B0E61CA7C0"
Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $expanded -Force
$ffmpegSource = Get-ChildItem -LiteralPath $expanded -Directory -Filter "ffmpeg-*" | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "bin\ffmpeg.exe") } | Select-Object -First 1
$ffmpegTarget = Join-Path $RuntimeRoot "ffmpeg"
New-Item -ItemType Directory -Path $ffmpegTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ffmpegSource.FullName "bin\ffmpeg.exe") -Destination $ffmpegTarget
Copy-Item -LiteralPath (Join-Path $ffmpegSource.FullName "bin\ffprobe.exe") -Destination $ffmpegTarget
Get-ChildItem -LiteralPath $ffmpegSource.FullName -File | Where-Object { $_.Name -match "(?i)license|copying" } | Copy-Item -Destination $ffmpegTarget

$ytdlpArchive = Join-Path $cache "yt-dlp_win-2026.08.19.zip"
Save-Verified "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_win.zip" $ytdlpArchive "30B4C14AAFAB6082BECFF7881E41B76DF46DC43EA7633479410A91E29DA492BF"
$ytdlpTarget = Join-Path $RuntimeRoot "yt-dlp"
New-Item -ItemType Directory -Path $ytdlpTarget -Force | Out-Null
Expand-Archive -LiteralPath $ytdlpArchive -DestinationPath $ytdlpTarget -Force

Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -File | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $($_.Path.Substring($RuntimeRoot.Length + 1).Replace('\','/'))" } | Set-Content -LiteralPath (Join-Path $RuntimeRoot "SHA256SUMS.txt") -Encoding ASCII
Write-Host "Cut IQ runtime prepared at $RuntimeRoot"
