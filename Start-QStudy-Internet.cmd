@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\production\Start-QStudyInternet.ps1" %*
exit /b %errorlevel%
