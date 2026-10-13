@echo off
REM Start KNIGHT + AEGIS (double-click friendly). Ctrl+C stops both cleanly.
cd /d "%~dp0..\.."
title Soul Society - KNIGHT + AEGIS
call npm start
pause
