@echo off
curl -s -X POST http://127.0.0.1:3211/api/quit >nul
echo Server stop requested.
timeout /t 2 >nul
