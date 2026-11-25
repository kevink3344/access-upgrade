# Migrations

Numbered, guarded `ALTER` scripts for changing objects that already exist.

`db/schema.sql` only creates objects that are absent - it cannot change a table that already
exists. Anything that alters a live object belongs here.

## Naming

```
NNN-short-description.sql
```

Examples: `001-add-participant-pronouns.sql`, `002-widen-agency-name.sql`.

## Rules

1. **Guard every statement** so the file is safe to re-run:

   ```sql
   IF COL_LENGTH('core.Participant', 'Pronouns') IS NULL
       ALTER TABLE core.Participant ADD Pronouns NVARCHAR(50) NULL;
   ```

2. **Apply to test, then production - both, in the same change, without being asked.**

   ```powershell
   # test first, then production - a migration is not finished until both have it
   powershell -File db/etl/apply-migration.ps1 -File db/migrations/NNN-name.sql -Env test
   powershell -File db/etl/apply-migration.ps1 -File db/migrations/NNN-name.sql -Env prod
   ```

   Production must never be left behind the test database. A schema change that
   only reaches test is a deployment waiting to fail: the code ships and the
   column it reads is not there.

3. **Update `db/schema.sql`** so a from-scratch build produces the same result.

4. **Verify:**

   ```powershell
   powershell -File db/etl/compare-schema.ps1
   ```

   Must report `NO DRIFT`.

See [docs/features/schema-environments.md](../../docs/features/schema-environments.md).
