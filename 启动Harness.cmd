@echo off
chcp 65001 >nul
setlocal
title 启动 Harness 主机

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo   [错误] 找不到 node.exe，请先安装 Node.js 并加入 PATH。
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================
echo    启动 Harness 主机
echo   ============================================
echo.
echo   桌宠的对话、语音、表情都不需要它。
echo   只有让桌宠执行 DSH 任务时才需要。
echo.

node "%ROOT%\tools\aaaagent-start-harness.mjs" %*
if errorlevel 1 (
  echo.
  echo   启动未成功，请把上面的信息发给协助者。
)

pause
exit /b 0
