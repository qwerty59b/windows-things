# Run PowerShell as Administrator (required for Set-MpPreference)

# Check the current CPU load factor setting
$currentLoadFactor = Get-MpPreference | Select-Object -ExpandProperty ScanAvgCPULoadFactor
Write-Host "Current CPU Load Factor: $currentLoadFactor%"

# Set a new CPU usage limit (e.g., 30%)
$newLimit = 10  # Change this value as needed (between 5 and 100)
Set-MpPreference -ScanAvgCPULoadFactor $newLimit

# Verify the change
$updatedLoadFactor = Get-MpPreference | Select-Object -ExpandProperty ScanAvgCPULoadFactor
Write-Host "Updated CPU Load Factor: $updatedLoadFactor%"