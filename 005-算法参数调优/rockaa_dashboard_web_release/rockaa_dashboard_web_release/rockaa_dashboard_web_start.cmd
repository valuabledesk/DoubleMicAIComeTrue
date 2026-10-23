@echo off
cd /d "%~dp0"
set ROCKAA_PLATFORMS=%~dp0platforms
if exist "%~dp0adb\adb.exe" set ROCKAA_ADB=%~dp0adb\adb.exe
if "%1"=="--foreground" (
  node bridge\adb-bridge.js --open %2 %3 %4 %5
  exit /b
)
echo Starting RockAA Dashboard in background ... Logs: rockaa_dashboard.log
start "RockAA Dashboard" /min cmd /c "node bridge\adb-bridge.js --open %* > rockaa_dashboard.log 2>&1"
