# 注册「今日要闻」新闻服务为开机自启任务 (登录时运行, 无需管理员权限)
$ErrorActionPreference = 'Stop'
$vbs = 'E:\reasonix\NewWorkSpace\newsAPP\scripts\hidden-start.vbs'

try {
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName 'NewsApp' -Action $action -Trigger $trigger -Description '今日要闻新闻聚合服务 (端口 3001)' -Force | Out-Null
    Write-Output 'scheduled-task-ok'
} catch {
    Write-Output "scheduled-task-failed: $($_.Exception.Message)"
    exit 1
}
