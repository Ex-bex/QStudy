@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Test-QStudyHomeNetwork.ps1" %*
exit /b %ERRORLEVEL%
