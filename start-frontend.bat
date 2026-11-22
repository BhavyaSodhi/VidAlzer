@echo off
title VidAlzer Frontend
echo ========================================================
echo   Launching VidAlzer Frontend...
echo ========================================================
cd /d "%~dp0\frontend"
start http://localhost:3001
node server.js
pause
