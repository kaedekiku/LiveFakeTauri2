param(
  [int]$DebugPort = 9248,
  [int]$StartupTimeout = 120
)

$ErrorActionPreference = "Stop"

# WebView2 remote debugging via CDP
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"

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

Write-Host "e2e: test exit code=$($global:E2E_EXIT)"
if ($null -eq $global:E2E_EXIT) { exit 1 }
exit $global:E2E_EXIT
