@echo off
chcp 65001 >nul
setlocal
title 更换 Live2D 模型

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
echo    更换 Live2D 模型
echo   ============================================
echo.

rem With no argument, open the folder browser. Dragging a folder onto this file passes it as %1.
if not "%~1"=="" (
  node "%ROOT%\tools\aaaagent-set-model.mjs" %*
) else (
  node "%ROOT%\tools\aaaagent-pick-model.mjs"
)

echo.
pause
exit /b 0
