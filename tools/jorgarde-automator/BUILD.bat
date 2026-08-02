@echo off
setlocal
cd /d "%~dp0"
title Construction de Jorgarde Automator

if not exist ".venv\Scripts\python.exe" (
  echo Lancez INSTALLER.bat avant BUILD.bat.
  pause
  exit /b 1
)

set "PLAYWRIGHT_BROWSERS_PATH=0"
".venv\Scripts\python.exe" -m unittest discover -s tests -v
if errorlevel 1 goto :failure

".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --onedir --windowed ^
  --name JorgardeAutomator ^
  --paths . ^
  --add-data "assets;assets" ^
  --collect-all playwright ^
  --collect-all keyring ^
  app.py
if errorlevel 1 goto :failure

copy /Y README.md "dist\JorgardeAutomator\README.md" >nul
xcopy /E /I /Y examples "dist\JorgardeAutomator\examples" >nul

echo.
echo Application construite dans dist\JorgardeAutomator\
pause
exit /b 0

:failure
echo.
echo La construction a echoue.
pause
exit /b 1
