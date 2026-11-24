<#
.SYNOPSIS
    Applies a SQL migration file to one or both Project Enlightenment databases.

.DESCRIPTION
    Schema changes must land in both production and test (see
    docs/features/schema-environments.md). This script applies a single file to
    a named environment so the two can be run deliberately, test first.

    Connection details are read from apps/api/.env, the same file the drift
    check uses: the unsuffixed AZURE_SQL_* keys point at the test database,
    AZURE_SQL_*_PROD at production (matching the app's own MODE switch).

    The migration files are written to be guarded and re-runnable, so running
    this twice is safe.

.PARAMETER File
    Path to the .sql migration, e.g. db/migrations/016-schoolcash-matching.sql

.PARAMETER Env
    'test' (default) or 'prod', or 'both'.

.EXAMPLE
    powershell -File db/etl/apply-migration.ps1 -File db/migrations/016-schoolcash-matching.sql -Env test
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$File,
    [ValidateSet('test', 'prod', 'both')][string]$Env = 'test'
)

$ErrorActionPreference = 'Stop'

$path = Resolve-Path $File -ErrorAction Stop
$envFile = Join-Path $PSScriptRoot '..\..\apps\api\.env'
if (-not (Test-Path $envFile)) { throw "No .env at $envFile" }

$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    $cfg[$k.Trim()] = $v.Trim()
}

function Get-Settings([string]$suffix, [string]$label) {
    $s = [pscustomobject]@{
        Label    = $label
        Server   = $cfg["AZURE_SQL_SERVER$suffix"]
        Database = $cfg["AZURE_SQL_DATABASE$suffix"]
        User     = $cfg["AZURE_SQL_USER$suffix"]
        Password = $cfg["AZURE_SQL_PASSWORD$suffix"]
    }
    if (-not $s.Server -or -not $s.Database) {
        throw "Missing AZURE_SQL_*$suffix settings in apps/api/.env"
    }
    return $s
}

$targets = switch ($Env) {
    'test' { @(Get-Settings '' 'test') }
    'prod' { @(Get-Settings '_PROD' 'production') }
    'both' { @((Get-Settings '' 'test'), (Get-Settings '_PROD' 'production')) }
}

foreach ($t in $targets) {
    Write-Host "Applying $([System.IO.Path]::GetFileName($path)) to $($t.Label) ($($t.Server)/$($t.Database))..." -ForegroundColor Cyan

    # The test server is serverless and auto-pauses; a 60s login timeout lets
    # the first connection wake it instead of failing.
    $out = & sqlcmd -S $t.Server -d $t.Database -U $t.User -P $t.Password `
                    -i $path -b -l 60 2>&1
    $code = $LASTEXITCODE
    $out | ForEach-Object { Write-Host "  $_" }

    if ($code -ne 0) {
        throw "Migration failed on $($t.Label) (exit $code)"
    }
    Write-Host "  OK: $($t.Label)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
