# Deploy an unpublished image to the TEST environment (~/docker/cb-test).
#
# Builds locally, ships the image, and restarts cb-test on 7811. Never touches
# the production container or its data/.
#
# Why this exists: testing unpublished code used to mean overwriting the
# production compose.yaml with a local tag, which twice left `pull access
# denied` behind because the local tag is not in any registry.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Tag = 'cbtest',
  [string]$RemoteDir = '~/docker/cb-test'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Step($msg) { Write-Host ""; Write-Host "=== $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ok   $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  fail $msg" -ForegroundColor Red; exit 1 }

$repo = Split-Path -Parent $PSScriptRoot
$image = "cb-gateway:$Tag"

Step "Build $image"
$buildLog = Join-Path $env:TEMP 'cb-test-build.log'
# docker writes progress to stderr; capture at cmd level and read the exit code.
$ErrorActionPreference = 'Continue'
cmd /c "docker build -t $image `"$repo`" > `"$buildLog`" 2>&1"
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0) {
  Get-Content $buildLog -Tail 20 | ForEach-Object { Write-Host "    $_" }
  Fail 'docker build failed'
}
Ok 'built'

Step 'Export and compress'
$tar = Join-Path $env:TEMP "cb-test-$Tag.tar"
$gz = "$tar.gz"
Remove-Item $tar, $gz -Force -ErrorAction SilentlyContinue
$ErrorActionPreference = 'Continue'
cmd /c "docker save -o `"$tar`" $image" 2>&1 | Out-Null
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0) { Fail 'docker save failed' }

# Single gzip layer: wrapping the tar in another tar is what broke the old script.
$src = [System.IO.File]::OpenRead($tar)
$dst = [System.IO.File]::Create($gz)
$gzip = New-Object System.IO.Compression.GZipStream($dst, [System.IO.Compression.CompressionLevel]::Fastest)
$src.CopyTo($gzip)
$gzip.Dispose(); $dst.Dispose(); $src.Dispose()
Remove-Item $tar -Force
Ok ("{0:N1} MB" -f ((Get-Item $gz).Length / 1MB))

Step 'Upload'
$remoteArchive = "/tmp/cb-test-$Tag.tar.gz"
$ErrorActionPreference = 'Continue'
scp -o StrictHostKeyChecking=no -q $gz "${Server}:$remoteArchive" 2>&1 | Out-Null
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0) { Fail 'scp failed' }
Remove-Item $gz -Force -ErrorAction SilentlyContinue
Ok 'uploaded'

Step 'Restart test container'
# Single-quoted here-string keeps bash `$` intact. LF-only, BOM-less: PowerShell
# would otherwise prepend a BOM and bash reports `$'\357\273\277set'`.
$remote = @'
set -e
mkdir -p __REMOTE_DIR__/data
cd __REMOTE_DIR__

# Ship the test compose on first run; leave it alone afterwards so local edits survive.
if [ ! -f compose.yaml ]; then
  cat > compose.yaml <<'YAML'
services:
  cb-test:
    image: ghcr.io/wanlinus/creditbridge:latest
    container_name: cb-test
    restart: unless-stopped
    ports:
      - "7811:7801"
      - "18811:18801"
    environment:
      TZ: Asia/Shanghai
      QB_HOST: "0.0.0.0"
      QB_TRAE_LOGIN_HOST: "0.0.0.0"
      QB_TRAE_LOGIN_PORT: "18801"
      QB_TRAE_CALLBACK_BASE: "http://127.0.0.1:18801"
    volumes:
      - ./data:/app/data
    mem_limit: 1536m
YAML
fi

docker load -i __ARCHIVE__
rm -f __ARCHIVE__

# Patch the image line in place; the rest of compose.yaml stays as the user left it.
sed -i 's|^\(\s*\)image: .*|\1image: __IMAGE__|' compose.yaml
docker compose up -d --force-recreate

i=0
while [ $i -lt 40 ]; do
  st=$(docker inspect -f '{{.State.Health.Status}}' cb-test 2>/dev/null || echo none)
  if [ "$st" = "healthy" ]; then break; fi
  sleep 1
  i=$((i + 1))
done
docker ps --filter name=cb-test --format '{{.Names}}  {{.Image}}  {{.Status}}'
echo ""
echo "test env: http://<server>:7811"
'@

$remote = $remote.Replace('__REMOTE_DIR__', $RemoteDir).Replace('__ARCHIVE__', $remoteArchive).Replace('__IMAGE__', $image)
$scriptFile = Join-Path $env:TEMP 'cb-test-deploy.sh'
$remote = $remote -replace "`r", ''
[System.IO.File]::WriteAllText($scriptFile, $remote, (New-Object System.Text.UTF8Encoding($false)))

$ErrorActionPreference = 'Continue'
cmd /c "ssh -o StrictHostKeyChecking=no $Server bash -s < `"$scriptFile`" 2>&1"
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0) { Fail 'remote deploy failed' }

Write-Host ""
Write-Host "To reset the test env back to the published image:" -ForegroundColor Yellow
Write-Host "  .\cb-gateway\scripts\reset-test.ps1 -Server $Server"
Write-Host "  docker rmi $image"
