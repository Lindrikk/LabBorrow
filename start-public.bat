@echo off
rem Double-click to start LabBorrow and get a public https link for phones.
rem Keep both windows open while people use the app. Close them to stop.
cd /d "%~dp0"
start "LabBorrow server" python app.py
echo.
echo Starting public link... look for the line ending in .trycloudflare.com below.
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:5000
pause
