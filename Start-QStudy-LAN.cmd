@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-QStudy.ps1" -Lan %*
exit /b %ERRORLEVEL%
