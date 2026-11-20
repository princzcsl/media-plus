# Installs the Media+ companion for the current Windows user (no admin rights needed):
# yt-dlp + ffmpeg (through winget when missing), the native messaging host, and its registration
# for Chrome, Edge, Brave and Chromium.
param(
  [string]$ExtensionId = 'amnnhcofdonkbnjlkehejchodbigckna'
)

$ErrorActionPreference = 'Stop'
$name = 'com.mediaplus.host'
$dir = Join-Path $env:LOCALAPPDATA 'MediaPlus'

function Write-Step($text) { Write-Host "  > $text" -ForegroundColor Cyan }

function Find-Tool($tool) {
  $cmd = Get-Command $tool -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { return $null }
  $item = Get-Item $cmd.Source
  # winget puts symlinks in its Links folder: keep the real file.
  if ($item.LinkType -and $item.Target) { return [string]($item.Target | Select-Object -First 1) }
  return $cmd.Source
}

function Update-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host ''
Write-Host 'Media+ companion' -ForegroundColor White
Write-Host ''

$ytdlp = Find-Tool 'yt-dlp'
$ffmpeg = Find-Tool 'ffmpeg'
$winget = Get-Command winget -ErrorAction SilentlyContinue

if (-not $ytdlp) {
  if (-not $winget) { throw 'yt-dlp was not found and winget is not available. Install yt-dlp, then run this script again.' }
  Write-Step 'Installing yt-dlp (winget)'
  winget install -e --id yt-dlp.yt-dlp --accept-source-agreements --accept-package-agreements | Out-Host
  Update-Path
  $ytdlp = Find-Tool 'yt-dlp'
}
if (-not $ffmpeg) {
  if ($winget) {
    Write-Step 'Installing ffmpeg (winget)'
    winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements | Out-Host
    Update-Path
    $ffmpeg = Find-Tool 'ffmpeg'
  }
}
if (-not $ytdlp) { throw 'yt-dlp is still not found. Open a new terminal and run this script again.' }
if (-not $ffmpeg) { Write-Warning 'ffmpeg not found: MP3, extracts and best-quality YouTube downloads need it.' }

Write-Step "yt-dlp: $ytdlp"
if ($ffmpeg) { Write-Step "ffmpeg: $ffmpeg" }

New-Item -ItemType Directory -Force $dir | Out-Null

Write-Step 'Building the host'
$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
$exe = Join-Path $dir 'MediaPlusHost.exe'
Get-Process MediaPlusHost -ErrorAction SilentlyContinue | Stop-Process -Force
& $csc /nologo /optimize /target:exe "/out:$exe" /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'MediaPlusHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

$utf8 = New-Object System.Text.UTF8Encoding $false
$config = @{ ytdlp = $ytdlp; ffmpeg = $(if ($ffmpeg) { $ffmpeg } else { '' }) } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $dir 'config.json'), $config, $utf8)

$manifestPath = Join-Path $dir "$name.json"
$manifest = [ordered]@{
  name = $name
  description = 'Media+ companion (yt-dlp)'
  path = $exe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifest, $utf8)

Write-Step 'Registering for Chrome, Edge, Brave and Chromium'
$keys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts'
)
foreach ($key in $keys) {
  $path = Join-Path $key $name
  New-Item -Path $path -Force | Out-Null
  Set-Item -Path $path -Value $manifestPath
}

Write-Host ''
Write-Host 'Done. Open the Media+ popup again: downloads now go through yt-dlp.' -ForegroundColor Green
Write-Host "Installed in $dir (uninstall: host\uninstall.ps1)"
