param(
  [string]$ThreadUrl = "https://mao.5ch.io/test/read.cgi/ngt/9240230711/",
  [int]$Timeout = 15,
  [string]$FromName = "",
  [string]$Mail = "",
  [string]$Message = "",
  [switch]$AllowRealSubmit,
  [string]$RealSubmitToken = "",
  [string]$ReportPath = ""
)

$ErrorActionPreference = "Stop"

$args = @("scripts/probe_post_flow.py", "--thread-url", $ThreadUrl, "--timeout", "$Timeout")
if ($FromName -ne "") { $args += @("--from-name", $FromName) }
if ($Mail -ne "") { $args += @("--mail", $Mail) }
if ($Message -ne "") { $args += @("--message", $Message) }
if ($ReportPath -ne "") { $args += @("--report-path", $ReportPath) }
if ($AllowRealSubmit.IsPresent) { $args += "--allow-real-submit" }
if ($RealSubmitToken -ne "") { $args += @("--real-submit-token", $RealSubmitToken) }

Write-Host ("RUN: python " + ($args -join " "))
python @args
exit $LASTEXITCODE
