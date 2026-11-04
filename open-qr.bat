@echo off
cd /d "%~dp0"
for /f "usebackq delims=" %%K in (`powershell -NoProfile -Command "(Get-Content config.json -Raw | ConvertFrom-Json).API_KEY"`) do set "KEY=%%K"
start "" "http://localhost:3000/qr?key=%KEY%"
