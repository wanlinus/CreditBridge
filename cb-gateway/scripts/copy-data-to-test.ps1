# Copy the PRODUCTION data snapshot into the TEST environment (~/docker/cb-test).
#
# Why not a plain `cp`: the gateway runs SQLite in WAL mode, and the WAL is
# routinely larger than the main db (measured 1.8M db vs 4.0M wal). Copying only
# gateway.db silently loses everything not yet checkpointed -- the ledger looks
# truncated for no visible reason. `VACUUM INTO` writes a consistent single-file
# snapshot instead.
#
# Read-only on the production side: the only write is a temp file inside the
# container's own data dir, removed right after.
#
# NOTE: this file must stay pure ASCII. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as GBK, so Chinese literals here would come out as mojibake.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$ProdDir = '~/docker/cb-gateway',
  [string]$TestDir = '~/docker/cb-test'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Step($msg) { Write-Host ""; Write-Host "=== $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ok   $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  fail $msg" -ForegroundColor Red; exit 1 }

# Single-quoted here-string: bash `$` and backticks survive untouched.
# LF-only, BOM-less -- PowerShell would prepend a BOM and bash reports
# `$'\357\273\277set': command not found`.
$remote = @'
set -e

echo "  -- production data"
docker exec cb-gateway node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/gateway.db');
console.log('     usage_record: ' + db.prepare('SELECT COUNT(*) AS c FROM usage_record').get().c);
console.log('     account:      ' + db.prepare('SELECT COUNT(*) AS c FROM account').get().c);
"

echo "  -- VACUUM INTO snapshot (plain cp would miss the WAL)"
docker exec cb-gateway node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const out = '/app/data/snapshot.db';
try { fs.unlinkSync(out); } catch {}
new DatabaseSync('/app/data/gateway.db').exec(\"VACUUM INTO '/app/data/snapshot.db'\");
console.log('     snapshot ' + (fs.statSync(out).size / 1024 / 1024).toFixed(1) + ' MB');
"

echo "  -- stop test container and swap data"
cd __TEST_DIR__
docker compose down
rm -rf data/*
docker cp cb-gateway:/app/data/snapshot.db data/gateway.db
cp __PROD_DIR__/data/config.json data/config.json
docker exec cb-gateway rm -f /app/data/snapshot.db

echo "  -- start test env"
docker compose up -d
i=0
while [ $i -lt 40 ]; do
  st=$(docker inspect -f '{{.State.Health.Status}}' cb-test 2>/dev/null || echo none)
  if [ "$st" = "healthy" ]; then break; fi
  sleep 1
  i=$((i + 1))
done

echo "  -- verify"
docker exec cb-test node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/gateway.db');
console.log('     usage_record: ' + db.prepare('SELECT COUNT(*) AS c FROM usage_record').get().c);
console.log('     account:      ' + db.prepare('SELECT COUNT(*) AS c FROM account').get().c);
"
docker ps --filter name=cb-test --format '     {{.Names}}  {{.Image}}  {{.Status}}'
'@

$remote = $remote.Replace('__TEST_DIR__', $TestDir).Replace('__PROD_DIR__', $ProdDir)
$scriptFile = Join-Path $env:TEMP 'cb-copy-data.sh'
$remote = $remote -replace "`r", ''
[System.IO.File]::WriteAllText($scriptFile, $remote, (New-Object System.Text.UTF8Encoding($false)))

Step 'Copy production data into the test environment'
$ErrorActionPreference = 'Continue'
cmd /c "ssh -o StrictHostKeyChecking=no $Server bash -s < `"$scriptFile`" 2>&1"
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0) { Fail 'copy failed' }

Write-Host ""
Ok 'test env now mirrors production data'
Write-Host "  The test container writes to its own data/ -- production is untouched." -ForegroundColor Yellow
