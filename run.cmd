@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запускаю локальный сервер на http://127.0.0.1:8123/
start "" cmd /c "python -m http.server 8123 --bind 127.0.0.1"
timeout /t 2 >nul
start "" "http://127.0.0.1:8123/"
