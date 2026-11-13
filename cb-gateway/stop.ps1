$conn = Get-NetTCPConnection -LocalPort 7801 -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
  Write-Output "gateway not running"
  exit 0
}
$procId = $conn.OwningProcess | Select-Object -First 1
Stop-Process -Id $procId -Force
Write-Output "gateway stopped (pid $procId)"
