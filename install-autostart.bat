@echo off
cd /d "%~dp0"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SupportBridge.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%'); $s.TargetPath='%~dp0start-hidden.vbs'; $s.WorkingDirectory='%~dp0'; $s.Save()"
if exist "%LNK%" (
  echo Done. The bridge will now start by itself every time you sign in to Windows.
  echo It runs hidden in the background. Use open-qr.bat to see the WhatsApp QR page.
) else (
  echo Could not create the startup shortcut.
)
pause
