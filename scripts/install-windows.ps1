# Installs the Syncu helper and starts it at every login (hidden window).
# Right-click -> "Run with PowerShell".
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA "Syncu"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-Process syncu-engine -ErrorAction SilentlyContinue | Stop-Process -Force
Copy-Item (Join-Path $here "helper\syncu-engine.exe") $dest -Force
Copy-Item (Join-Path $here "helper\ffmpeg.exe") $dest -Force
Get-ChildItem $dest | Unblock-File

$vbs = Join-Path ([Environment]::GetFolderPath("Startup")) "SyncuHelper.vbs"
$exe = Join-Path $dest "syncu-engine.exe"
Set-Content -Path $vbs -Value "CreateObject(""WScript.Shell"").Run """"""$exe"""" serve"", 0, False"
Start-Process wscript.exe -ArgumentList "`"$vbs`""
Start-Sleep -Seconds 1
try {
  $r = Invoke-RestMethod -Uri http://127.0.0.1:47800/health -Headers @{ "X-Syncu" = "1" }
  if ($r.ok) { Write-Host "Syncu helper is running. Now load plugin\manifest.json in the UXP Developer Tool." }
} catch { Write-Host "Helper didn't answer. Try running $exe serve in a terminal to see why." }
