@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows-setup\install.ps1"
if errorlevel 1 (
    echo Setup did not finish. Run Install Viewer.cmd again to retry.
    pause
    exit /b 1
)
call "%~dp0Open Viewer.cmd"
