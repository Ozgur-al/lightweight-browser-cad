@echo off
setlocal
cd /d "%~dp0"
set "viewerNode=%~dp0runtime\node\node.exe"
if exist "%viewerNode%" goto run
set "viewerNode=node.exe"
where.exe /q node.exe
if errorlevel 1 (
    set "viewerNode="
    for /d %%D in ("%USERPROFILE%\node-portable\node-*") do if exist "%%~fD\node.exe" set "viewerNode=%%~fD\node.exe"
    if not defined viewerNode (
        echo Node.js was not found. Install Node.js 22 or place it under "%USERPROFILE%\node-portable".
        pause
        exit /b 1
    )
)
:run
if /i "%~1"=="--lan" (
    "%viewerNode%" serve.mjs --open --lan "%~2"
) else (
    "%viewerNode%" serve.mjs --open
)
if errorlevel 1 pause
