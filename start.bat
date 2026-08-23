@echo off
setlocal
title SQL Server Management
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 x64 is required for Windows Server 2012 R2.
  echo Download: https://nodejs.org/dist/v18.20.8/node-v18.20.8-x64.msi
  echo Node 18.0.0+ also works. Node 20+ does not support this OS.
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

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist "web\dist" (
  call npm run build -w web
)

start "" "http://127.0.0.1:8000"
call npm start
if errorlevel 1 pause
