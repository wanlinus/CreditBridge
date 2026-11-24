# Deploy to server: pull the GHCR image and recreate the container.
#
# The image is built by GitHub Actions (.github/workflows/ci.yml) on every push to
# master. The server keeps only compose.yaml and data/ -- no source code.
#
# Usage (from repo root):
#   .\cb-gateway\scripts\deploy.ps1 -Server <host>
#   .\cb-gateway\scripts\deploy.ps1 -Server <host> -Tag v1.2.3   # pin a version
#   .\cb-gateway\scripts\deploy.ps1 -Server <host> -DryRun       # show, do nothing
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 as GBK when
# there is no BOM, so any non-ASCII literal turns into mojibake and breaks parsing.

[CmdletBinding()]
param(
  # Required on purpose: a default would let someone clone this repo, run the
  # script, and ssh into an unrelated machine. ssh would connect fine and only
  # fail at the end, which is hard to diagnose.
  [Parameter(Mandatory = $true)]
  [string]$Server,
  [string]$RemoteDir = '~/docker/cb-gateway',
  # Image tag. Defaults to latest (tracks master). Pass a tag like v1.2.3 to pin.
  [string]$Tag = 'latest',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ok   $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red; exit 1 }

$image = "ghcr.io/wanlinus/creditbridge:$Tag"

Step "Deploy $image to $Server"

if ($DryRun) {
  Write-Host "  would run on $Server :"
  Write-Host "    scp cb-gateway/compose.yaml -> $RemoteDir/compose.yaml"
  Write-Host "    cd $RemoteDir"
  Write-Host "    docker compose pull"
  Write-Host "    docker compose up -d --force-recreate"
  Ok 'dry run, nothing changed'
  exit 0
}

# Step 1: ship compose.yaml verbatim.
#
# It must be shipped, not just patched. An earlier version only `sed`-patched the
# image line, so any other change to compose.yaml (adding QB_HOST, changing
# mem_limit) silently never reached the server -- which left the container
# listening on 127.0.0.1 with the port mapping dead. Ship the whole file so the
# server is always exactly what is in the repo.
$compose = Join-Path $PSScriptRoot '..\compose.yaml'
if (-not (Test-Path $compose)) { Fail "compose.yaml not found at $compose" }

Step 'Upload compose.yaml'
$ErrorActionPreference = 'Continue'
scp -o StrictHostKeyChecking=no -q $compose "${Server}:${RemoteDir}/compose.yaml.new" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = 'Stop'; Fail 'scp compose.yaml failed' }
$ErrorActionPreference = 'Stop'
Ok 'compose.yaml uploaded'

# Remote script. Single-quoted here-string: no PowerShell interpolation, so the
# bash `$` and backticks survive untouched. Placeholders are replaced below.
#
# The script is written as LF-only, BOM-less and fed to bash via cmd's stdin
# redirect. PowerShell's pipeline would prepend a UTF-8 BOM and keep CRLF, and
# bash then reports `$'\357\273\277set': command not found`.
$remote = @'
set -e
cd __REMOTE_DIR__
# Swap in the shipped compose.yaml only after it parses; a broken one would take
# the container down on the next `up`.
if [ -f compose.yaml.new ]; then
  if docker compose -f compose.yaml.new config --quiet 2>/dev/null; then
    cp compose.yaml "compose.yaml.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
    mv compose.yaml.new compose.yaml
    echo "  -- compose.yaml updated"
  else
    rm -f compose.yaml.new
    echo "  !! shipped compose.yaml is invalid, kept the old one" >&2
    exit 1
  fi
fi
sed -i "s|^\([[:space:]]*\)image: ghcr.io/wanlinus/creditbridge:.*|\1image: __IMAGE__|" compose.yaml
echo "  -- pull"
docker compose pull
echo "  -- up"
docker compose up -d --force-recreate
echo "  -- waiting for healthy"
i=0
while [ $i -lt 40 ]; do
  st=$(docker inspect -f '{{.State.Health.Status}}' cb-gateway 2>/dev/null || echo none)
  if [ "$st" = "healthy" ]; then break; fi
  sleep 1
  i=$((i + 1))
done
echo "  -- status"
docker ps --filter name=cb-gateway --format '{{.Names}}  {{.Image}}  {{.Status}}'
'@

$remote = $remote.Replace('__REMOTE_DIR__', $RemoteDir).Replace('__IMAGE__', $image)

$scriptFile = Join-Path $env:TEMP 'cb-remote-deploy.sh'
$remote = $remote -replace "`r", ''
[System.IO.File]::WriteAllText($scriptFile, $remote, (New-Object System.Text.UTF8Encoding($false)))

# docker pull writes progress to stderr. Under `cmd /c` PowerShell surfaces every
# stderr line as a NativeCommandError and the call throws, so redirect stderr into
# stdout at the cmd level and read the exit code instead of the stream.
$ErrorActionPreference = 'Continue'
cmd /c "ssh -o StrictHostKeyChecking=no $Server bash -s < `"$scriptFile`" 2>&1"
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Remove-Item $scriptFile -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { Fail 'remote deploy failed' }

Step 'Done'
Ok "deployed $image"
Write-Host @"

Rollback:
  docker compose down
  # switch to the previous tag (or digest) in compose.yaml, then up -d
  # data/gateway.db is never touched by a deploy
"@
