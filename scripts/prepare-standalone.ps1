param(
  [string]$PlatformToolsSource = "",
  [switch]$SkipPlatformToolsDownload
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$bundledRoot = Join-Path $projectRoot "bundled"
$pythonWork = Join-Path $projectRoot ".build\pyinstaller"
$pythonSpec = Join-Path $projectRoot ".build\spec"
$pythonOutput = $bundledRoot

New-Item -ItemType Directory -Force -Path $bundledRoot, $pythonWork, $pythonSpec | Out-Null

python -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --console `
  --name android-worker `
  --paths $projectRoot `
  --workpath $pythonWork `
  --specpath $pythonSpec `
  --distpath $pythonOutput `
  --add-data "$projectRoot\android_worker\mobile-api-template.json;android_worker" `
  "$projectRoot\android_worker\bundled_entry.py"
if ($LASTEXITCODE -ne 0) {
  throw "Không build được Android worker standalone."
}

$platformDestination = Join-Path $bundledRoot "platform-tools"
if ($PlatformToolsSource) {
  $resolvedSource = (Resolve-Path -LiteralPath $PlatformToolsSource).Path
  New-Item -ItemType Directory -Force -Path $platformDestination | Out-Null
  Copy-Item -LiteralPath (Join-Path $resolvedSource "adb.exe") -Destination $platformDestination -Force
  Copy-Item -LiteralPath (Join-Path $resolvedSource "AdbWinApi.dll") -Destination $platformDestination -Force
  Copy-Item -LiteralPath (Join-Path $resolvedSource "AdbWinUsbApi.dll") -Destination $platformDestination -Force
  if (Test-Path (Join-Path $resolvedSource "NOTICE.txt")) {
    Copy-Item -LiteralPath (Join-Path $resolvedSource "NOTICE.txt") -Destination $platformDestination -Force
  }
} elseif (-not $SkipPlatformToolsDownload -and -not (Test-Path (Join-Path $platformDestination "adb.exe"))) {
  $archive = Join-Path $env:TEMP "yt-worker-platform-tools.zip"
  $extractRoot = Join-Path $env:TEMP "yt-worker-platform-tools"
  Invoke-WebRequest `
    -Uri "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" `
    -OutFile $archive
  if (Test-Path $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
  Copy-Item -LiteralPath (Join-Path $extractRoot "platform-tools") -Destination $bundledRoot -Recurse -Force
}

$adbPath = Join-Path $platformDestination "adb.exe"
if (-not (Test-Path $adbPath)) {
  throw "Thiếu adb.exe trong bundled\platform-tools."
}

Write-Host "Standalone runtime ready:"
Write-Host "  Worker: $bundledRoot\android-worker\android-worker.exe"
Write-Host "  ADB:    $adbPath"
