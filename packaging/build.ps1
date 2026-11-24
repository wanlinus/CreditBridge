#Requires -Version 5.1
<#
.SYNOPSIS
    Builds a distributable folder for the CreditBridge package.

.DESCRIPTION
    Produces <repo>\dist\CreditBridgeForDSH\ containing:

      install.ps1                       one-shot installer / uninstaller
      README.md                         what a friend needs to know
      merge-providers.mjs               merges the provider config into a DSH profile
      providers.json                    gateway provider skeleton (stripped here)
      cb-gateway\                    gateway sources (no data\, no secrets)
      cb-dsh\                plugin sources
      cb-dsh-<ver>.tgz       packed plugin for pnpm to install

    Then zips it. The zip contains no credentials: data\ is excluded, only the
    gateway provider's skeleton is extracted from this machine's DSH profile
    (never tokenhub or anything else), with baseURL / apiKeyEnv / models / headers
    stripped out, and the build fails outright if anything token-shaped slips in.

.PARAMETER SkipZip
    Build the folder but skip creating the .zip.

.NOTES
    The provider entries (baseURL / headers / displayName) are read from THIS
    machine's DSH profile so the package stays in sync with whatever is
    configured here.

    Model lists are NOT part of it any more: DSH does not discover models from
    baseURL at startup (measured — it only reads the profile's `models:` block),
    and the gateway no longer has channel-prefix routes. The plugin's host half
    pulls `GET /api/models` every 15s and writes that block into the profile
    instead. That is why nothing here needs to know the model names.

    The build therefore requires a DSH profile on the machine running it.
#>
[CmdletBinding()]
param(
    [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Derive the project root from this script's own location rather than hardcoding
# it: the build must work from a clone at any path, and a stale literal here
# silently packs the wrong tree.
$RepoRoot  = Split-Path -Parent $PSScriptRoot

$DistRoot  = Join-Path $RepoRoot 'dist'
$OutDir    = Join-Path $DistRoot 'CreditBridgeForDSH'
$StageDir  = Join-Path $DistRoot '_stage'

$GatewaySrc = Join-Path $RepoRoot 'cb-gateway'
$PluginSrc  = Join-Path $RepoRoot 'cb-dsh'

function Write-Step([string]$t) { Write-Host ""; Write-Host ("== " + $t) -ForegroundColor Cyan }
function Write-Ok([string]$t)   { Write-Host ("   " + $t) -ForegroundColor Green }
function Write-Warn2([string]$t){ Write-Host ("   WARN " + $t) -ForegroundColor Yellow }
function Fail([string]$t)       { Write-Host ("ERROR " + $t) -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- clean

Write-Step 'Preparing output'
if (Test-Path $DistRoot) { Remove-Item $DistRoot -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir, $StageDir -Force | Out-Null
Write-Ok $OutDir

# ---------------------------------------------------------------- toolchain

Write-Step 'Locating Node + pnpm'

# Borrow DSH's own runtime so the build needs no global install. pnpm is used to
# pack the plugin; node also runs the provider-extraction helper.
$pnpmCjs = $null
$nodeExe = $null
$runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
foreach ($rt in Get-ChildItem $runtimes -Directory -ErrorAction SilentlyContinue) {
    $deps = Join-Path $rt.FullName 'dependencies'
    $n = Join-Path $deps 'node\bin\node.exe'
    $p = Join-Path $deps 'pnpm\bin\pnpm.cjs'
    if ((Test-Path $n) -and (Test-Path $p)) { $nodeExe = $n; $pnpmCjs = $p; break }
}
if (-not $pnpmCjs) {
    # Fall back to a system node + the DSH profile's pnpm, so a differently
    # laid-out DSH install still builds.
    $sys = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    $profilePnpm = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\pnpm\bin\pnpm.cjs'
    if ($sys -and (Test-Path $profilePnpm)) { $nodeExe = $sys; $pnpmCjs = $profilePnpm }
}
if (-not $pnpmCjs) { Fail 'could not find DSH bundled Node + pnpm' }
Write-Ok ("node " + $nodeExe)
Write-Ok ("pnpm " + $pnpmCjs)

# ---------------------------------------------------------------- providers

Write-Step 'Extracting provider config from the local DSH profile'

<#
The friend needs ONE provider entry -- the gateway's -- to exist in their DSH
profile, otherwise the gateway is reachable but nothing in the UI points at it.
That entry lives in this machine's cordis.patch.yml, so pull its skeleton out and
ship it as data.

extract-providers.mjs ships the skeleton only: baseURL, apiKeyEnv, models and
headers belong to THIS machine and are stripped (the recipient fills in their own
address and key through the 积分桥 panel). It also will not copy tokenhub or any
other provider, because those either need the user's own API key or are private
preferences. Keep it that way.
#>
$profilePatch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
if (-not (Test-Path $profilePatch)) {
    Fail ('no DSH profile patch at ' + $profilePatch + ' - run DSH once on this machine first, so the provider entries can be extracted')
}

$providersJson = Join-Path $OutDir 'providers.json'
$extractScript = Join-Path $PSScriptRoot 'extract-providers.mjs'
& $nodeExe $extractScript $profilePatch $providersJson
if ($LASTEXITCODE -ne 0) { Fail 'provider extraction failed' }
Write-Ok 'providers.json'

# ---------------------------------------------------------------- pack plugin

Write-Step 'Packing the DSH plugin'

$pkg = Get-Content (Join-Path $PluginSrc 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
Write-Ok ("version " + $version)

# pnpm pack needs just the shipping files; package.json "files" already
# restricts it, but packing from a staging copy guarantees no stray files.
$stagePlugin = Join-Path $StageDir 'cb-dsh'
New-Item -ItemType Directory -Path $stagePlugin -Force | Out-Null
Copy-Item (Join-Path $PluginSrc 'package.json')   $stagePlugin -Force
Copy-Item (Join-Path $PluginSrc 'README.md')      $stagePlugin -Force
Copy-Item (Join-Path $PluginSrc 'cordis.patch.yml') $stagePlugin -Force
Copy-Item (Join-Path $PluginSrc 'lib')            $stagePlugin -Recurse -Force

Push-Location $stagePlugin
try {
    $packOut = & $nodeExe $pnpmCjs pack --pack-destination $StageDir 2>&1
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($code -ne 0) { Write-Host ($packOut | Out-String); Fail 'pnpm pack failed' }

$tarball = Get-ChildItem $StageDir -Filter '*.tgz' | Select-Object -First 1
if (-not $tarball) { Fail 'no tarball produced' }
Write-Ok ($tarball.Name + "  " + [math]::Round($tarball.Length/1KB,1) + " KB")

# ---------------------------------------------------------------- copy trees

Write-Step 'Copying sources'

# Gateway: code and docs only. data\ holds this machine's tokens, ledger and
# device ids and must never ship.
$gatewayOut = Join-Path $OutDir 'cb-gateway'
New-Item -ItemType Directory -Path $gatewayOut -Force | Out-Null
foreach ($name in 'src','tools','test') {
    Copy-Item (Join-Path $GatewaySrc $name) (Join-Path $gatewayOut $name) -Recurse -Force
}
foreach ($name in 'package.json','tsconfig.json','README.md','ARCHITECTURE.md','start.ps1','stop.ps1') {
    Copy-Item (Join-Path $GatewaySrc $name) (Join-Path $gatewayOut $name) -Force
}
Write-Ok 'cb-gateway (data\ excluded)'

$pluginOut = Join-Path $OutDir 'cb-dsh'
New-Item -ItemType Directory -Path $pluginOut -Force | Out-Null
foreach ($name in 'package.json','README.md','cordis.patch.yml') {
    Copy-Item (Join-Path $PluginSrc $name) (Join-Path $pluginOut $name) -Force
}
Copy-Item (Join-Path $PluginSrc 'lib') (Join-Path $pluginOut 'lib') -Recurse -Force
Write-Ok 'cb-dsh'

Copy-Item $tarball.FullName $OutDir -Force
Write-Ok ($tarball.Name + ' placed at package root')

# ------------------------------------------------- docs + runtime helpers

Write-Step 'Adding installer, merge helper and readme'

$installSrc = Join-Path $PSScriptRoot 'install.ps1'
if (-not (Test-Path $installSrc)) { Fail ("install.ps1 missing at " + $installSrc) }
Copy-Item $installSrc (Join-Path $OutDir 'install.ps1') -Force
Write-Ok 'install.ps1'

# Runs on the friend's machine at install time; needs js-yaml, which DSH ships.
$mergeSrc = Join-Path $PSScriptRoot 'merge-providers.mjs'
if (-not (Test-Path $mergeSrc)) { Fail ("merge-providers.mjs missing at " + $mergeSrc) }
Copy-Item $mergeSrc (Join-Path $OutDir 'merge-providers.mjs') -Force
Write-Ok 'merge-providers.mjs'

$readmeSrc = Join-Path $PSScriptRoot 'DIST-README.md'
if (-not (Test-Path $readmeSrc)) { Fail ("DIST-README.md missing at " + $readmeSrc) }
Copy-Item $readmeSrc (Join-Path $OutDir 'README.md') -Force
Write-Ok 'README.md'

# ---------------------------------------------------------------- secret gate

<#
This is the part that matters. data\ is excluded above, but a stray token could
still reach the output through a copied source file, a committed config, or the
extracted provider block. Scan every shipped text file for credential material
and abort if anything matches.

The patterns target *values*, not identifiers: an earlier version matched the
bare word `atrestSecretKey` and fired on a source file that merely reads that
field, which would train whoever runs this build to ignore the gate. A real leak
looks like a long opaque string assigned to one of those keys, or a JWT.

`Authorization: Bearer local` in providers.json is a placeholder string, not a
credential — the auth gate rejects it. That is why the Bearer pattern needs
30+ characters: the floor keeps the placeholder from ever tripping the gate.
#>
Write-Step 'Scanning the package for credentials'

$patterns = @(
    '"access[_-]?token"\s*:\s*"[A-Za-z0-9._-]{20,}',
    '"refresh[_-]?token"\s*:\s*"[A-Za-z0-9._-]{20,}',
    '"accessToken"\s*:\s*"[A-Za-z0-9._-]{20,}',
    '"atRestSecretKey"\s*:\s*"[^"]{20,}',
    'Bearer\s+[A-Za-z0-9._-]{30,}',
    'eyJhbGciOi[A-Za-z0-9._-]{20,}'
)
$textExt = @('.mjs','.js','.cjs','.json','.yml','.yaml','.md','.ps1','.txt','.ts')

$violations = @()
foreach ($file in Get-ChildItem $OutDir -Recurse -File) {
    if ($textExt -notcontains $file.Extension) { continue }
    $content = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    foreach ($pattern in $patterns) {
        if ($content -match $pattern) {
            $violations += ($file.FullName + '  matched ' + $pattern)
        }
    }
}
if (@($violations).Count -gt 0) {
    Write-Host ''
    foreach ($v in $violations) { Write-Host ('  ' + $v) -ForegroundColor Red }
    Remove-Item $OutDir -Recurse -Force
    Fail 'credential material found in the package; output deleted'
}
Write-Ok 'no credential material'

# data\ must not exist at all in the shipped tree.
if (Test-Path (Join-Path $gatewayOut 'data')) {
    Remove-Item $OutDir -Recurse -Force
    Fail 'cb-gateway\data\ leaked into the package; output deleted'
}
Write-Ok 'no data\ directory'

# providers.json must contain the gateway provider's skeleton -- and nothing that
# belongs to THIS machine.
#
# v2 ships exactly one provider entry (the gateway's), keyed by whatever name the
# packaging machine gave it. That name is not predictable, so instead of a name
# whitelist we assert the *shape*: at least one entry, and no local-only keys.
# extract-providers.mjs is what strips them; this is the independent check that it
# actually did.
#
# Read it with .NET's UTF8 decoder, not Get-Content: PowerShell 5.1 decodes the
# default way (ANSI/GBK here), which turns the model names into bytes
# ConvertFrom-Json then rejects. That failure is loud, but the same bug in a place
# that only *displays* text would be silent.
$shipped = [System.IO.File]::ReadAllText($providersJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$shippedNames = @($shipped.PSObject.Properties.Name)
if ($shippedNames.Count -eq 0) {
    Remove-Item $OutDir -Recurse -Force
    Fail 'providers.json is empty; output deleted'
}
$localOnly = @('baseURL','apiKeyEnv','apiKey','models','headers')
foreach ($name in $shippedNames) {
    foreach ($prop in $shipped.$name.PSObject.Properties) {
        if ($localOnly -contains $prop.Name) {
            Remove-Item $OutDir -Recurse -Force
            Fail ("providers.json carries '" + $prop.Name + "' for '" + $name + "'; it belongs to the packaging machine and must be stripped; output deleted")
        }
    }
}
Write-Ok ("providers.json: " + ($shippedNames -join ', ') + " (local-only keys stripped)")

# ---------------------------------------------------------------- zip

if (-not $SkipZip) {
    Write-Step 'Creating the zip'
    $stamp = Get-Date -Format 'yyyyMMdd'
    $zipPath = Join-Path $DistRoot ("CreditBridgeForDSH-" + $version + "-" + $stamp + ".zip")
    Compress-Archive -Path $OutDir -DestinationPath $zipPath -CompressionLevel Optimal
    $size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Ok ($zipPath + "  " + $size + " KB")
}

Remove-Item $StageDir -Recurse -Force

Write-Host ''
Write-Host '  Package ready.' -ForegroundColor Green
Write-Host ("  " + $OutDir)
if (-not $SkipZip) { Write-Host ("  " + $zipPath) }
Write-Host ''
