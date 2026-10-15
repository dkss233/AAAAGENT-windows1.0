@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title AAAAGENT 桌宠 · 准备语音唤醒模型

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "DEST=%ROOT%\.local\data\wake-models"
set "WORK=%TEMP%\aaaagent-wake"

echo.
echo   ============================================
echo     准备语音唤醒模型
echo   ============================================
echo.
echo   唤醒功能需要 5 个模型文件，仓库里不含（体积和授权原因）。
echo   本脚本会从镜像下载、校验并安装，约 33 MB。
echo.

where node.exe >nul 2>nul
if errorlevel 1 (
  echo   [错误] 找不到 node.exe
  echo          请先安装 Node.js 22 或 24 的 LTS 版：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if exist "%DEST%\encoder.onnx" (
  echo   检测到模型已存在，将重新校验并覆盖。
  echo.
)

if exist "%WORK%" rmdir /s /q "%WORK%"
mkdir "%WORK%" 2>nul

node "%ROOT%\tools\prepare-wake-models.mjs"
if errorlevel 1 (
  echo.
  echo   [失败] 模型准备未完成，请把上面的信息发给协助者。
  echo.
  pause
  exit /b 1
)

echo.
echo   完成。请重启桌宠，然后在控制台的「语音唤醒」页开启。
echo.
pause
exit /b 0
