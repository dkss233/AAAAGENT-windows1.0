@echo off
chcp 65001 >nul
setlocal
title AAAAGENT 桌宠 · 国内镜像安装（首次使用）

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo   ============================================
echo     AAAAGENT 桌宠 · 用国内镜像安装依赖
echo   ============================================
echo.
echo   适用：npm 下载超时、或 better-sqlite3 编译失败（缺 Python / C++ 生成工具）
echo   原理：让 npm 与预编译二进制都从 npmmirror（阿里云公共镜像）获取
echo.

where node.exe >nul 2>nul
if errorlevel 1 (
  echo   [错误] 找不到 node.exe
  echo          请先安装 Node.js 22 或 24 的 LTS 版：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -p "process.versions.node"') do set "NODEV=%%v"
echo   检测到 Node.js v%NODEV%

echo.
echo   --------------------------------------------
echo    第 1 步：安装依赖（从镜像下载）
echo   --------------------------------------------
echo.

set "npm_config_registry=https://registry.npmmirror.com"
set "npm_config_disturl=https://npmmirror.com/mirrors/node"
set "npm_config_electron_mirror=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3"

pushd "%ROOT%\code\desktop-pet"
if exist node_modules rmdir /s /q node_modules
call npm ci
if errorlevel 1 (
  echo.
  echo   [失败] 依赖安装未成功。
  echo.
  echo   若报错仍提到 better-sqlite3 编译失败，说明你的 Node 版本没有对应的
  echo   预编译二进制（镜像只提供 Node 22 / 24 / 25 / 26）。
  echo   解决办法：换成 Node.js 22 或 24 的 LTS 版再运行本脚本。
  echo.
  popd
  pause
  exit /b 1
)
echo.
echo   [1/2] 依赖安装完成。

echo.
echo   --------------------------------------------
echo    第 2 步：编译后端与界面
echo   --------------------------------------------
echo.
call npm run build
if errorlevel 1 (
  echo   [失败] 后端编译未成功。
  popd
  pause
  exit /b 1
)
call npm run build:desktop
if errorlevel 1 (
  echo   [失败] 界面打包未成功。
  popd
  pause
  exit /b 1
)
popd
echo.
echo   [2/2] 编译完成。

echo.
echo   ============================================
echo    安装完成，正在启动桌宠
echo   ============================================
echo.

node "%ROOT%\tools\aaaagent-start.mjs"
if errorlevel 1 (
  echo.
  echo   启动未成功，请把上面的信息发给协助者。
  echo.
  pause
  exit /b 1
)

echo.
echo   启动完成，本窗口 5 秒后自动关闭。
timeout /t 5 >nul
exit /b 0
