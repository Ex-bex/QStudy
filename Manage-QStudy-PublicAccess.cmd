@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\production\Manage-QStudyPublicAccess.ps1" %*
exit /b %errorlevel%
