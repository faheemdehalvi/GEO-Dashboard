@echo off
echo.
echo  ==========================================
echo   Kynection SEO / AEO Dashboard v3
echo  ==========================================
echo.

cd /d "%~dp0"

IF NOT EXIST node_modules (
  echo  Installing dependencies...
  call npm install
  echo.
)

echo  Starting dashboard server...
echo  Dashboard will open at http://localhost:4016
echo.
set PORT=4016
node server.js

pause
