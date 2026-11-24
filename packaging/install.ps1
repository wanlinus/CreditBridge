#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot installer for CreditBridge: the local gateway plus its DSH panel.

.DESCRIPTION
    Installs three things, in this order:

      1. The gateway into %LOCALAPPDATA%\CreditBridge\gateway and starts it.
      2. The DSH plugin into the desktop profile, via the bundled pnpm.
      3. The gateway provider skeleton into the profile's
         cordis.patch.yml, so DSH actually points at the gateway.

    Nothing here ships credentials. data\ is created fresh on your machine; you
    sign in once per channel from the 积分桥 panel afterwards.

.PARAMETER Uninstall
    Remove the gateway directory, unregister the plugin, and drop the providers.

.PARAMETER SkipPlugin
    Install only the gateway (useful if you want to point another OpenAI client
    at it).

.NOTES
    Requires: Windows and DSH installed at least once (the installer borrows
    DSH's bundled Node and pnpm, so Node does not need to be on PATH).

    A desktop client (WorkBuddy / Trae) is NOT required. Sign in through the
    panel after installing.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$SkipPlugin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------- presentation

$script:StepNo = 0
function Write-Step([string]$Text) {
    $script:StepNo++
    Write-Host ""
    Write-Host ("[{0}] {1}" -f $script:StepNo, $Text) -ForegroundColor Cyan
}
function Write-Ok([string]$Text)   { Write-Host ("    OK   " + $Text) -ForegroundColor Green }
function Write-Warn2([string]$Text){ Write-Host ("    WARN " + $Text) -ForegroundColor Yellow }
function Write-Info([string]$Text) { Write-Host ("         " + $Text) -ForegroundColor DarkGray }
function Fail([string]$Text) {
    Write-Host ""
    Write-Host ("ERROR  " + $Text) -ForegroundColor Red
    exit 1
}

# Reads a UTF-8 file. Get-Content decodes as ANSI/GBK under PowerShell 5.1, which
# mangles non-ASCII content and makes ConvertFrom-Json throw on a file that is
# actually valid JSON. Anything that parses or rewrites a config file uses this.
function Read-Utf8([string]$Path) {
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

<#
Key-presence test that survives StrictMode.

`$obj.PSObject.Properties.Name` is the natural way to enumerate keys, but on an
object built by ConvertFrom-Json from `{}` it throws "The property 'Name' cannot
be found" instead of returning nothing. Iterating the properties avoids the
.Name lookup entirely. Callers that edit JSON use this instead.
#>
function Test-HasKey($obj, [string]$key) {
    if ($null -eq $obj) { return $false }
    foreach ($prop in $obj.PSObject.Properties) {
        if ($prop.Name -eq $key) { return $true }
    }
    return $false
}

# ------------------------------------------------------------------- locations

$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$GatewaySrc  = Join-Path $PackageRoot 'cb-gateway'
$PluginSrc   = Join-Path $PackageRoot 'cb-dsh'
$MergeScript = Join-Path $PackageRoot 'merge-providers.mjs'
$ProvidersJson = Join-Path $PackageRoot 'providers.json'

# The tarball name carries the plugin version, so resolve it instead of pinning a
# literal: a hardcoded 0.2.1 shipped alongside a 0.4.2 tarball once, and the
# install failed with "plugin package missing" pointing at a file nobody built.
$TarballSrc = Get-ChildItem $PackageRoot -Filter 'cb-dsh-*.tgz' -File |
    Select-Object -First 1

$InstallRoot = Join-Path $env:LOCALAPPDATA 'CreditBridge'
$GatewayDst  = Join-Path $InstallRoot 'gateway'

$DshRoot     = Join-Path $env:USERPROFILE '.dsh'
$ProfileDir  = Join-Path $DshRoot 'profiles\desktop'
$ProfilePkg  = Join-Path $ProfileDir 'package.json'
$ProfileLock = Join-Path $ProfileDir 'pnpm-lock.yaml'
$ProfilePatch = Join-Path $ProfileDir 'cordis.patch.yml'

$PluginId    = 'cb-dsh'

Write-Host ""
Write-Host "  CreditBridge - installer" -ForegroundColor White
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray

# ------------------------------------------------------------- toolchain probe

<#
DSH ships its own Node and pnpm under ~/.dsh/dsh-runtimes/<name>/dependencies.
Preferring those means the user needs no Node install and the version matches
what DSH runs the plugin with. But the runtime directory name is not stable
across DSH versions, and some installs may not bundle one at all — so fall back
to a system Node/pnpm rather than refusing to install.
#>
function Find-DshToolchain {
    $runtimes = Join-Path $DshRoot 'dsh-runtimes'
    if (Test-Path $runtimes) {
        foreach ($runtime in Get-ChildItem $runtimes -Directory -ErrorAction SilentlyContinue) {
            $deps = Join-Path $runtime.FullName 'dependencies'
            $node = Join-Path $deps 'node\bin\node.exe'
            $pnpm = Join-Path $deps 'pnpm\bin\pnpm.cjs'
            if ((Test-Path $node) -and (Test-Path $pnpm)) {
                return [pscustomobject]@{ Node = $node; Pnpm = $pnpm; Runtime = $runtime.Name; Source = 'dsh' }
            }
        }
    }

    # Fall back to a system install. pnpm is often a .ps1 shim under npm's global
    # prefix, so resolve the real .cjs next to it rather than invoking a script.
    $sysNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $sysNode) { return $null }

    $pnpmCandidates = @(
        (Join-Path $env:APPDATA 'npm\node_modules\pnpm\bin\pnpm.cjs'),
        (Join-Path $ProfileDir 'node_modules\pnpm\bin\pnpm.cjs')
    )
    foreach ($candidate in $pnpmCandidates) {
        if (Test-Path $candidate) {
            return [pscustomobject]@{ Node = $sysNode; Pnpm = $candidate; Runtime = 'system'; Source = 'system' }
        }
    }
    return $null
}

# ---------------------------------------------------------------- uninstall

if ($Uninstall) {
    Write-Step 'Removing the plugin from the DSH profile'
    if (Test-Path $ProfilePkg) {
        $toolchain = Find-DshToolchain
        try {
            $pkg = Read-Utf8 $ProfilePkg | ConvertFrom-Json
            if (Test-HasKey $pkg 'dependencies' -and (Test-HasKey $pkg.dependencies $PluginId)) {
                $pkg.dependencies.PSObject.Properties.Remove($PluginId)
            }
            if ((Test-HasKey $pkg 'dsh') -and (Test-HasKey $pkg.dsh 'profile') -and $pkg.dsh.profile.bundles) {
                $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $PluginId })
            }
            $pkg | ConvertTo-Json -Depth 12 | Set-Content $ProfilePkg -Encoding UTF8
            Write-Ok 'profile package.json updated'
        } catch {
            Write-Warn2 ("could not edit profile package.json: " + $_.Exception.Message)
        }

        # The lockfile pins the tarball by integrity; a stale entry makes the
        # next install fail with ERR_PNPM_TARBALL_INTEGRITY.
        if (Test-Path $ProfileLock) { Remove-Item $ProfileLock -Force; Write-Ok 'stale lockfile removed' }

        if ($toolchain) {
            Write-Info 'running pnpm install to drop the package'
            & $toolchain.Node $toolchain.Pnpm install --dir $ProfileDir 2>&1 | Out-Null
        }
    } else {
        Write-Warn2 'no DSH desktop profile found; nothing to unregister'
    }

    Write-Step 'Stopping and removing the gateway'
    $listening = Get-NetTCPConnection -LocalPort 7801 -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
        # Only kill a process that is actually running from the folder we are
        # about to delete. An unconditional Stop-Process here would take out
        # whatever else happened to hold 7801 — including a gateway the user
        # installed elsewhere and wants to keep.
        $ownerCmd = ''
        try {
            $ownerCmd = [string](Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listening.OwningProcess)).CommandLine
        } catch { }
        $isOurs = $ownerCmd -and ($ownerCmd -match [regex]::Escape($InstallRoot))
        if ($isOurs) {
            Stop-Process -Id $listening.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-Ok 'gateway stopped'
        } else {
            Write-Warn2 'port 7801 is held by something else; left it alone'
            Write-Info ('pid ' + $listening.OwningProcess + ': ' + $ownerCmd)
        }
    }
    if (Test-Path $InstallRoot) {
        Remove-Item $InstallRoot -Recurse -Force
        Write-Ok ("removed " + $InstallRoot)
    }

    Write-Info 'the gateway provider entry is left in cordis.patch.yml'
    Write-Info ('remove them by hand if you want them gone: ' + $ProfilePatch)

    Write-Host ""
    Write-Host "  Uninstalled. Restart DSH to drop the plugin from the UI." -ForegroundColor White
    Write-Host ""
    exit 0
}

# --------------------------------------------------------------- preflight

Write-Step 'Checking what is already installed'

if (-not (Test-Path $DshRoot)) {
    Fail ("DSH has never run on this machine (no " + $DshRoot + "). Start DSH once, quit it, then re-run this script.")
}
if (-not (Test-Path $ProfileDir)) {
    Fail ("DSH desktop profile not found at " + $ProfileDir + ". Start DSH once and quit it first.")
}
Write-Ok 'DSH profile found'

$toolchain = Find-DshToolchain
if (-not $toolchain) {
    Write-Warn2 'No usable Node + pnpm found'
    Write-Info 'Looked in: ~\.dsh\dsh-runtimes\*\dependencies (DSH bundled)'
    Write-Info '           node.exe on PATH, %APPDATA%\npm\node_modules\pnpm'
    Fail 'Install Node.js 22+ (which includes npm), then run: npm i -g pnpm. Re-run this script after that.'
}
Write-Ok ("node: " + $toolchain.Node)
Write-Ok ("toolchain: " + $toolchain.Runtime + " (" + $toolchain.Source + ")")

if (-not (Test-Path $MergeScript)) { Fail ("merge-providers.mjs missing: " + $MergeScript) }
if (-not (Test-Path $ProvidersJson)) { Fail ("providers.json missing: " + $ProvidersJson) }

# ------------------------------------------------------------ gateway install

Write-Step 'Installing the gateway'

if (-not (Test-Path $GatewaySrc)) { Fail ("gateway sources missing: " + $GatewaySrc) }

if (Test-Path $GatewayDst) {
    Write-Info 'existing gateway found; preserving data\ (credentials and usage ledger)'
    # Replace code only. data\ holds this user's tokens, device ids and history
    # and must survive an upgrade.
    Get-ChildItem $GatewayDst -Force |
        Where-Object { $_.Name -ne 'data' } |
        Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $GatewayDst -Force | Out-Null
}

foreach ($item in Get-ChildItem $GatewaySrc -Force) {
    if ($item.Name -eq 'data') { continue }
    Copy-Item $item.FullName -Destination $GatewayDst -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $GatewayDst 'data') -Force | Out-Null
Write-Ok ("installed to " + $GatewayDst)

# The gateway ships without data\config.json (it is gitignored), so write a fresh
# one. Client version strings do NOT live here: each channel declares its own
# `identity` (see src/config.ts), so the global defaults are host / port /
# context-window / max-tokens / verbose only.
$configPath = Join-Path $GatewayDst 'data\config.json'
if (-not (Test-Path $configPath)) {
    $config = [ordered]@{
        host                 = '127.0.0.1'
        port                 = 7801
        defaultContextWindow = 200000
        defaultMaxTokens     = 32768
        verbose              = $false
    }
    $config | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    Write-Ok 'wrote data\config.json'
} else {
    Write-Ok 'kept existing data\config.json'
}

# ------------------------------------------------------------------ plugin

if ($SkipPlugin) {
    Write-Step 'Skipping the DSH plugin (-SkipPlugin)'
} else {
    Write-Step 'Installing the DSH plugin'

    if (-not $TarballSrc) {
        Fail ("no cb-dsh-*.tgz at " + $PackageRoot)
    }
    Write-Info $TarballSrc.Name

    # Register the dependency and add it to the bundle list. Both are required:
    # `bundles` is what DSH actually loads, `dependencies` is what pnpm installs.
    $backup = $ProfilePkg + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item $ProfilePkg $backup -Force

    # Editing the profile package.json is deceptively fiddly under StrictMode:
    # ConvertFrom-Json turns an empty `{}` into a PSCustomObject whose
    # PSObject.Properties.Name throws "The property 'Name' cannot be found"
    # instead of returning an empty list. So test for key presence with
    # Test-HasKey (defined at the top of this script), and always write keys back
    # with Add-Member, which is happy on an empty object.
    $pkg = Read-Utf8 $ProfilePkg | ConvertFrom-Json
    $spec = 'file:' + ($TarballSrc.FullName -replace '\\', '/')

    if (-not (Test-HasKey $pkg 'dependencies') -or $null -eq $pkg.dependencies) {
        $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if (Test-HasKey $pkg.dependencies $PluginId) {
        $pkg.dependencies.$PluginId = $spec
    } else {
        $pkg.dependencies | Add-Member -NotePropertyName $PluginId -NotePropertyValue $spec -Force
    }

    if (-not (Test-HasKey $pkg 'dsh') -or -not (Test-HasKey $pkg.dsh 'profile') -or -not (Test-HasKey $pkg.dsh.profile 'bundles')) {
        Fail 'profile package.json has no dsh.profile.bundles; this DSH version may be incompatible.'
    }
    $bundles = @($pkg.dsh.profile.bundles)
    if ($bundles -notcontains $PluginId) {
        $bundles += $PluginId
    }
    $pkg.dsh.profile.bundles = $bundles

    $pkg | ConvertTo-Json -Depth 12 | Set-Content $ProfilePkg -Encoding UTF8
    Write-Ok 'registered in profile package.json'

    # A stale lock entry pins the OLD tarball's integrity hash, which makes any
    # new file: spec fail with ERR_PNPM_TARBALL_INTEGRITY. Deleting it forces a
    # re-resolve.
    if (Test-Path $ProfileLock) {
        Remove-Item $ProfileLock -Force
        Write-Ok 'removed stale lockfile'
    }

    Write-Info 'running pnpm install (this can take a minute)'
    Push-Location $ProfileDir
    try {
        $output = & $toolchain.Node $toolchain.Pnpm install --dir $ProfileDir 2>&1
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Copy-Item $backup $ProfilePkg -Force
        Write-Host ($output | Out-String) -ForegroundColor DarkGray
        Fail ("pnpm install failed (exit " + $code + "); profile package.json restored")
    }

    $installed = Join-Path $ProfileDir ("node_modules\" + $PluginId + "\lib\client.js")
    if (-not (Test-Path $installed)) {
        Copy-Item $backup $ProfilePkg -Force
        Fail 'pnpm reported success but the plugin is not on disk; profile restored'
    }
    Write-Ok 'plugin installed'

    # ------------------------------------------------------ provider config

    <#
    The plugin gives you the badge; the provider entry is what makes DSH route a
    model to this gateway. It has to be merged into the profile's patch file,
    because that is the only layer DSH reads for provider settings.

    merge-providers.mjs merges instead of overwriting: anything already in the
    file (other providers, theme, permission presets) is preserved, and only the
    gateway provider key is touched. It also keeps any baseURL / apiKeyEnv /
    models you already filled in -- the shipped skeleton deliberately carries
    none of those. Re-running it is a no-op.
    #>
    Write-Step 'Registering the gateway as a DSH provider'

    if (-not (Test-Path $ProfilePatch)) {
        Write-Info 'no cordis.patch.yml yet; the helper will create one'
    }
    & $toolchain.Node $MergeScript $ProfilePatch $ProvidersJson
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 'provider merge failed - you can add the provider by hand'
        Write-Info ('see ' + $ProvidersJson + ' and ' + $ProfilePatch)
    } else {
        Write-Ok 'gateway provider registered (baseURL / key to be filled in the 积分桥 panel)'
    }
}

# ------------------------------------------------------------- start gateway

Write-Step 'Starting the gateway'

<#
Port 7801 may already be served by an older copy of this gateway — started
manually, or launched by DSH. Two things must be true before replacing it:

  1. It really is this gateway. v2 deleted `/health` (it now 404s) and
     `/api/health` requires a login, so the only public liveness probe is
     `/login`: it answers 200 with the gateway's own page only on our
     gateway. Never kill a stranger.
  2. DSH is not managing it. If the running process carries --parent-pid, DSH
     owns its lifecycle and would simply respawn the OLD code the moment we
     killed it, leaving the user with a "successful" install that changed
     nothing.

So: kill only a manual instance, and refuse with an actionable message when DSH
is the owner.
#>
$listening = Get-NetTCPConnection -LocalPort 7801 -State Listen -ErrorAction SilentlyContinue
$reuseExisting = $false
if ($listening) {
    # 判「是不是我们的网关」：探公开的 `/login`，200 且页面里带「网关」才算。
    $isOurs = $false
    try {
        $probe = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:7801/login' -TimeoutSec 3
        $isOurs = ($probe.StatusCode -eq 200) -and ($probe.Content -match '网关')
    } catch { $isOurs = $false }
    if (-not $isOurs) {
        Fail 'Port 7801 is in use by another program. Stop it, then re-run this script.'
    }

    $ownerCmd = ''
    try {
        $ownerCmd = [string](Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listening.OwningProcess)).CommandLine
    } catch { }

    $dshManaged = $ownerCmd -match '--parent-pid='
    $runsFromUs = $ownerCmd -match [regex]::Escape($GatewayDst)

    if ($dshManaged) {
        # DSH will restart it, and it will restart whatever path its plugin
        # points at — which is this same directory, but the code already loaded
        # is the pre-upgrade copy. Only a DSH restart clears that.
        Write-Warn2 'DSH is currently running this gateway'
        $reuseExisting = $true
    } elseif ($runsFromUs) {
        Write-Info 'stopping the previous gateway to load the new code'
        Stop-Process -Id $listening.OwningProcess -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 250
            if (-not (Get-NetTCPConnection -LocalPort 7801 -State Listen -ErrorAction SilentlyContinue)) { break }
        }
    } else {
        Write-Info 'another instance of this gateway is running from a different folder; leaving it alone'
        $reuseExisting = $true
    }
}

$gatewayEntry = Join-Path $GatewayDst 'src\index.ts'

if ($reuseExisting) {
    Write-Info 'not spawning a second instance; the running one is left in place'
} else {
    # Spawn detached so it survives this installer window closing, exactly as
    # DSH will later spawn it.
    Start-Process -FilePath $toolchain.Node `
        -ArgumentList @($gatewayEntry) `
        -WorkingDirectory $GatewayDst `
        -WindowStyle Hidden
}

# 等网关起来。同样探公开的 `/login`：`/api/health` 要登录，而这一步还没建
# key、也没改密，拿不到凭据，所以不能拿它判活。这里不读通道状态——那要凭据。
$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $probe = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:7801/login' -TimeoutSec 2
        if ($probe.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
}

if (-not $healthy) {
    Write-Warn2 'gateway did not answer on 7801 within 20s'
    Write-Info ('check the log: ' + (Join-Path $GatewayDst 'data\logs'))
} else {
    Write-Ok 'gateway up (login page answered)'
}

# ------------------------------------------------------------------- summary

Write-Host ""
Write-Host "  Done." -ForegroundColor Green
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray
Write-Host ("  gateway : " + $GatewayDst)
Write-Host ("  data    : " + (Join-Path $GatewayDst 'data'))
Write-Host  "  panel   : http://127.0.0.1:7801/"

if ($reuseExisting) {
    # Be explicit: in this branch the health check above answered from the
    # already-running instance, so it proves nothing about the copy just
    # installed. Saying "OK" here without that caveat would be a lie.
    Write-Host ""
    Write-Host "  NOTE  A gateway was already running, so it was left in place." -ForegroundColor Yellow
    Write-Host "        The health check above describes THAT instance, not the copy" -ForegroundColor Yellow
    Write-Host "        just installed. To load the new code, restart DSH." -ForegroundColor Yellow
}

if (-not $SkipPlugin) {
    Write-Host ""
    Write-Host "  NEXT  Restart DSH so it loads the plugin and the provider." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Then do the three one-time steps:" -ForegroundColor White
    Write-Host "    1. Open http://127.0.0.1:7801/login and change the default"
    Write-Host "       admin/admin password (everything is refused until you do)."
    Write-Host "    2. Go to /keys and create an API key (sk-...). Copy it now."
    Write-Host "    3. In DSH, open the 积分桥 panel and save the gateway address"
    Write-Host "       plus that key. The plugin writes the provider and syncs models."
    Write-Host ""
    Write-Host "  Accounts are added on the GATEWAY web page (/accounts), not in the"
    Write-Host "  panel -- one browser sign-in per account, per channel."
    Write-Host ""
    Write-Host "  The DSH profile references this package by its current path. If you"
    Write-Host "  delete or move the package folder later, run this installer again."
} else {
    Write-Host ""
    Write-Host "  Point any OpenAI-compatible client at:" -ForegroundColor White
    Write-Host "    http://127.0.0.1:7801/v1"
    Write-Host "  (Bearer key from /keys; there are no per-channel routes in v2.)"
}
Write-Host ""
