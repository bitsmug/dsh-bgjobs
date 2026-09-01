@echo off
rem bgjobs offline management CLI launcher.
rem Usage: dsh-bgjobs.bat list | status -Id <id> | ... (pass through to dsh-bgjobs.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-bgjobs.ps1" %*
