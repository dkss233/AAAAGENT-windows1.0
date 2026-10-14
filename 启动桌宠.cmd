@echo off
chcp 65001 >nul
setlocal
title AAAAGENT 桌宠启动器

echo.
echo   ============================================
echo    AAAAGENT 桌宠启动器
echo   ============================================
echo.
echo   将依次完成：
echo     1. 启动 DeepSeek Harness 主机（若未运行）
echo     2. 启动桌宠
echo.

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo   [错误] 找不到 node.exe，请先安装 Node.js 并加入 PATH。
  echo.
  pause
  exit /b 1
)

node "%ROOT%\tools\aaaagent-start.mjs"
if errorlevel 1 (
  echo.
  echo   [错误] 启动过程中出现问题，请把上面的信息发给协助者。
  echo.
  pause
  exit /b 1
)

echo.
echo   启动完成，本窗口 5 秒后自动关闭。
timeout /t 5 >nul
exit /b 0
