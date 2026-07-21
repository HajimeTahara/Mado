@echo off
setlocal

set "ROOT_DIR=%~dp0"
set "APP_DIR=%ROOT_DIR%app"

if not exist "%APP_DIR%\package.json" (
  echo [Mado] app\package.json was not found.
  echo [Mado] Run this bat from the repository root.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [Mado] npm was not found. Install Node.js and try again.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [Mado] cargo was not found. Install Rust and try again.
  pause
  exit /b 1
)

pushd "%APP_DIR%"

if /i "%~1"=="--check" (
  echo [Mado] Running startup check...
  call npm --version
  if errorlevel 1 goto :fail
  call cargo --version
  if errorlevel 1 goto :fail
  if not exist "node_modules" (
    echo [Mado] node_modules is missing. Normal startup will run npm install.
  ) else (
    echo [Mado] node_modules exists at app\node_modules.
  )
  echo [Mado] OK
  popd
  exit /b 0
)

if not exist "node_modules" (
  echo [Mado] app\node_modules is missing. Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

echo [Mado] Starting desktop app...
echo [Mado] Press Ctrl+C in this window to stop.
call npm run dev
if errorlevel 1 goto :fail

popd
exit /b 0

:fail
set "EXIT_CODE=%ERRORLEVEL%"
popd
echo [Mado] Startup failed. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
