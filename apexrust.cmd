@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%scripts\apexrust.mjs" %*
exit /b %errorlevel%
