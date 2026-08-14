@echo off
rem NewsApp - news service launcher (auto-start on Windows logon)
rem Exit if already running (avoid port conflict)
rem Watchdog: restart node 5s after abnormal exit

netstat -ano | findstr ":3001" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 exit /b 0

cd /d E:\reasonix\NewWorkSpace\newsAPP

:loop
node server/index.js >> logs\app.log 2>&1
echo [watchdog] %date% %time% node exited code=%errorlevel%, restart in 5s... >> logs\watchdog.log
timeout /t 5 /nobreak >nul
goto loop
