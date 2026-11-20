# Migrations

Numbered, guarded `ALTER` scripts for changing objects that already exist.

`db/schema.sql` only creates objects that are absent — it cannot change a table that already
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

2. **Apply to test, then production.** Both, in the same change.

3. **Update `db/schema.sql`** so a from-scratch build produces the same result.

4. **Verify:**

   ```powershell
   powershell -File db/etl/compare-schema.ps1
   ```

   Must report `NO DRIFT`.

See [docs/features/schema-environments.md](../../docs/features/schema-environments.md).
