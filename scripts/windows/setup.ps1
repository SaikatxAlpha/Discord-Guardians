# One-time setup for Soul Society on Windows.
# Usage (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'Node.js 22.13+ is required: https://nodejs.org/' }
$ver = (node -p "process.versions.node").Trim()
Write-Host "Node.js $ver"
if ([version]$ver -lt [version]'22.13.0') { throw 'Node.js 22.13 or newer is required (built-in SQLite).' }

Write-Host 'Installing dependencies (no AI models are downloaded)...'
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host 'Created .env from .env.example - edit it now (OWNER_ID, KNIGHT_TOKEN, AEGIS_TOKEN, DEV_GUILD_ID).'
  notepad .env
}

New-Item -ItemType Directory -Force data\music | Out-Null
npm run check:config
Write-Host "`nNext: npm run check:discord ; npm run register ; npm start"
