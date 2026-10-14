@echo off
rem AAAAGENT desktop pet launcher (Windows).
rem Double-click this file, or make a shortcut to it.
rem All messages come from start-trial-windows.ps1; keep this file ASCII-only.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-trial-windows.ps1" %*
rem The launcher starts the pet detached and returns, so closing this window is safe.
