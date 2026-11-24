#Requires -Version 5.1
<#
.SYNOPSIS
    Builds the distributable zip. Double-click, or run from anywhere.

.DESCRIPTION
    Thin wrapper around packaging\build.ps1 so the entry point lives where you
    look: the project root. Produces dist\CreditBridgeForDSH-<version>-<date>.zip,
    ready to send to someone.

    The build refuses to emit a package containing credentials and aborts if
    anything token-shaped is found.
#>
[CmdletBinding()]
param(
    [switch]$FolderOnly   # build the folder but skip zipping
)

$ErrorActionPreference = 'Stop'
$buildScript = Join-Path $PSScriptRoot 'packaging\build.ps1'

if (-not (Test-Path $buildScript)) {
    Write-Host ("ERROR  build script missing: " + $buildScript) -ForegroundColor Red
    exit 1
}

$args = @()
if ($FolderOnly) { $args += '-SkipZip' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $buildScript @args
exit $LASTEXITCODE
