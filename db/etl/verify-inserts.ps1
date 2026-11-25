# =====================================================================
#  verify-inserts.ps1
#
#  Runs the application's create statements against BOTH databases inside a
#  transaction that is always rolled back, and fails if any of them works on
#  one database but not the other.
#
#  Why this exists: compare-schema.ps1 proves the two schemas match, but not
#  that the code matches the schema. Migration 025 added IDENTITY to
#  Participant and Registration on test only. The code omitted the id, which
#  passed on test and failed in production with "Cannot insert the value
#  NULL" - and once production was migrated, the same code failed on both
#  with "Cannot insert explicit value for identity column". A schema check
#  alone would not have caught either half.
#
#  Nothing is written: every statement runs inside a rollback.
#
#  Usage:
#    powershell -File db/etl/verify-inserts.ps1
# =====================================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$runner = Join-Path $PSScriptRoot 'verify-inserts.mjs'

if (-not (Test-Path $runner)) { throw "Missing $runner" }

Push-Location (Join-Path $repoRoot 'apps\api')
try {
    node $runner
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
