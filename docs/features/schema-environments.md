# Schema changes — production and test

There are two databases and **both must be kept in step**:

| | Server | Database | Purpose |
| --- | --- | --- | --- |
| Production | `wcpsssqlelasticpool` | `project-enlightenment` | Live data, staff's real records |
| Test | `wcpss-sql-serverless-freetier` | `project-enlightenment-test` | Staff training and testing |

Connection details live in `apps/api/.env` — production under `AZURE_SQL_*`, test under
`AZURE_SQL_*_TEST`. Both files are gitignored.

---

## The rule

**Every schema change is applied to both databases, in the same change, and verified.**

A change that lands in only one place is drift, and drift is how the two environments stop
being comparable — which defeats the point of having a test database at all.

## `db/schema.sql` is safe to run anywhere

`schema.sql` is **idempotent and non-destructive**. It creates every object only if it does
not already exist, so running it against a populated database changes nothing. It is safe
against production.

It is **not** a migration tool. If an object already exists, `schema.sql` skips it — so
editing a `CREATE TABLE` in that file does nothing to a database that already has the table.
To change an existing object, write a targeted `ALTER` in `db/migrations/` and apply it to
both databases.

## Making a change

1. **Write a migration.** Add a numbered file to `db/migrations/`, e.g.
   `db/migrations/001-add-participant-pronouns.sql`. Use guarded `ALTER` statements so it is
   safe to re-run:

   ```sql
   IF COL_LENGTH('core.Participant', 'Pronouns') IS NULL
       ALTER TABLE core.Participant ADD Pronouns NVARCHAR(50) NULL;
   ```

2. **Apply to test first**, then verify the app still works there.

3. **Apply to production.**

4. **Update `db/schema.sql`** so a from-scratch build matches. This keeps the DDL file
   authoritative for new environments.

5. **Run the drift check** — it must report `NO DRIFT`:

   ```powershell
   powershell -File db/etl/compare-schema.ps1
   ```

### The schema files

| File | Contains |
| --- | --- |
| `db/schema.sql` | The 66 migrated tables, constraints, indexes, and views — idempotent |
| `db/auth.sql` | `core.AppUser`, `core.RefreshToken`, `audit.LoginAttempt` |
| `db/public-registration.sql` | `core.WorkshopRegistrationLink`, `audit.PublicSubmission`, role-answer columns |

## Rebuilding the test database

Copies schema and all data from production. Production is read-only in this operation.

```powershell
# Full copy (wipes and reloads the test database)
powershell -File db/etl/copy-database.ps1 -Force

# Schema only, no data
powershell -File db/etl/copy-database.ps1 -Force -SchemaOnly
```

The script refuses to run if source and target resolve to the same database, and refuses to
overwrite a non-empty target without `-Force`.

> **Note:** the test server is serverless and auto-pauses when idle. The first connection
> after a pause can time out; simply re-run, or wake it with
> `sqlcmd -Q "SELECT 1" -l 60`.

## How the copy works

Azure SQL cannot run cross-server `INSERT..SELECT`, so the copy uses `bcp`:

1. Verify the target is empty (or wipe it with `-Force`)
2. Apply the three DDL files
3. Disable foreign keys on the target
4. For each of the 70 tables: `bcp out` to a native-format file, `bcp in` with `-E` so
   **identity values are preserved** (legacy IDs matter — `WorkshopID` 3023 is `TDB2717`)
5. Re-enable foreign keys `WITH CHECK` and confirm none are untrusted
6. Compare exported vs imported row counts per table

## Verification gates

A copy is not done until these pass:

| Gate | Expected |
| --- | --- |
| Row counts, all 70 tables | exported == imported |
| `SUM(Registration.PaidAmount)` | `1789889.8027` |
| `SUM(Payment.PaymentTotal)` | `329409.2800` |
| `MAX(RegistrationID)` | `767304` |
| Foreign keys disabled or untrusted | `0` |
| Drift check | `NO DRIFT` |

The financial totals are the important one. Row counts can match while money is wrong.

## Why constraint names are ignored by the drift check

`compare-schema.ps1` compares foreign keys by **shape** (child table → parent table →
column), not by name. When DDL omits a constraint name, SQL Server generates one — so the
same logical schema built twice produces different names (`FK_Agency_City` vs
`FK__Agency__CityID__190BB0C3`). Comparing names would report 73 false positives on an
identical schema.

## Current state

As of 2026-11-20:

- Test database built from `db/schema.sql` + `db/auth.sql` + `db/public-registration.sql`
- 70 tables, 269,275 rows copied
- All verification gates pass
- Drift check: 678 schema objects identical

### A note on `db/schema.sql`

Before this copy, `schema.sql` alone did **not** reproduce production. Three objects were
missing because they were only created by `db/etl/transform.sql` after the data load:

- `FK_Registration_Participant`
- `FK_Registration_Workshop`
- `CK_Workshop_Dates`
- `core.vw_NegativePayment`

These have been moved into `schema.sql` so the DDL file is authoritative. `transform.sql`
still re-applies them, which is harmless.

`schema.sql` was also rewritten to be non-destructive: it previously dropped every object
before recreating it, which would have wiped production if run there. All 66 tables, 21
indexes, 5 constraints, and 3 views are now created only when absent.
