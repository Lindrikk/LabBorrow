# Starts LabBorrow with a public https link, then publishes that link to GitHub
# (server-url.txt) so the Android app finds the new link by itself.
# Run it by double-clicking start-public.bat. Close this window to stop LabBorrow.

Set-Location $PSScriptRoot
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflared)) { $cloudflared = "cloudflared" }
$logDir = Join-Path $env:TEMP "labborrow"
New-Item -ItemType Directory -Force $logDir | Out-Null
$tunnelLog = Join-Path $logDir "tunnel.log"
Remove-Item $tunnelLog -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  STEM STARR LabBorrow" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Starting the LabBorrow server..."
# -NoNewWindow ties both programs to this window: closing it stops them too.
$server = Start-Process python -ArgumentList "app.py" -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "server.log") -RedirectStandardError (Join-Path $logDir "server-errors.log")
Write-Host "  Starting the public link..."
$tunnel = Start-Process $cloudflared -ArgumentList "tunnel --url http://localhost:5000" -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "tunnel-out.log") -RedirectStandardError $tunnelLog

$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $tunnelLog) {
        $match = Select-String -Path $tunnelLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
        if ($match) { $url = $match.Matches[0].Value }
    }
}
if (-not $url) {
    Write-Host "  Could not get a public link. Check the internet connection and run this again." -ForegroundColor Red
    Stop-Process -Id $server.Id, $tunnel.Id -ErrorAction SilentlyContinue
    Read-Host "  Press Enter to close"
    exit 1
}

Write-Host "  Publishing the link for the Android app..."
Set-Content -Path "server-url.txt" -Value $url -NoNewline -Encoding ascii
git pull --rebase --autostash -q 2>$null
git add server-url.txt 2>$null
git commit -q -m "Update server link" -- server-url.txt 2>$null
git push -q 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Published. The app will connect to the new link." -ForegroundColor Green
} else {
    Write-Host "  Could not publish to GitHub; phones must type the link in the app this time." -ForegroundColor Yellow
}
Set-Clipboard -Value $url

Write-Host ""
Write-Host "  LabBorrow is online at:" -ForegroundColor Green
Write-Host "  $url" -ForegroundColor White
Write-Host "  (copied to the clipboard)"
Write-Host ""
Write-Host "  Keep this window open and the laptop awake. Close this window to stop LabBorrow."
Wait-Process -Id $tunnel.Id
Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
