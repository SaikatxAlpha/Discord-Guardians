# Optional: start Soul Society automatically when you log in to Windows
# (creates a per-user Scheduled Task; no admin rights needed).
# Remove with:  Unregister-ScheduledTask -TaskName 'SoulSociety' -Confirm:$false
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c cd /d `"$root`" && (if not exist data\logs mkdir data\logs) && npm start >> data\logs\launcher.out 2>&1" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'SoulSociety' -Action $action -Trigger $trigger -Settings $settings -Description 'KNIGHT + AEGIS Discord guardians' -Force | Out-Null
Write-Host "Registered scheduled task 'SoulSociety' (runs at logon)."
