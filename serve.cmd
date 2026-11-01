@echo off
rem ---- MyPlayer : start the local server (PC + phones on the same Wi-Fi) ----
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")

if not defined PY (
  echo Python was not found, so the app will open as a local file.
  echo Install Python to use it from your phone.
  start "" "index.html"
  exit /b 0
)

%PY% serve.py %1
echo.
pause
