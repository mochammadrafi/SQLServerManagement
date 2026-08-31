@echo off
setlocal
title SQLSM restart
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 x64 is required for Windows Server 2012 R2.
  echo Download: https://nodejs.org/dist/v18.20.8/node-v18.20.8-x64.msi
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%A in ('node -p "process.versions.node"') do set NODE_MAJOR=%%A
if not "%NODE_MAJOR%"=="18" (
  echo This app targets Node.js 18. Found:
  node -v
  echo Install Node 18 x64: https://nodejs.org/dist/v18.20.8/node-v18.20.8-x64.msi
  pause
  exit /b 1
)

set PORT=8000
if not "%SQLSM_PORT%"=="" set PORT=%SQLSM_PORT%

echo Stopping SQLSM on port %PORT%...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%PORT%" ^| findstr /C:"LISTENING"') do (
  echo   PID %%P
  taskkill /PID %%P /T /F >nul 2>&1
)
ping -n 2 127.0.0.1 >nul

echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo Building UI...
call npm run build -w web
if errorlevel 1 (
  echo UI build failed.
  pause
  exit /b 1
)

if not exist "%USERPROFILE%\.sqlsm" mkdir "%USERPROFILE%\.sqlsm"
echo Starting...
start "" "http://127.0.0.1:%PORT%"

:run
echo [%DATE% %TIME%] starting SQLSM
call npm start
set EXITCODE=%ERRORLEVEL%
echo [%DATE% %TIME%] SQLSM exited with code %EXITCODE%
>> "%USERPROFILE%\.sqlsm\server.log" echo [%DATE% %TIME%] npm start exited %EXITCODE%
echo Restarting in 5 seconds. Close this window or press Ctrl+C to stop.
ping -n 6 127.0.0.1 >nul
goto run
