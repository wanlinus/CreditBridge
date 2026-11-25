# Reset the TEST environment (~/docker/cb-test) back to the published GHCR image.
#
# Needed after deploy-test.ps1: the test compose points at a local tag that exists
# in no registry, so leaving it there makes the next `docker compose pull` fail
# with "pull access denied".
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$RemoteDir = '~/docker/cb-test'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Write-Host ""
Write-Host "=== Reset test env to ghcr.io/wanlinus/creditbridge:latest ===" -ForegroundColor Cyan

# Single-quoted here-string: no PowerShell interpolation, so bash `$` survives.
$remote = @'
set -e
cd __REMOTE_DIR__
if [ ! -f compose.yaml ]; then
  echo "  no compose.yaml in __REMOTE_DIR__" >&2
  exit 1
fi
sed -i 's|^\(\s*\)image: .*|\1image: ghcr.io/wanlinus/creditbridge:latest|' compose.yaml
docker compose pull
docker compose up -d --force-recreate
sleep 12
docker ps --filter name=cb-test --format '{{.Names}}  {{.Image}}  {{.Status}}'
'@

$remote = $remote.Replace('__REMOTE_DIR__', $RemoteDir)
$scriptFile = Join-Path $env:TEMP 'cb-test-reset.sh'
$remote = $remote -replace "`r", ''
[System.IO.File]::WriteAllText($scriptFile, $remote, (New-Object System.Text.UTF8Encoding($false)))

$ErrorActionPreference = 'Continue'
cmd /c "ssh -o StrictHostKeyChecking=no $Server bash -s < `"$scriptFile`" 2>&1"
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0) {
  Write-Host "  fail reset failed" -ForegroundColor Red
  exit 1
}

Write-Host "  ok   test env back on the published image" -ForegroundColor Green
