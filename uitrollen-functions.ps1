# Rolt de Cloud Function (meldingen) uit naar Firebase-project ma-teamdashboard.
# Gebruik: rechtsklik -> Uitvoeren met PowerShell, of in een terminal:
#   powershell -ExecutionPolicy Bypass -File ".\uitrollen-functions.ps1"
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
$npm = 'C:\Program Files\nodejs\npm.cmd'
$firebase = Join-Path $env:APPDATA 'npm\node_modules\firebase-tools\lib\bin\firebase.js'

Write-Host "Pakketten voor de functie installeren..."
& $npm --prefix functions install --no-audit --no-fund
if ($LASTEXITCODE) { throw "npm install mislukt" }

Write-Host "Uitrollen naar Firebase..."
& $node $firebase deploy --only functions --project ma-teamdashboard --force
if ($LASTEXITCODE) { throw "Uitrollen mislukt" }
Write-Host "Klaar."
