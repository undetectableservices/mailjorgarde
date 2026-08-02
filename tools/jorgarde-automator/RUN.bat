@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo Jorgarde Automator n'est pas installe. Lancement de l'installateur...
  call INSTALLER.bat
  if errorlevel 1 exit /b 1
)
set "PLAYWRIGHT_BROWSERS_PATH=0"
start "Jorgarde Automator" /D "%~dp0" ".venv\Scripts\pythonw.exe" app.py
