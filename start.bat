@echo off
setlocal
title Support Bridge
cd /d "%~dp0"

REM ---------- first run: create config.json ----------
if not exist config.json (
  copy config.example.json config.json >nul
  echo First run. config.json will open now.
  echo Fill APPS_SCRIPT_URL and API_KEY, save the file, then run start.bat again.
  notepad config.json
  exit /b
)

REM ---------- Node.js check ----------
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and run start.bat again.
  pause
  exit /b
)

REM ---------- packages (first run only) ----------
if not exist node_modules (
  echo Installing packages. This takes a few minutes the first time...
  call npm install --no-audit --no-fund
)

REM ---------- ngrok (optional, starts only if installed) ----------
set "NGROK="
where ngrok >nul 2>nul && set "NGROK=ngrok"
if exist "%~dp0ngrok.exe" set "NGROK=%~dp0ngrok.exe"
if not defined NGROK goto runbridge
tasklist /fi "imagename eq ngrok.exe" 2>nul | find /i "ngrok.exe" >nul && goto runbridge
set "DOMAINARG="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "try{$d=(Get-Content config.json -Raw | ConvertFrom-Json).NGROK_DOMAIN; if($d){$d}}catch{}"`) do set "DOMAINARG=--domain=%%D"
start "ngrok" /min "%NGROK%" http %DOMAINARG% 3000
ping -n 5 127.0.0.1 >nul

:runbridge
:loop
echo [%date% %time%] Starting bridge...
node server.js
if errorlevel 3 (
  echo The bridge is already running. Nothing to do.
  exit /b
)
if errorlevel 2 (
  echo config.json is not filled correctly. Fix it and run start.bat again.
  pause
  exit /b
)
echo [%date% %time%] Bridge stopped. Restarting in 5 seconds...
ping -n 6 127.0.0.1 >nul
goto loop
