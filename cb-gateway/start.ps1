$ErrorActionPreference = 'Stop'
# 优先用 DSH 自带的 Node（版本最确定），找不到就退回 PATH 上的 node。
#
# **探测而不是写死路径**：写死的那份只在某一台机器上成立，随包发出去等于没有这个分支
# （2026-11 之前就是这样，收件人机器上 start.ps1 直接不可用）。顺带也不再把用户名写进仓库。
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
  # 探 /login 而不是 /health：/health 在 v2 已删（404），/api/health 要认证（401），
  # 只有公开的登录页能证明服务真的起来了（和容器 healthcheck 同一个判据）。
  Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:7801/login' -TimeoutSec 10 | Out-Null
  Write-Output "gateway up on http://127.0.0.1:7801"
} catch {
  Write-Output "gateway failed to start; check data\logs"
  exit 1
}
