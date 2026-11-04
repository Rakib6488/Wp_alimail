@echo off
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SupportBridge.lnk"
if exist "%LNK%" del "%LNK%"
echo Auto-start removed. The bridge will no longer start with Windows.
pause
