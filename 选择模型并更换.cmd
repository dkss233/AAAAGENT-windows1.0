@echo off
chcp 65001 >nul
setlocal
title 更换 Live2D 模型

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo   [错误] 找不到 node.exe。
  echo.
  pause
  exit /b 1
)

node "%ROOT%\tools\aaaagent-pick-model.mjs"
if errorlevel 1 (
  echo.
  echo   未完成安装，请把上面的信息发给协助者。
)

pause
exit /b 0
