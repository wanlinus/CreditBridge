# Deploy: build image locally -> ship to server -> load -> restart container.
#
# Why not build on the server: that would require the server to hold the full source
# tree plus web/dist, so the deploy directory ends up with 7 build inputs and every
# code change needs an scp of src/. Now the server only keeps compose.yaml + data/,
# and all code lives inside the image.
#
# Usage (from repo root):
#   .\cb-gateway\scripts\deploy.ps1              # build + deploy
#   .\cb-gateway\scripts\deploy.ps1 -SkipBuild   # re-ship current image (compose-only change)
#   .\cb-gateway\scripts\deploy.ps1 -DryRun      # build only, no transfer
#
# Prereq: Docker Desktop installed and running. Frontend bundle must be built first
# (npm run build:web) because Dockerfile's `COPY web/dist` fails the build when missing.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 as GBK when there
# is no BOM, so any non-ASCII literal turns into mojibake and breaks parsing.

[CmdletBinding()]
param(
  # 目标服务器。**必须显式传**：留默认值会让别人 clone 下来直接跑时连到一台
  # 莫名其妙的机器上，而 scp/ssh 会照常执行、只在最后报认证失败——很难第一时间
  # 意识到「连错地方了」。
  [Parameter(Mandatory = $true)]
  [string]$Server,
  [string]$RemoteDir = '~/docker/cb-gateway',
  [string]$Image = 'cb-gateway:local',
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$gatewayDir = Join-Path $repoRoot 'cb-gateway'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ok   $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- preflight

Step 'Preflight'

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) { Fail 'docker not found. Install Docker or Docker Desktop.' }
# `docker version` rather than `docker info --format ...`: the baseline form,
# and it answers the same question -- is the engine responding.
docker version 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'docker engine is not responding. Run "docker version" to see why.' }
Ok "docker $(docker --version)"

$indexHtml = Join-Path $gatewayDir 'web\dist\index.html'
if (-not (Test-Path $indexHtml)) {
  Fail "missing cb-gateway/web/dist/index.html. Run 'npm run build:web' in cb-gateway/ first."
}
Ok 'frontend bundle present'

$dockerfile = Join-Path $gatewayDir 'Dockerfile'
if (-not (Test-Path $dockerfile)) { Fail 'cb-gateway/Dockerfile not found' }
Ok 'Dockerfile present'

# ---------------------------------------------------------------- build

if (-not $SkipBuild) {
  Step "Build image $Image"
  Push-Location $gatewayDir
  try {
    docker build -t $Image .
    if ($LASTEXITCODE -ne 0) { Fail 'docker build failed' }
  } finally { Pop-Location }
  Ok "built $Image"
}

if ($DryRun) { Step 'DryRun: skip transfer and deploy'; Ok 'done'; exit 0 }

# ---------------------------------------------------------------- ship

Step 'Export image'
$tarball = Join-Path $env:TEMP 'cb-gateway-image.tar'
if (Test-Path $tarball) { Remove-Item $tarball -Force }
docker save -o $tarball $Image
if ($LASTEXITCODE -ne 0) { Fail 'docker save failed' }
$mb = [math]::Round((Get-Item $tarball).Length / 1MB, 1)
Ok "exported $mb MB"

Step "Transfer to $Server"
# gzip the tar's BYTES, not the tar file.
#
# The earlier version did `tar -czf x.tar.gz x.tar`, which wraps the archive in
# ANOTHER archive. On the server `tar -xzf` then yields the inner .tar file
# instead of the image, and `docker load` reports "unrecognized image format"
# (observed 2026-11-23). Compressing the byte stream keeps it a single archive.
$gz = "$tarball.gz"
if (Test-Path $gz) { Remove-Item $gz -Force }
$source = [System.IO.File]::OpenRead($tarball)
try {
  $target = [System.IO.File]::Create($gz)
  try {
    $gzip = New-Object System.IO.Compression.GZipStream($target, [System.IO.Compression.CompressionLevel]::Optimal)
    try { $source.CopyTo($gzip) } finally { $gzip.Dispose() }
  } finally { $target.Dispose() }
} finally { $source.Dispose() }
$gzMb = [math]::Round((Get-Item $gz).Length / 1MB, 1)
Ok "compressed to $gzMb MB"

scp $gz "${Server}:/tmp/cb-gateway-image.tar.gz"
if ($LASTEXITCODE -ne 0) { Fail 'scp failed' }
Ok 'uploaded'

# ---------------------------------------------------------------- remote

Step 'Load and restart on server'
# Send a bash script over stdin. Do NOT inline this in an ssh command string:
# PowerShell would re-parse the quotes before ssh ever sees them.
$remote = @'
set -e
cd REMOTE_DIR
echo "  -- docker load"
docker load -i /tmp/cb-gateway-image.tar.gz
rm -f /tmp/cb-gateway-image.tar.gz
echo "  -- compose up"
docker compose up -d --force-recreate
echo "  -- waiting for healthy"
i=0
while [ $i -lt 30 ]; do
  st=$(docker inspect -f '{{.State.Health.Status}}' cb-gateway 2>/dev/null || echo none)
  if [ "$st" = "healthy" ]; then break; fi
  sleep 1
  i=$((i + 1))
done
echo "  -- status"
docker compose ps
'@

$remote = $remote.Replace('REMOTE_DIR', $RemoteDir)

# Write the script to a file and feed it to ssh via cmd's stdin redirect.
#
# Why not `$remote | ssh host 'bash -s'`: PowerShell's pipeline encodes the text
# and prepends a UTF-8 BOM, and the here-string's CRLF endings survive, so bash
# receives "\ufeffset -e\r" and fails with
#   $'\357\273\277set': command not found
#   cd: '/home/wanli/docker/cb-gateway\r': No such file or directory
# (both observed 2026-11-23 -- this path had never actually run end to end).
#
# Writing an explicit LF-only, BOM-less file and letting cmd do `< file` is the
# only form that keeps both bytes out of the stream.
$scriptFile = Join-Path $env:TEMP 'cb-remote-deploy.sh'
$remote = $remote -replace "`r", ''
[System.IO.File]::WriteAllText($scriptFile, $remote, (New-Object System.Text.UTF8Encoding($false)))

cmd /c "ssh $Server bash -s < `"$scriptFile`""
$code = $LASTEXITCODE
Remove-Item $scriptFile -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { Fail 'remote deploy failed' }

Step 'Done'
Ok 'image updated, container restarted'
Write-Host @"

Rollback:
  database backup    /tmp/gw-before-*.db
  previous image     docker images (cb-gateway:local history is not kept; re-deploy an
                     older checkout instead)
"@
