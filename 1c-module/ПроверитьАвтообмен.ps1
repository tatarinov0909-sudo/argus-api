# Read-only. Run on the 1C server under the account that starts the sync task.
# Action command lines, credentials, integration keys and old raw logs are never printed.
param(
    [string]$TaskName = '',
    [string]$LogPath = (Join-Path ([IO.Path]::GetTempPath()) 'argus_sync.log')
)

$ErrorActionPreference = 'Stop'
$taskRows = New-Object 'System.Collections.Generic.List[object]'
$taskService = New-Object -ComObject 'Schedule.Service'
$taskService.Connect()

function Add-TaskReport($task) {
    $instances = @('Parallel', 'Queue', 'IgnoreNew', 'StopExisting')
    $policy = [int]$task.Definition.Settings.MultipleInstances
    $taskRows.Add([pscustomobject]@{
        TaskName = [string]$task.Path
        Enabled = [bool]$task.Enabled
        State = @('Unknown', 'Disabled', 'Queued', 'Ready', 'Running')[[int]$task.State]
        LastRunTime = if ($task.LastRunTime.Year -gt 2000) { $task.LastRunTime.ToString('s') } else { $null }
        NextRunTime = if ($task.NextRunTime.Year -gt 2000) { $task.NextRunTime.ToString('s') } else { $null }
        LastTaskResult = ('0x{0:X8}' -f [uint32]$task.LastTaskResult)
        MultipleInstances = $instances[$policy]
        PreventsOverlap = ($policy -eq 2)
    })
}

function Find-ArgusTasks($folder) {
    foreach ($task in $folder.GetTasks(1)) {
        if ($task.Name -match '(?i)argus|аргус') { Add-TaskReport $task }
    }
    foreach ($child in $folder.GetFolders(0)) { Find-ArgusTasks $child }
}

$rootFolder = $taskService.GetFolder('\')
if ($TaskName) { Add-TaskReport ($rootFolder.GetTask($TaskName)) }
else { Find-ArgusTasks $rootFolder }

# A zero task exit code alone does not prove all records were accepted.
# Only module #12+ start/end summaries are included; legacy logs may contain secrets.
$safeEvents = @()
if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    $safeEvents = @(Get-Content -LiteralPath $LogPath -Tail 300 | Where-Object {
        $_ -match '\[\d{4}-\d{2}-\d{2} #(1[2-9]|[2-9]\d|\d{3,})\] (Запуск\. Режим: (automatic|manual)|Завершение автообмена\. Ошибок: \d+; секунд: [\d\s.,]+)$'
    } | Select-Object -Last 12)
}

[pscustomobject]@{
    CheckedAt = (Get-Date).ToString('s')
    Tasks = @($taskRows.ToArray())
    ModuleLogFound = (Test-Path -LiteralPath $LogPath -PathType Leaf)
    SafeModuleEvents = $safeEvents
    Interpretation = 'Confirm repeated automatic runs, a completion summary with zero errors, and fresh Argus stage timestamps. Task exit code zero is not enough.'
} | ConvertTo-Json -Depth 4
