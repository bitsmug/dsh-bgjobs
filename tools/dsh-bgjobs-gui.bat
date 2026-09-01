@echo off
rem Launch the bgjobs management window (no console window).
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0dsh-bgjobs-gui.ps1"
