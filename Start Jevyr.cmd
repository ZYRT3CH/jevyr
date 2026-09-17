@echo off
setlocal
rem Run from the application folder even when opened from Explorer or another drive.
pushd "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Jevyr needs Node.js 24 or newer. Install it, then open this launcher again.
  pause
  popd
  exit /b 1
)
where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  echo Jevyr needs pnpm. Run corepack enable after installing Node.js.
  pause
  popd
  exit /b 1
)
if not exist "node_modules" (
  echo First-time setup: run pnpm install and pnpm build in this folder.
  pause
  popd
  exit /b 1
)
call pnpm.cmd jevyr up %*
set "jevyr_exit=%errorlevel%"
if not "%jevyr_exit%"=="0" pause
popd
exit /b %jevyr_exit%
