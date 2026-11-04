@echo off
REM Stops the bridge (and its restart loop). WhatsApp login stays saved.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*start.bat*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Bridge stopped.
pause
