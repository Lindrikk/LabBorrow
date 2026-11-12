@echo off
rem Double-click to start LabBorrow with a public link for phones and the Android app.
rem Keep the window open while people use the app. Close it to stop LabBorrow.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-public.ps1"
