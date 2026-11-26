# Completion — Utilities screen

**Date:** 2026-11-25
**Status:** ✅ Complete and verified — both databases in step
**Spec:** [docs/features/utilities.md](../features/utilities.md)

---

## 1. What was built

The three tools asked for, on one screen at Settings > Utilities:

| Tool | Behaviour |
| --- | --- |
| **Duplicate participants** | Participants grouped by normalised email, **scoped to a school year** (newest by default, with a dropdown), with linked-record counts, a radio to choose which record to keep, and a merge button per duplicate. |
| **Negative payments** | Every registration with `PaidAmount < 0`, split by cancelled vs active, with a link to the participant. |
| **Registrations with no workshop** | Every registration with `WorkshopID IS NULL`, with the payment it carries and a link to open the registration. |
| **Merge two participants** | The action behind the duplicate groups: source/target pickers, preview, type-the-count confirmation. |

### Participants by year

The full backlog is 937 groups, and almost none of it is work anyone will do.
The tab opens on the newest school year and offers the rest:

| Year | Groups to review |
| --- | --- |
| 2026-27 | 1 |
| 2025-26 | 6 |
| 2024-25 | 9 |
| 2023-24 | 11 |
| 2022-23 | 16 |
| 2021-22 | 18 |
| … | … |
| All years | 937 |

A participant counts as "in" a year when they hold a registration for a
workshop in it (cancelled included — the address was reused either way). The
filter narrows the *participants* in a group, never the group itself, so a
merge is never offered against a record that is not on screen.

| Artifact | Purpose |
| --- | --- |
| [`db/migrations/028-utility-runs.sql`](../../db/migrations/028-utility-runs.sql) | `audit.UtilityRun` + index |
| [`apps/api/src/routes/utilities.ts`](../../apps/api/src/routes/utilities.ts) | 9 documented endpoints under `/api/admin/utilities` |
| [`apps/api/src/services/utilities.ts`](../../apps/api/src/services/utilities.ts) | Queries, preview/run, blockers, audit |
| [`apps/web/src/pages/UtilitiesPage.tsx`](../../apps/web/src/pages/UtilitiesPage.tsx) | The screen |
| [`apps/web/src/components/MergeParticipantsDrawer.tsx`](../../apps/web/src/components/MergeParticipantsDrawer.tsx) | The merge flow |
| [`apps/web/src/styles/ui-utilities.css`](../../apps/web/src/styles/ui-utilities.css) | Styles (imported from `ui.css`) |
| [`apps/api/test/utilities.test.ts`](../../apps/api/test/utilities.test.ts) | 16 tests |

---

## 2. Safety rules implemented

- **The merge cannot run without a preview.** The preview issues a token bound
  to the exact pair and a fingerprint of the row counts; `run` refuses with
  `409 stale_preview` if either changed.
- **Shared workshops block the merge.** Two active registrations on the same
  workshop would become a duplicate enrolment, so the run refuses and names the
  workshops.
- **Collisions are reported, not silently dropped.** Attendance and certificate
  override rows that would violate a key are counted in the preview.
- **The source is deleted only when nothing points at it.** The delete is
  guarded by a re-count inside the transaction, so a table added later cannot
  half-apply a merge.
- **Every attempt is audited**, including refusals.

---

## 3. A SQL bug caught by the tests

The duplicate-groups query reused the shared `PARTICIPANT_SELECT` fragment and
ordered by its alias `RegistrationCount`. SQL Server rejects that: *"Invalid
column name 'RegistrationCount'"* — an alias used in `ORDER BY` cannot share a
name with a column inside a subquery in the select list. The fragment is now
inlined for that one query with the ordering expressed as a subquery.

A second bug surfaced at the same time: `SELECT 1 FROM … GROUP BY …` inside
`COUNT(*)` produced *"No column name was specified for column 1"*. Both were
500s on the overview and the duplicate list.

---

## 4. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (shared, api, web) | ✅ clean |
| `npm test` | ✅ 161 passed (was 145; +16 utilities) |
| `npm run build --workspace=@pe/web` | ✅ built |
| `/api/admin/utilities` unauthenticated | ✅ 401 |
| `/api/admin/utilities/school-years` unauthenticated | ✅ 401 |
| OpenAPI spec | ✅ all 9 utility paths present, `schoolYearId` documented |
| Migration 028 on test database | ✅ `audit.UtilityRun created` |
| `audit.UtilityRun` on production | ✅ created, `SELECT`/`INSERT` granted to the writer |
| Production audit insert (rolled back) | ✅ succeeded, 0 rows left behind |
| `compare-schema.ps1` | ✅ `NO DRIFT — 959 schema objects identical` |

The merge itself is **not** executed by the suite: the shared test database is
used for staff training and every test is read-only. The tests pin what decides
whether a merge is allowed (preview, blockers, token, audit of a refusal).

---

## 5. Assumptions made

- **The busiest record is the default "keep".** It has the history, so merging
  into it moves the least. Staff can pick another row.
- **Negative payments are read-only here.** The sign convention is still an open
  question in the migration plan (§11 #4); the screen surfaces the rows and
  links to the registration rather than guessing at a fix.
- **Orphan registrations are read-only here.** Resolving one means choosing a
  workshop, which belongs on the Registrations screen where the change is
  audited.

---

## 6. Resolved: migration 028 on production

Applied to the **test** database without trouble. On **production** it failed:

```
Msg 2760: The specified schema name "audit" either does not exist or you do not
have permission to use it.
```

The production deploy login (`wcpss-sql-writer`) is not `db_ddladmin` there —
unlike test — so it can create tables in `core` but not in `audit`. That is a
permissions gap, not a problem with the migration: the same file succeeded on
test unchanged.

A first attempt to close it with `GRANT ALTER ON SCHEMA::audit` landed on
`dbo` instead — the catalog showed the grant on schema id 1 (`dbo`) while
`audit` is id 7 — so the migration still failed. The cause was the statement
running outside the `project-enlightenment` context.

**Resolved** by creating the table once as `db_owner` and granting only what
the app uses, which is narrower than giving the writer DDL anywhere:

```sql
USE [project-enlightenment];
GO
CREATE TABLE audit.UtilityRun ( … );          -- same DDL as migration 028
CREATE INDEX IX_UtilityRun_Key_RunAt ON audit.UtilityRun(UtilityKey, RunAt DESC);
GO
GRANT SELECT, INSERT ON audit.UtilityRun TO [wcpss-sql-writer];
GO
```

Verified afterwards, from the app's own login:

| Check | Result |
| --- | --- |
| `OBJECT_ID('audit.UtilityRun')` | ✅ exists |
| `SELECT` / `INSERT` on the table | ✅ granted |
| Insert with default `RunAt`, inside a rolled-back transaction | ✅ succeeded, 0 rows left behind |
| `compare-schema.ps1` | ✅ `NO DRIFT — 959 schema objects identical` |

The migration file is guarded, so running it on production now reports
`already exists` and changes nothing — the two databases stay in step.

The audit write and the history read remain guarded in code, so a database
without the table logs a warning and records nothing rather than failing the
page. That is a safety net, not the operating state.
