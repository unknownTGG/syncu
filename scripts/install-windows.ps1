# Installs Syncu: the helper (starts at every login, hidden) and the panel.
# Right-click -> "Run with PowerShell". Later updates happen from inside the
# panel (the "Update" button).
param([switch]$Update)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA "Syncu"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$exe = Join-Path $dest "syncu-engine.exe"

# ---- Helper ----
if ($Update) {
  # The running helper can't be overwritten, but it can be renamed; it exits
  # and starts the new copy once this script finishes.
  Remove-Item (Join-Path $dest "syncu-engine.old.exe") -Force -ErrorAction SilentlyContinue
  if (Test-Path $exe) { Rename-Item $exe "syncu-engine.old.exe" -Force }
} else {
  Get-Process syncu-engine -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}
Copy-Item (Join-Path $here "helper\syncu-engine.exe") $dest -Force
try { Copy-Item (Join-Path $here "helper\ffmpeg.exe") $dest -Force } catch { Write-Host "ffmpeg.exe in use; keeping the current one." }
Get-ChildItem $dest | Unblock-File
Write-Host "Helper installed in $dest"

# ---- Panel (.ccx, installed through Adobe's plugin installer) ----
$ccx = Join-Path $here "syncu.ccx"
$upia = Join-Path ${env:CommonProgramFiles} "Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if (Test-Path $ccx) {
  Unblock-File $ccx
  $ok = $false
  if (Test-Path $upia) {
    & $upia /install $ccx
    $ok = ($LASTEXITCODE -eq 0)
  }
  if ($ok) { Write-Host "Panel installed. Restart Premiere Pro, then open Window > UXP Plugins > Syncu." }
  else {
    Write-Host "Adobe's command-line installer didn't take it; opening the .ccx with Creative Cloud instead."
    Start-Process $ccx
  }
} else {
  Write-Host "No syncu.ccx in this folder; load plugin\manifest.json in the UXP Developer Tool."
}

if ($Update) { exit 0 }

# ---- Start at login ----
$vbs = Join-Path ([Environment]::GetFolderPath("Startup")) "SyncuHelper.vbs"
Set-Content -Path $vbs -Value "CreateObject(""WScript.Shell"").Run """"""$exe"""" serve"", 0, False"
Start-Process wscript.exe -ArgumentList "`"$vbs`""
Start-Sleep -Seconds 2
try {
  $r = Invoke-RestMethod -Uri http://127.0.0.1:47800/health -Headers @{ "X-Syncu" = "1" }
  if ($r.ok) { Write-Host "Syncu helper is running." }
} catch { Write-Host "Helper didn't answer. Try running $exe serve in a terminal to see why." }
Write-Host "Done. If you loaded Syncu in the UXP Developer Tool before, remove it there so only the installed copy runs."
