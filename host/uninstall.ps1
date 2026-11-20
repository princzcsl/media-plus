# Removes the Media+ companion (yt-dlp and ffmpeg stay installed).
$ErrorActionPreference = 'Continue'
$name = 'com.mediaplus.host'
$dir = Join-Path $env:LOCALAPPDATA 'MediaPlus'

Get-Process MediaPlusHost -ErrorAction SilentlyContinue | Stop-Process -Force
foreach ($key in @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts'
)) {
  Remove-Item -Path (Join-Path $key $name) -Force -ErrorAction SilentlyContinue
}
Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Media+ companion removed.' -ForegroundColor Green
