@echo off
setlocal
title SQLSM restart
cd /d "%~dp0"

set PORT=8000
if not "%SQLSM_PORT%"=="" set PORT=%SQLSM_PORT%

echo Stopping SQLSM on port %PORT%...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%PORT%" ^| findstr /C:"LISTENING"') do (
  echo   PID %%P
  taskkill /PID %%P /T /F >nul 2>&1
)

ping -n 2 127.0.0.1 >nul
echo Starting...
call start.bat
