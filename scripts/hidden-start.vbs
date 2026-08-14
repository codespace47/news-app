' 今日要闻 - 隐藏窗口启动器 (任务计划程序指向此脚本, 避免弹出黑色 cmd 窗口)
Set sh = CreateObject("WScript.Shell")
sh.Run """E:\reasonix\NewWorkSpace\newsAPP\scripts\start-server.bat""", 0, False
