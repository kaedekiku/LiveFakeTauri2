param(
  [int]$DebugPort = 9248,
  [int]$StartupTimeout = 120
)

$ErrorActionPreference = "Stop"

# WebView2 remote debugging via CDP
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"

# Refuse to run when something already answers on the debug port: the tests would attach to that app
# (and write test values into ITS data) instead of the one started below.
try {
  $busy = Invoke-WebRequest -Uri "http://127.0.0.1:$DebugPort/json/version" -UseBasicParsing -TimeoutSec 2
  if ($busy.StatusCode -eq 200) {
    Write-Host "e2e: port $DebugPort is already answering (another app with remote debugging?). Close it or pass -DebugPort. Nothing was started."
    exit 1
  }
} catch {
  # nothing is listening: OK
}

# Data folder: always a fresh, empty folder made for this run (never the everyday / development data).
# The tests overwrite favorites, NG filters and read status, so they must not share a data folder.
# A marker is planted in it; e2e_playwright.mjs checks the marker before its first write.
$dataRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\target\e2e-data"))
$dataDir = Join-Path $dataRoot ("run-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$marker = "e2e-marker-" + [Guid]::NewGuid().ToString("N")
$markerJson = '{"boards":[{"boardName":"' + $marker + '","url":"https://e2e-marker.invalid/"}],"threads":[]}'
[System.IO.File]::WriteAllText((Join-Path $dataDir "favorites.json"), $markerJson, (New-Object System.Text.UTF8Encoding($false)))
$env:EMBER_DATA_DIR = $dataDir
$env:E2E_DATA_MARKER = $marker
Write-Host "e2e: data folder for this run: $dataDir"

# Use the test identifier (tauri.test.conf.json) so this can run while the everyday LiveFake is open
Write-Host "e2e: starting cargo tauri dev (test identifier, CDP port=$DebugPort)..."

$tauriProc = Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c cd /d `"$PSScriptRoot\..`" && npx tauri dev --config src-tauri/tauri.test.conf.json 2>&1" `
  -WorkingDirectory "$PSScriptRoot\.." `
  -WindowStyle Hidden `
  -PassThru

$cleanup = {
  $ErrorActionPreference = "Continue"
  Write-Host "e2e: cleaning up..."
  if ($tauriProc -and -not $tauriProc.HasExited) {
    taskkill /PID $tauriProc.Id /T /F 2>$null | Out-Null
  }
  Write-Host "e2e: cleanup done"
}

try {
  # wait for CDP endpoint (must be WebView2, not wrangler/node)
  $ok = $false
  for ($i = 0; $i -lt ($StartupTimeout * 4); $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$DebugPort/json/version" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200 -and $r.Content -match "WebView2|Chrome") {
        $ok = $true
        Write-Host "e2e: CDP endpoint ready (attempt $i) - $($r.Content.Substring(0, [Math]::Min(120, $r.Content.Length)))"
        break
      }
    } catch {
      # retry
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ok) {
    throw "e2e: CDP endpoint startup timeout after ${StartupTimeout}s"
  }

  # small extra wait for Tauri IPC to initialize
  Start-Sleep -Seconds 2

  $env:E2E_CDP_URL = "http://127.0.0.1:$DebugPort"
  Write-Host "e2e: running playwright tests..."
  node "$PSScriptRoot\e2e_playwright.mjs"
  $global:E2E_EXIT = $LASTEXITCODE
} finally {
  try { & $cleanup } catch { Write-Host "e2e: cleanup error (ignored): $_" }
}

# Remove the data folder of this run only when the tests passed (keep it for inspection otherwise)
if ($global:E2E_EXIT -eq 0 -and $dataDir.StartsWith($dataRoot + [System.IO.Path]::DirectorySeparatorChar) -and (Test-Path -LiteralPath $dataDir)) {
  for ($i = 0; $i -lt 20; $i++) {
    try { Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 500 }
  }
  if (Test-Path -LiteralPath $dataDir) { Write-Host "e2e: could not remove $dataDir (still in use); remove it later" }
} else {
  Write-Host "e2e: data folder kept: $dataDir"
}

Write-Host "e2e: test exit code=$($global:E2E_EXIT)"
if ($null -eq $global:E2E_EXIT) { exit 1 }
exit $global:E2E_EXIT
