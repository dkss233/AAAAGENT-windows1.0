@echo off
rem ASCII-only on purpose. cmd.exe parses this file with the console code page that is active when it
rem starts reading, and `chcp 65001` below cannot retroactively fix lines it already mis-decoded. On a
rem 936 (GBK) console UTF-8 Chinese here was decoded as garbage, executed as a command, and left the
rem script exiting 1 before the pet ever started. All user-facing Chinese lives in
rem setup-windows.ps1 and the Node scripts, which write UTF-8 themselves. Keep every byte ASCII.
chcp 65001 >nul
setlocal
title AAAAGENT
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "APP=%ROOT%\code\desktop-pet"
if exist "%APP%\node_modules" if exist "%APP%\dist\app\trial-launcher.js" if exist "%APP%\desktop\build\renderer.js" goto launch

echo   Preparing this build (first run, or after an update).
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\setup-windows.ps1" -PrepareOnly
if errorlevel 1 (
  echo.
  echo   [ERROR] Setup did not complete. Read the messages above, then run this file again.
  echo.
  pause
  exit /b 1
)

:launch
where node.exe >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] node.exe was not found. Install Node.js 22.12+ and add it to PATH.
  echo.
  pause
  exit /b 1
)
node "%ROOT%\tools\aaaagent-start.mjs"
if errorlevel 1 (
  echo.
  echo   [ERROR] Startup did not complete. Send the messages above to your helper.
  echo.
  pause
  exit /b 1
)
exit /b 0
