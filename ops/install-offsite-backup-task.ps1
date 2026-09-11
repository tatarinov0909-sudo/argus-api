param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $config.scriptPath -PathType Leaf)) { throw 'Backup script not found' }
if (-not (Test-Path -LiteralPath $config.pythonWindowlessPath -PathType Leaf)) { throw 'Windowless Python not found' }
$arguments = '"' + $config.scriptPath + '" --config "' + $ConfigPath + '"'
# pythonw has no console; its SSH children use CREATE_NO_WINDOW as well.
$action = New-ScheduledTaskAction -Execute ([IO.Path]::GetFullPath($config.pythonWindowlessPath)) -Argument $arguments
$daily = New-ScheduledTaskTrigger -Daily -At '04:45'
$login = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Argus offsite database backup' -Action $action -Trigger @($daily, $login) -Principal $principal -Settings $settings -Description 'Verify and copy the latest Argus server DB backup to this PC; recovery configuration uses DPAPI CurrentUser.' -Force | Select-Object TaskName, State
