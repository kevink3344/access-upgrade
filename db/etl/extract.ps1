# =====================================================================
#  extract.ps1 — Access -> Azure SQL staging
#
#  Reads every table from database/TrainingDatabase.accdb and writes each
#  row into staging.RawRow as JSON. Nothing is coerced, renamed or
#  filtered here; the transform step does all of that.
#
#  Resumable: tables already fully staged are skipped. Commits in small
#  batches so Azure SQL does not kill a long-running transaction, and
#  retries transient transport errors.
#
#  Usage:
#    powershell -File db/etl/extract.ps1            # resume
#    powershell -File db/etl/extract.ps1 -Reset     # clear staging first
# =====================================================================

param(
    [switch]$Reset,
    [int]$BatchSize = 2000,
    [int]$MaxRetries = 5
)

$ErrorActionPreference = 'Stop'

# ---- connection settings (from database/.env.example) ----------------
$envFile = Join-Path $PSScriptRoot '..\..\database\.env.example'
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    $cfg[$k.Trim()] = $v.Trim()
}
$sqlConnStr = "Server=tcp:$($cfg['AZURE_SQL_SERVER']),1433;Database=$($cfg['AZURE_SQL_DATABASE']);" +
              "User ID=$($cfg['AZURE_SQL_USER']);Password=$($cfg['AZURE_SQL_PASSWORD']);" +
              "Encrypt=True;TrustServerCertificate=False;Connection Timeout=60;"

$accdb = Join-Path $PSScriptRoot '..\..\database\TrainingDatabase.accdb'
$accConnStr = "Driver={Microsoft Access Driver (*.mdb, *.accdb)};DBQ=$accdb;"

# Tables deliberately not migrated (plan §6.3)
$excluded = @('aTempGroup', 'Paste Errors', 'Switchboard Items', 'tblWorkshopEvalSummaries_OLD')
$isExcluded = { param($tbl) ($excluded -contains $tbl) -or ($tbl -like 'stbl*') }

function New-SqlConnection {
    $c = New-Object System.Data.SqlClient.SqlConnection $sqlConnStr
    $c.Open()
    return $c
}

function Invoke-WithRetry {
    param([scriptblock]$Action, [string]$Context)
    $attempt = 0
    while ($true) {
        $attempt++
        try { return & $Action }
        catch {
            $msg = $_.Exception.Message
            $transient = $msg -match 'transport-level|timeout|deadlock|connection was aborted|forcibly closed|network-related'
            if (-not $transient -or $attempt -ge $MaxRetries) { throw }
            $wait = [math]::Min(30, [math]::Pow(2, $attempt))
            Write-Host ("    retry {0}/{1} in {2}s ({3})" -f $attempt, $MaxRetries, $wait, $Context) -ForegroundColor Yellow
            Start-Sleep -Seconds $wait
        }
    }
}

Write-Host "=== EXTRACT: Access -> staging.RawRow ===" -ForegroundColor Cyan

# ---- Access: enumerate source tables and their true row counts --------
$acc = New-Object System.Data.Odbc.OdbcConnection $accConnStr
$acc.Open()

$sourceCounts = @{}
$tables = $acc.GetSchema('Tables') |
          Where-Object { $_.TABLE_TYPE -eq 'TABLE' } |
          Select-Object -ExpandProperty TABLE_NAME |
          Sort-Object

foreach ($t in $tables) {
    if (& $isExcluded $t) { continue }
    $c = $acc.CreateCommand(); $c.CommandText = "SELECT COUNT(*) FROM [$t]"; $c.CommandTimeout = 600
    $sourceCounts[$t] = [int]$c.ExecuteScalar()
}

# ---- SQL: current staged counts ---------------------------------------
$sql = New-SqlConnection
if ($Reset) {
    Write-Host "Resetting staging.RawRow..." -ForegroundColor Yellow
    $clr = $sql.CreateCommand(); $clr.CommandText = 'TRUNCATE TABLE staging.RawRow'; $clr.CommandTimeout = 300
    [void]$clr.ExecuteNonQuery()
}
$staged = @{}
$q = $sql.CreateCommand()
$q.CommandText = 'SELECT SourceTable, COUNT(*) FROM staging.RawRow GROUP BY SourceTable'
$q.CommandTimeout = 300
$r = $q.ExecuteReader()
while ($r.Read()) { $staged[$r.GetString(0)] = [int]$r.GetValue(1) }
$r.Close()
$sql.Close()

$todo = @($tables | Where-Object {
    (-not (& $isExcluded $_)) -and ($staged[$_] -ne $sourceCounts[$_])
})

Write-Host ("Tables to load: {0} (of {1} migratable)" -f $todo.Count, $sourceCounts.Count)
if ($todo.Count -eq 0) {
    Write-Host "Nothing to do - all tables already fully staged." -ForegroundColor Green
    $acc.Close()
    return
}

# ---- Load --------------------------------------------------------------
$grandTotal = 0
foreach ($t in $todo) {
    $expected = $sourceCounts[$t]
    $already = if ($staged.ContainsKey($t)) { $staged[$t] } else { 0 }

    # Partial table: clear it so batch counts stay predictable
    if ($already -gt 0 -and $already -ne $expected) {
        $sqlc = New-SqlConnection
        $del = $sqlc.CreateCommand()
        $del.CommandText = 'DELETE FROM staging.RawRow WHERE SourceTable = @t'
        $del.CommandTimeout = 300
        [void]$del.Parameters.Add('@t', [System.Data.SqlDbType]::NVarChar, 128)
        $del.Parameters['@t'].Value = $t
        [void]$del.ExecuteNonQuery()
        $sqlc.Close()
    }

    $read = $acc.CreateCommand()
    $read.CommandText = "SELECT * FROM [$t]"
    $read.CommandTimeout = 900
    $reader = $read.ExecuteReader()

    $loaded = 0
    $batch = 0
    $sqlc = New-SqlConnection

    $ins = $sqlc.CreateCommand()
    $ins.CommandText = 'INSERT INTO staging.RawRow (SourceTable, SourceRowID, RawJson) VALUES (@t, @id, @j)'
    $ins.CommandTimeout = 300
    [void]$ins.Parameters.Add('@t', [System.Data.SqlDbType]::NVarChar, 128)
    [void]$ins.Parameters.Add('@id', [System.Data.SqlDbType]::NVarChar, 100)
    [void]$ins.Parameters.Add('@j', [System.Data.SqlDbType]::NVarChar, -1)

    $tx = $sqlc.BeginTransaction()
    $ins.Transaction = $tx

    try {
        while ($reader.Read()) {
            $obj = [ordered]@{}
            for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                $val = if ($reader.IsDBNull($i)) { $null } else { $reader.GetValue($i) }
                if ($val -is [datetime]) {
                    $val = $val.ToString('yyyy-MM-ddTHH:mm:ss.fff')
                } elseif ($val -is [decimal] -or $val -is [double] -or $val -is [single]) {
                    $val = $val.ToString('G17', [System.Globalization.CultureInfo]::InvariantCulture)
                }
                $obj[$reader.GetName($i)] = $val
            }
            $json = $obj | ConvertTo-Json -Compress -Depth 5
            $rowId = if ($reader.IsDBNull(0)) { $null } else { [string]$reader.GetValue(0) }

            $ins.Parameters['@t'].Value = $t
            $ins.Parameters['@id'].Value = if ($null -eq $rowId) { [DBNull]::Value } else { $rowId }
            $ins.Parameters['@j'].Value = $json

            Invoke-WithRetry -Context "$t row $($loaded + 1)" -Action { [void]$ins.ExecuteNonQuery() }
            $loaded++
            $batch++

            if ($batch -ge $BatchSize) {
                $tx.Commit()
                $tx.Dispose()
                $tx = $sqlc.BeginTransaction()
                $ins.Transaction = $tx
                $batch = 0
            }
        }
        $tx.Commit()
        $tx.Dispose()
    } catch {
        try { if ($tx.Connection) { $tx.Rollback() } } catch { }
        throw "Failed loading [$t] after $loaded of $expected rows: $($_.Exception.Message)"
    } finally {
        $reader.Close()
        $sqlc.Close()
    }

    $grandTotal += $loaded
    $flag = if ($loaded -eq $expected) { '' } else { '  <-- MISMATCH' }
    Write-Host ("  {0,-38} {1,7} / {2,7}{3}" -f $t, $loaded, $expected, $flag)
}

$acc.Close()
Write-Host ""
Write-Host "Loaded $grandTotal rows across $($todo.Count) tables." -ForegroundColor Green
