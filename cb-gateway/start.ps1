$ErrorActionPreference = 'Stop'
$node = $null
$runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
if (Test-Path $runtimes) {
  foreach ($dir in Get-ChildItem -Path $runtimes -Directory -ErrorAction SilentlyContinue) {
    $candidate = Join-Path $dir.FullName 'dependencies\node\bin\node.exe'
    if (Test-Path $candidate) { $node = $candidate; break }
  }
}
if (-not $node) {
  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  if ($fromPath) { $node = $fromPath.Source } else { throw "node not found: 既没有 DSH 自带 node，PATH 上也没有" }
}
$script = Join-Path $PSScriptRoot 'src\index.ts'
if (-not (Test-Path $script)) { throw "gateway script not found: $script" }

$existing = Get-NetTCPConnection -LocalPort 7801 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Output "gateway already listening on 7801"
  exit 0
}

Start-Process -FilePath $node -ArgumentList @($script) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Start-Sleep -Seconds 4
try {
  Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:7801/login' -TimeoutSec 10 | Out-Null
  Write-Output "gateway up on http://127.0.0.1:7801"
} catch {
  Write-Output "gateway failed to start; check data\logs"
  exit 1
}
