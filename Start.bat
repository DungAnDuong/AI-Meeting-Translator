@echo off
setlocal EnableExtensions
chcp 65001 >nul
title AI Meeting Translator - Khoi dong
cd /d "%~dp0"

set "PORT=5555"
set "URL=http://localhost:%PORT%"
set "HEALTH=http://127.0.0.1:%PORT%/api/health"

rem ---- Whisper (Speech-to-Text chay local) ----
rem Doi model: ggml-small.bin (nhanh, mac dinh) hoac ggml-large-v3-turbo-q5_0.bin (chinh xac hon, cham hon)
set "WHISPER_PORT=8178"
set "WHISPER_MODEL=ggml-small.bin"
set "WHISPER_DIR=%~dp0tools\whisper.cpp"

rem ---- Kiem tra Node.js ----
where node >nul 2>&1
if errorlevel 1 (
  echo [LOI] Chua cai Node.js. Hay cai Node.js 22.13 tro len tu https://nodejs.org roi chay lai.
  pause
  exit /b 1
)

rem ---- Chay Whisper an (neu da cai va chua chay) ----
if not exist "logs\" mkdir "logs"
if exist "%WHISPER_DIR%\bin\whisper-server.exe" (
  netstat -ano | findstr /R /C:":%WHISPER_PORT% .*LISTENING" >nul
  if errorlevel 1 (
    echo Dang khoi dong Whisper ^(%WHISPER_MODEL%^) tai http://127.0.0.1:%WHISPER_PORT% ...
    powershell -NoProfile -Command "$p = Start-Process -FilePath '%WHISPER_DIR%\bin\whisper-server.exe' -ArgumentList '-m','models\%WHISPER_MODEL%','--host','127.0.0.1','--port','%WHISPER_PORT%','-l','auto','-t','6' -WorkingDirectory '%WHISPER_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%~dp0logs\whisper.log' -RedirectStandardError '%~dp0logs\whisper-error.log' -PassThru; Set-Content -Path '%~dp0logs\whisper.pid' -Value $p.Id"
  )
)

rem ---- Neu server da chay thi chi mo trinh duyet ----
call :probe
if not errorlevel 1 (
  echo Server dang chay san tai %URL%
  start "" "%URL%"
  exit /b 0
)

rem ---- Cai thu vien lan dau ----
if not exist "node_modules\tsx\" (
  echo Dang cai dat thu vien lan dau, vui long cho...
  call npm install
  if errorlevel 1 (
    echo [LOI] Cai dat thu vien that bai.
    pause
    exit /b 1
  )
)

rem ---- Build giao dien ----
echo Dang build giao dien...
call npm run build >nul
if errorlevel 1 (
  echo [LOI] Build giao dien that bai. Chay "npm run build" de xem chi tiet.
  pause
  exit /b 1
)

rem ---- Chay server an (khong hien cua so), ghi log vao thu muc logs ----
echo Dang khoi dong server tai %URL% ...
if not exist "logs\" mkdir "logs"
powershell -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList '--disable-warning=ExperimentalWarning','--import','tsx','src\index.ts' -WorkingDirectory '%~dp0server' -WindowStyle Hidden -RedirectStandardOutput '%~dp0logs\server.log' -RedirectStandardError '%~dp0logs\server-error.log' -PassThru; Set-Content -Path '%~dp0logs\server.pid' -Value $p.Id"
if errorlevel 1 (
  echo [LOI] Khong khoi dong duoc server.
  pause
  exit /b 1
)

rem ---- Cho server san sang (toi da ~60 giay) roi mo trinh duyet ----
set /a TRIES=0
:wait
call :probe
if not errorlevel 1 goto ready
set /a TRIES+=1
if %TRIES% geq 60 goto fail
ping -n 2 127.0.0.1 >nul
goto wait

:ready
echo Server da san sang. Dang mo trinh duyet...
start "" "%URL%"
exit /b 0

:fail
echo [LOI] Server khong khoi dong duoc sau 60 giay. Chi tiet loi:
echo ------------------------------------------------------------
powershell -NoProfile -Command "Get-Content '%~dp0logs\server-error.log','%~dp0logs\server.log' -Tail 20 -ErrorAction SilentlyContinue"
echo ------------------------------------------------------------
echo Log day du: %~dp0logscall "%~dp0Stop.bat" >nul
pause
exit /b 1

rem ---- Kiem tra server: errorlevel 0 = dang chay ----
:probe
where curl.exe >nul 2>&1
if errorlevel 1 goto probe_ps
curl.exe -s -f -m 3 "%HEALTH%" >nul 2>&1
exit /b %errorlevel%
:probe_ps
powershell -NoProfile -Command "[System.Net.WebRequest]::DefaultWebProxy=$null; try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 '%HEALTH%' | Out-Null; exit 0 } catch { exit 1 }"
exit /b %errorlevel%
