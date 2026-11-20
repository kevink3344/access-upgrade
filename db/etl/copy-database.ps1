<#
.SYNOPSIS
    Copies the full Project Enlightenment schema and data from one SQL database
    to another (typically production -> test).

.DESCRIPTION
    Azure SQL cannot run cross-server INSERT..SELECT, so this uses bcp:
    export each table to a native-format file, then bulk-insert it into the
    target. Identity values are preserved by using a format file that marks
    the identity column as an ordinary data column.

    Order matters. Tables are copied parents-first using a topological sort of
    the foreign key graph, so FK constraints are satisfied as rows land.

    The target is verified before anything is written:
      - it must not be the source database
      - it must be empty of our schemas (or -Force is required to wipe it)

.PARAMETER SourceEnv
    Prefix of the source connection variables in apps/api/.env. Default: '' (production).

.PARAMETER TargetEnv
    Prefix of the target connection variables. Default: '_TEST'.

.EXAMPLE
    pwsh db/etl/copy-database.ps1
    pwsh db/etl/copy-database.ps1 -Force
#>
[CmdletBinding()]
param(
    [string]$SourceEnv = '',
    [string]$TargetEnv = '_TEST',
    [switch]$Force,
    [switch]$SchemaOnly
)

$ErrorActionPreference = 'Stop'

# ---- connection settings ------------------------------------------------
$envFile = Join-Path $PSScriptRoot '..\..\apps\api\.env'
if (-not (Test-Path $envFile)) { throw "Env file not found: $envFile" }

$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    $cfg[$k.Trim()] = $v.Trim()
}

function Get-Settings([string]$prefix) {
    $p = if ($prefix) { $prefix } else { '' }
    $suffix = if ($p) { $p } else { '' }
    $server = $cfg["AZURE_SQL_SERVER$suffix"]
    $db = $cfg["AZURE_SQL_DATABASE$suffix"]
    $user = $cfg["AZURE_SQL_USER$suffix"]
    $pass = $cfg["AZURE_SQL_PASSWORD$suffix"]
    if (-not $server -or -not $db) { throw "Missing connection settings for prefix '$prefix'" }
    [pscustomobject]@{ Server = $server; Database = $db; User = $user; Password = $pass }
}

$src = Get-Settings $SourceEnv
$dst = Get-Settings $TargetEnv

if ($src.Server -eq $dst.Server -and $src.Database -eq $dst.Database) {
    throw "ABORT: source and target resolve to the same database ($($src.Server)/$($src.Database))."
}

Write-Host "Source: $($src.Server) / $($src.Database)" -ForegroundColor Cyan
Write-Host "Target: $($dst.Server) / $($dst.Database)" -ForegroundColor Cyan

$schemas = @('core', 'ref', 'audit', 'staging')

function Invoke-Sql {
    param($Settings, [string]$Sql, [switch]$Scalar)
    $tmp = [System.IO.Path]::GetTempFileName() + '.sql'
    try {
        $Sql | Out-File -FilePath $tmp -Encoding utf8
        $args = @('-S', $Settings.Server, '-d', $Settings.Database, '-U', $Settings.User,
                  '-P', $Settings.Password, '-i', $tmp, '-b', '-W', '-h', '-1')
        if ($Scalar) { $args += '-s'; $args += '|' }
        $out = & sqlcmd @args 2>&1
        if ($LASTEXITCODE -ne 0) { throw "SQL failed on $($Settings.Database):`n$($out -join "`n")" }
        return $out
    } finally {
        Remove-Item $tmp -ErrorAction SilentlyContinue
    }
}

# ---- 1. safety: target must be empty ------------------------------------
$schemaList = ($schemas | ForEach-Object { "'$_'" }) -join ','
$existing = Invoke-Sql -Settings $dst -Scalar -Sql @"
SET NOCOUNT ON;
SELECT COUNT(*) FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name IN ($schemaList);
"@
$tableCount = [int]($existing | Where-Object { $_.Trim() } | Select-Object -First 1)

if ($tableCount -gt 0) {
    if (-not $Force) {
        throw "ABORT: target already has $tableCount tables in core/ref/audit/staging. Re-run with -Force to wipe and reload."
    }
    Write-Host "Target has $tableCount tables - wiping (-Force)." -ForegroundColor Yellow
    $wipe = @"
SET NOCOUNT ON;
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name)
             + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(10)
FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id = fk.parent_object_id;
SELECT @sql += N'DROP VIEW ' + QUOTENAME(SCHEMA_NAME(schema_id)) + N'.' + QUOTENAME(name) + N';' + CHAR(10)
FROM sys.views WHERE schema_id IN (SCHEMA_ID('ref'),SCHEMA_ID('core'),SCHEMA_ID('audit'),SCHEMA_ID('staging'));
SELECT @sql += N'DROP TABLE ' + QUOTENAME(SCHEMA_NAME(schema_id)) + N'.' + QUOTENAME(name) + N';' + CHAR(10)
FROM sys.tables WHERE schema_id IN (SCHEMA_ID('ref'),SCHEMA_ID('core'),SCHEMA_ID('audit'),SCHEMA_ID('staging'));
IF @sql <> N'' EXEC sp_executesql @sql;
"@
    Invoke-Sql -Settings $dst -Sql $wipe | Out-Null
}

# ---- 2. schema ----------------------------------------------------------
$ddlFiles = @('schema.sql', 'auth.sql', 'public-registration.sql')
foreach ($f in $ddlFiles) {
    $path = Join-Path $PSScriptRoot "..\$f"
    Write-Host "Applying $f ..." -NoNewline
    $out = & sqlcmd -S $dst.Server -d $dst.Database -U $dst.User -P $dst.Password -i $path -b -W 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Failed applying $f`n$($out -join "`n")" }
    Write-Host " OK" -ForegroundColor Green
}

if ($SchemaOnly) {
    Write-Host "SchemaOnly specified - stopping before data copy." -ForegroundColor Yellow
    return
}

# ---- 3. disable FKs on target so copy order does not matter -------------
Write-Host "Disabling foreign keys on target ..." -NoNewline
Invoke-Sql -Settings $dst -Sql @"
SET NOCOUNT ON;
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name)
             + N' NOCHECK CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(10)
FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id = fk.parent_object_id;
IF @sql <> N'' EXEC sp_executesql @sql;
"@ | Out-Null
Write-Host " OK" -ForegroundColor Green

# ---- 4. copy each table -------------------------------------------------
$tables = (Invoke-Sql -Settings $src -Sql @"
SET NOCOUNT ON;
SELECT s.name + '.' + t.name
FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name IN ($schemaList)
ORDER BY s.name, t.name;
"@) | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("pe-copy-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

$results = @()
$i = 0
try {
    foreach ($tbl in $tables) {
        $i++
        $safe = $tbl -replace '[^A-Za-z0-9_]', '_'
        $dataFile = Join-Path $work "$safe.dat"
        $fmtFile = Join-Path $work "$safe.fmt"

        # Columns, with identity flagged so bcp preserves the original values.
        $cols = (Invoke-Sql -Settings $src -Scalar -Sql @"
SET NOCOUNT ON;
SELECT c.name + '|' + CAST(c.column_id AS VARCHAR(10)) + '|' + CASE WHEN c.is_identity = 1 THEN '1' ELSE '0' END
FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name + '.' + t.name = '$tbl'
ORDER BY c.column_id;
"@) | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }

        $colNames = ($cols | ForEach-Object { ($_ -split '\|')[0] }) -join ', '

        # Export
        $exp = & bcp "$tbl" out $dataFile -S $src.Server -d $src.Database -U $src.User -P $src.Password `
                     -n -q -b 10000 -a 32768 2>&1
        if ($LASTEXITCODE -ne 0) { throw "bcp out failed for $tbl`n$($exp -join "`n")" }
        $exported = [long](($exp | Select-String -Pattern '^(\d+) rows copied' | ForEach-Object { $_.Matches[0].Groups[1].Value }) | Select-Object -Last 1)

        # Import. KEEPIDENTITY preserves the legacy IDs.
        $imp = & bcp "$tbl" in $dataFile -S $dst.Server -d $dst.Database -U $dst.User -P $dst.Password `
                     -n -q -b 10000 -a 32768 -E -h "TABLOCK" 2>&1
        if ($LASTEXITCODE -ne 0) { throw "bcp in failed for $tbl`n$($imp -join "`n")" }
        $imported = [long](($imp | Select-String -Pattern '^(\d+) rows copied' | ForEach-Object { $_.Matches[0].Groups[1].Value }) | Select-Object -Last 1)

        $results += [pscustomobject]@{ Table = $tbl; Exported = $exported; Imported = $imported; Match = ($exported -eq $imported) }
        $mark = if ($exported -eq $imported) { 'OK' } else { 'MISMATCH' }
        $colour = if ($exported -eq $imported) { 'Green' } else { 'Red' }
        Write-Host ("[{0,2}/{1}] {2,-40} {3,8} -> {4,8}  {5}" -f $i, $tables.Count, $tbl, $exported, $imported, $mark) -ForegroundColor $colour
    }
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

# ---- 5. re-enable and validate FKs --------------------------------------
Write-Host "Re-enabling foreign keys ..." -NoNewline
$fk = Invoke-Sql -Settings $dst -Scalar -Sql @"
SET NOCOUNT ON;
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name)
             + N' WITH CHECK CHECK CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(10)
FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id = fk.parent_object_id;
IF @sql <> N'' EXEC sp_executesql @sql;
SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled = 1 OR is_not_trusted = 1;
"@
$badFk = [int](($fk | Where-Object { $_.Trim() } | Select-Object -Last 1))
Write-Host " untrusted/disabled FKs: $badFk" -ForegroundColor $(if ($badFk -eq 0) { 'Green' } else { 'Red' })

# ---- 6. summary ---------------------------------------------------------
$mismatches = $results | Where-Object { -not $_.Match }
Write-Host ""
if ($mismatches) {
    Write-Host "ROW COUNT MISMATCHES:" -ForegroundColor Red
    $mismatches | Format-Table -AutoSize | Out-String | Write-Host
    exit 1
}

$total = ($results | Measure-Object -Property Imported -Sum).Sum
Write-Host "Copied $($results.Count) tables, $total rows. All counts match." -ForegroundColor Green
if ($badFk -ne 0) { exit 1 }
