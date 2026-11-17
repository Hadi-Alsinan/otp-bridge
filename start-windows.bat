@echo off
rem Double-click this file to start OTP Bridge on Windows.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0companion\cli.js" %*
if errorlevel 1 pause
goto :eof

:nonode
echo OTP Bridge needs Node.js, and it was not found on this PC.
echo Install the LTS version from https://nodejs.org, then run this file again.
echo.
pause
exit /b 1
