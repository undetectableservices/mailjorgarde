$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'RUN.bat'
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { exit 0 }
$shortcutPath = Join-Path $desktop 'Jorgarde Automator.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'Automatisation Chromium avec JorgardeMail'
$shortcut.Save()
