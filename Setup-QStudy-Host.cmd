@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\production\Setup-QStudyHost.ps1" %*
exit /b %ERRORLEVEL%
