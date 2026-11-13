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

$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$settings.ExecutionTimeLimit = 'PT0S'

Register-ScheduledTask -TaskName 'AgentGateway' -Action $action -Trigger $trigger -Settings $settings -Description 'Local OpenAI-compatible gateway for AI desktop clients (DSH provider)' -Force | Out-Null
Write-Output 'task AgentGateway registered'
