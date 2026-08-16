@echo off
setlocal
title SQL Server Management
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo Python tidak ditemukan.
  echo Install Python 3.8.10 dari https://www.python.org/downloads/release/python-3810/
  echo Centang "Add Python to PATH" saat install.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Membuat virtual environment...
  python -m venv .venv
  if errorlevel 1 (
    echo Gagal membuat virtual environment.
    pause
    exit /b 1
  )
  echo Menginstall dependensi...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements-windows.txt
  if errorlevel 1 (
    echo pyodbc gagal. Mencoba tanpa ODBC (SQL Authentication saja)...
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
      echo pip install gagal. Lihat README.
      pause
      exit /b 1
    )
  )
)

start "" "http://127.0.0.1:5050"
".venv\Scripts\python.exe" run.py
if errorlevel 1 pause
