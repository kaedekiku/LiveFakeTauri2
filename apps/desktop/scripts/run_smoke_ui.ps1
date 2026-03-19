$ErrorActionPreference = "Stop"

$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev -- --host 127.0.0.1 --port 1420" -WorkingDirectory "." -PassThru

try {
  $ok = $false
  for ($i = 0; $i -lt 80; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:1420" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -ge 200) {
        $ok = $true
        break
      }
    } catch {
      # retry
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ok) {
    throw "dev server startup timeout"
  }

  $env:SMOKE_UI_URL = "http://127.0.0.1:1420"
  node scripts/smoke_ui_playwright.mjs
} finally {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
  }
}
