@echo off
cd /d "%~dp0"
node server.js --open=player
if errorlevel 1 pause
