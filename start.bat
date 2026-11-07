@echo off
rem Local preview on this PC only. The published app does not need this server.
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Preview: http://localhost:8765
echo   Close this window to stop the server.
echo.
if not "%~1"=="--no-open" start "" http://localhost:8765
python -m http.server 8765 --bind 127.0.0.1
