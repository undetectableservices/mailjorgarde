@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Installation de Jorgarde Automator

echo.
echo  Jorgarde Automator - Installation Windows
echo  ==========================================
echo.

set "PY_CMD="
py -3.12 -c "import sys" >nul 2>&1 && set "PY_CMD=py -3.12"
if not defined PY_CMD python -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>&1 && set "PY_CMD=python"

if not defined PY_CMD (
  echo Python 3.10 ou plus recent est requis.
  where winget >nul 2>&1
  if errorlevel 1 (
    echo Installez Python depuis https://www.python.org/downloads/ puis relancez ce fichier.
    pause
    exit /b 1
  )
  echo Installation de Python 3.12 pour votre compte...
  winget install --id Python.Python.3.12 -e --scope user --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo Echec de l'installation de Python.
    pause
    exit /b 1
  )
  set "PY_EXE=%LocalAppData%\Programs\Python\Python312\python.exe"
  if not exist "%PY_EXE%" (
    echo Python vient d'etre installe. Fermez cette fenetre puis relancez INSTALLER.bat.
    pause
    exit /b 0
  )
  set "PY_CMD="%PY_EXE%""
)

if not exist ".venv\Scripts\python.exe" (
  echo Creation de l'environnement isole...
  %PY_CMD% -m venv .venv
  if errorlevel 1 goto :failure
)

echo Installation des composants Python...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --upgrade pip
if errorlevel 1 goto :failure
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :failure

echo Installation de Chromium...
set "PLAYWRIGHT_BROWSERS_PATH=0"
".venv\Scripts\python.exe" -m playwright install chromium --no-shell
if errorlevel 1 goto :failure

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\create-shortcut.ps1" >nul 2>&1

echo.
echo Installation terminee avec succes.
echo Un raccourci a ete ajoute sur votre Bureau lorsque Windows l'a permis.
echo Lancez maintenant RUN.bat.
echo.
pause
exit /b 0

:failure
echo.
echo L'installation a echoue. Verifiez votre connexion puis relancez INSTALLER.bat.
pause
exit /b 1
