<#
.SYNOPSIS
    Compares the schema of two Project Enlightenment databases and reports drift.

.DESCRIPTION
    Schema changes must be applied to both production and test. This script is
    the check that catches the mistake.

    It compares, for the core/ref/audit/staging schemas:
      - tables and their columns (name, type, nullability, identity)
      - primary keys, unique constraints, foreign keys, check constraints
      - defaults
      - views

    Exits 1 if any drift is found, so it can gate a commit or a deployment.

.EXAMPLE
    powershell -File db/etl/compare-schema.ps1
#>
[CmdletBinding()]
param(
    [string]$SourceEnv = '',
    [string]$TargetEnv = '_PROD'
)

$ErrorActionPreference = 'Stop'

# Where sqlcmd lives. On the Linux CI runner the package installs to
# /opt/mssql-tools18/bin and that directory may not be on PATH yet, so the
# known location is checked before falling back to a bare command name.
$script:SqlcmdPath = if (Get-Command sqlcmd -ErrorAction SilentlyContinue) {
    'sqlcmd'
} elseif (Test-Path '/opt/mssql-tools18/bin/sqlcmd') {
    '/opt/mssql-tools18/bin/sqlcmd'
} elseif (Test-Path '/opt/mssql-tools/bin/sqlcmd') {
    '/opt/mssql-tools/bin/sqlcmd'
} else {
    'sqlcmd'
}

$envFile = Join-Path $PSScriptRoot '..\..\apps\api\.env'
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    $cfg[$k.Trim()] = $v.Trim()
}

function Get-Settings([string]$suffix) {
    [pscustomobject]@{
        Server   = $cfg["AZURE_SQL_SERVER$suffix"]
        Database = $cfg["AZURE_SQL_DATABASE$suffix"]
        User     = $cfg["AZURE_SQL_USER$suffix"]
        Password = $cfg["AZURE_SQL_PASSWORD$suffix"]
    }
}

$src = Get-Settings $SourceEnv
$dst = Get-Settings $TargetEnv

function Get-Fingerprint($Settings) {
    # One row per schema object, stable and order-independent.
    $sql = @'
SET NOCOUNT ON;
SELECT 'COLUMN' AS kind,
       OBJECT_SCHEMA_NAME(c.object_id) + '.' + OBJECT_NAME(c.object_id) + '.' + c.name AS obj,
       TYPE_NAME(c.user_type_id) + '|' + CAST(c.max_length AS VARCHAR(10)) + '|' +
       CAST(c.precision AS VARCHAR(10)) + '|' + CAST(c.scale AS VARCHAR(10)) + '|' +
       CAST(c.is_nullable AS VARCHAR(2)) + '|' + CAST(c.is_identity AS VARCHAR(2)) AS detail
FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name IN ('core','ref','audit','staging')

UNION ALL
-- Constraint names are auto-generated when the DDL omits them, so the name
-- is deliberately excluded: only the shape of the relationship matters.
SELECT 'FK',
       OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id),
       OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) + '|' +
       COL_NAME(fk.parent_object_id, fkc.parent_column_id) + '|' +
       COL_NAME(fk.referenced_object_id, fkc.referenced_column_id)
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id

UNION ALL
SELECT 'KEY',
       OBJECT_SCHEMA_NAME(kc.parent_object_id) + '.' + OBJECT_NAME(kc.parent_object_id) + '.' + kc.name,
       kc.type + '|' + COL_NAME(ic.object_id, ic.column_id)
FROM sys.key_constraints kc
JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id

UNION ALL
SELECT 'CHECK',
       OBJECT_SCHEMA_NAME(cc.parent_object_id) + '.' + OBJECT_NAME(cc.parent_object_id) + '.' + cc.name,
       cc.definition COLLATE DATABASE_DEFAULT
FROM sys.check_constraints cc

UNION ALL
SELECT 'DEFAULT',
       OBJECT_SCHEMA_NAME(dc.parent_object_id) + '.' + OBJECT_NAME(dc.parent_object_id) + '.' + dc.name,
       dc.definition COLLATE DATABASE_DEFAULT
FROM sys.default_constraints dc

UNION ALL
SELECT 'VIEW',
       SCHEMA_NAME(v.schema_id) + '.' + v.name,
       'exists'
FROM sys.views v
WHERE v.schema_id IN (SCHEMA_ID('core'),SCHEMA_ID('ref'),SCHEMA_ID('audit'),SCHEMA_ID('staging'))

ORDER BY kind, obj;
'@
    $tmp = [System.IO.Path]::GetTempFileName() + '.sql'
    try {
        # Written as UTF-8 WITHOUT a BOM. `Out-File -Encoding utf8` in Windows
        # PowerShell 5.1 emits a BOM, which the Windows sqlcmd tolerates but
        # the Linux mssql-tools18 build rejects, so the CI run failed on the
        # first statement while the same script passed locally.
        [System.IO.File]::WriteAllText($tmp, $sql, (New-Object System.Text.UTF8Encoding($false)))
        # -C trusts the server certificate. Azure SQL presents a valid chain,
        # but mssql-tools18 (the Linux package used by CI) encrypts strictly by
        # default and has no local CA store to verify against; without -C it
        # fails with a certificate error on the runner. Harmless on Windows,
        # where mssql-tools17 ignores it.
        # Resolved explicitly: on the Linux runner the tool lives in
        # /opt/mssql-tools18/bin, and a step that appends to GITHUB_PATH only
        # takes effect for later steps, not the one that set it.
        $exe = if ($script:SqlcmdPath) { $script:SqlcmdPath } else { 'sqlcmd' }
        $out = & $exe -S $Settings.Server -d $Settings.Database -U $Settings.User -P $Settings.Password `
                      -i $tmp -b -W -s '~' -h -1 -C 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Fingerprint failed on $($Settings.Database):`n$($out -join "`n")" }
        return ($out | Where-Object { $_ -match '~' } | ForEach-Object { $_.Trim() })
    } finally {
        Remove-Item $tmp -ErrorAction SilentlyContinue
    }
}

Write-Host "Source: $($src.Server) / $($src.Database)" -ForegroundColor Cyan
Write-Host "Target: $($dst.Server) / $($dst.Database)" -ForegroundColor Cyan
Write-Host ""

$a = Get-Fingerprint $src
$b = Get-Fingerprint $dst

$diff = Compare-Object $a $b
if (-not $diff) {
    Write-Host "NO DRIFT - $($a.Count) schema objects identical." -ForegroundColor Green
    exit 0
}

Write-Host "SCHEMA DRIFT DETECTED" -ForegroundColor Red
Write-Host ""

$missing = $diff | Where-Object { $_.SideIndicator -eq '<=' }
$extra   = $diff | Where-Object { $_.SideIndicator -eq '=>' }

if ($missing) {
    Write-Host "Only in source ($($missing.Count)):" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "  $($_.InputObject)" }
    Write-Host ""
}
if ($extra) {
    Write-Host "Only in target ($($extra.Count)):" -ForegroundColor Yellow
    $extra | ForEach-Object { Write-Host "  $($_.InputObject)" }
}

exit 1
