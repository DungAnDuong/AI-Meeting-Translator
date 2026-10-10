@echo off
setlocal EnableExtensions
chcp 65001 >nul
title AI Meeting Translator - Dung server
cd /d "%~dp0"
set "PORT=5555"

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  if not "%%P"=="0" (
    set "FOUND=1"
    echo Dang dung server ^(PID %%P^) tren port %PORT%...
    taskkill /PID %%P /T /F >nul 2>&1
  )
)

rem Tat tien trinh server da ghi trong logs\server.pid (neu con)
if exist "logs\server.pid" (
  for /f "usebackq delims=" %%I in ("logs\server.pid") do (
    tasklist /FI "PID eq %%I" /FI "IMAGENAME eq node.exe" 2>nul | findstr /I "node.exe" >nul && (
      set "FOUND=1"
      taskkill /PID %%I /T /F >nul 2>&1
    )
  )
  del "logs\server.pid" >nul 2>&1
)

rem ---- Dung Whisper (port 8178) ----
set "WFOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8178 .*LISTENING"') do (
  if not "%%P"=="0" (
    set "WFOUND=1"
    taskkill /PID %%P /T /F >nul 2>&1
  )
)
if exist "logs\whisper.pid" (
  for /f "usebackq delims=" %%I in ("logs\whisper.pid") do (
    tasklist /FI "PID eq %%I" /FI "IMAGENAME eq whisper-server.exe" 2>nul | findstr /I "whisper-server.exe" >nul && (
      set "WFOUND=1"
      taskkill /PID %%I /T /F >nul 2>&1
    )
  )
  del "logs\whisper.pid" >nul 2>&1
)
if defined WFOUND echo Da dung Whisper.

if defined FOUND (
  echo Da dung server AI Meeting Translator.
) else (
  echo Khong co server nao dang chay tren port %PORT%.
)
ping -n 3 127.0.0.1 >nul
exit /b 0
