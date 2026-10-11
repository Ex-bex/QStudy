@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\production\Manage-QStudy.ps1" %*
exit /b %ERRORLEVEL%
