@echo off
cd /d "%~dp0"
node server.js --open=manager
if errorlevel 1 pause
