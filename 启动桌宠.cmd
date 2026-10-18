@echo off
rem ASCII-only on purpose. cmd.exe parses this file with the console code page that is active when it
rem starts reading, and `chcp 65001` below cannot retroactively fix lines it already mis-decoded. On a
rem 936 (GBK) console UTF-8 Chinese here was decoded as garbage, executed as a command, and left the
rem script exiting 1 before the pet ever started. All user-facing Chinese lives in the Node script,
rem which writes UTF-8 itself. Keep every byte of this file ASCII.
chcp 65001 >nul
setlocal
title AAAAGENT
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] node.exe was not found. Install Node.js and add it to PATH.
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
