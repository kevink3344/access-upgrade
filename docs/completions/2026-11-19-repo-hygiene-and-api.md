# Completion — Repository Hygiene, Data Corrections, API Specification

**Date:** 2026-11-19
**Status:** ✅ Complete

---

## 1. `.gitignore` — secrets blocked before publish

**[`.gitignore`](../../.gitignore)** created. Verified against a real `git add --dry-run`: the two sensitive files are ignored and everything else tracks normally.

| Blocked | Rule | Why |
| --- | --- | --- |
| `database/.env.example` | explicit | Holds a **live `db_owner` password** — not a template |
| `database/TrainingDatabase.accdb` | `database/*.accdb` | 44 MB of real participant data |
| `.env`, `database/.env.*` | env patterns | Standard secret hygiene |
| `node_modules/`, `dist/`, `coverage/` | build output | — |
| `*.log`, `db/etl/output/` | ETL output | — |
| `.vscode/`, `.idea/`, `Thumbs.db` | editor/OS | — |

> **Still recommended:** rotate the SQL password. `.gitignore` prevents one leak path (committing it), not the others — the value has appeared in plaintext in the file, in this transcript, and in shell history. Rotation costs minutes in the Azure portal.

The temporary git repository used to verify the rules was removed; the workspace is not under version control, so you can initialise it however you prefer.

---

## 2. Invalid agencies → "Unknown"

A reserved `core.Agency` row (ID **0**) now exists:

```
AgencyID=0  AgencyName='Unknown'  AgencyShortName='Unknown'
```

**The 36 board members** previously pointing at non-existent agencies (IDs 5 and 31) are re-pointed at it rather than nulled, so they stay attributable and appear in reports under a visible heading.

| | Before | After |
| --- | --- | --- |
| `BoardMember` with `AgencyID = 0` | 0 | **36** |
| `BoardMember` with `NULL AgencyID` | 36 | **0** |
| `core.Agency` rows | 811 | **812** |

**Deliberately not changed:** the 5,347 participants with `NULL AgencyID`. Those are legitimate individuals (parents, independent attendees) who belong to no agency — not invalid references. Pointing them at "Unknown" would misrepresent them as belonging to an organisation.

---

## 3. Inverted workshop date ranges — 9 fixed

All 9 rows where `StartDate > EndDate` are corrected, derived from the **authoritative session dates** in `core.WorkshopSession`, not guessed.

| ID | Code | Before | After | Reason |
| --- | --- | --- | --- | --- |
| 62 | TDR1009 | 10/25 → 10/24/2010 | 10/27 → 10/27/2010 | Session is 10/27; both dates were off |
| 143 | TPS0801 | 10/15/2008 → 05/21/2008 | 10/15/2008 → **05/21/2009** | End date missing the year |
| 803 | TPB1211 | 10/18/2012 → 10/25/**2010** | 10/18/2012 → 10/25/**2012** | Year typo in EndDate |
| 1588 | TDB1320 | 10/17 → 10/13/2013 | 10/17 → **10/17**/2013 | EndDate should match session |
| 1879 | TDS1614 | **10/27** → 10/23/2015 | **10/23** → 10/23/2015 | StartDate should match session |
| 1919 | TPB1700E | 04/05 → 03/08/2017 | 04/05 → **04/05**/2017 | EndDate was an earlier session |
| 1942 | TPB1700C | 02/08 → 01/11/2017 | 02/08 → **02/08**/2017 | EndDate was an earlier session |
| 1950 | TPB1700D | 03/08 → 02/08/2017 | 03/08 → **03/08**/2017 | EndDate was an earlier session |
| 2933 | TVB2700 | 09/22/2026 → 04/26/**2026** | 09/22/2026 → 04/27/**2027** | Year typo; last session is 2027 |

All 9 original values are preserved in `audit.ChangeLog` (`ChangedBy = 'etl:date-fix'`) and can be reversed.

**With the data clean, `CK_Workshop_Dates` is now enforced:**

```sql
CHECK (EndDate IS NULL OR StartDate IS NULL OR EndDate >= StartDate)
```

This was deferred in `schema.sql` precisely because the 9 bad rows would have blocked it. Inverted ranges remaining: **0**.

---

## 4. Plan updated — full REST API with Swagger UI

Plan §7.3 replaced the representative endpoint sketch with a complete API specification:

| Section | Contents |
| --- | --- |
| **7.3.1 Contract-first** | OpenAPI 3.1 authored from Zod schemas; spec is the source of truth |
| **7.3.2 Full CRUD** | 18 resources, each with `GET`/`POST`/`GET :id`/`PATCH :id`/`DELETE :id` |
| **7.3.3 Conventions** | Pagination, filtering, sorting, `PATCH` semantics, soft delete, `422` shape, `If-Match`, idempotency, audit |
| **7.3.4 Non-CRUD** | Link rotation, close registration, redeem slip, receipt PDF, reports, mailing lists, utilities |
| **7.3.5 Public endpoints** | `/api/public/*`, no auth, rate-limited |
| **7.3.6 Docs surfaces** | Swagger UI at `/swagger`, Scalar at `/docs`, spec at `/openapi.json` |
| **7.3.7 Acceptance** | Spec validates in CI; generated client compiles with zero `any`; "Try it out" works end-to-end |

Also added to §3.2 (technology table) and to Phase 0 / Phase 2 delivery.

**Why contract-first:** the frontend, the public form, and future integrations all consume the same contract. Generating the spec from code means a renamed field silently breaks consumers; writing it first means the compiler catches it.

**Generic lookup route:** `GET/POST /api/lookups/:name` serves all 28 `ref.*` tables, so adding a lookup needs no new endpoint.

---

## 5. Verification

| Check | Result |
| --- | --- |
| `.gitignore` blocks `database/.env.example` | ✅ verified with `git check-ignore` |
| `.gitignore` blocks `*.accdb` | ✅ verified |
| Inverted date ranges | ✅ 0 remaining |
| `CK_Workshop_Dates` enforced | ✅ present |
| `BoardMember` NULL agencies | ✅ 0 (36 on "Unknown") |
| `core.Agency` | 812 (811 + Unknown) |
| `core.Participant` | 14,403 |
| `core.Workshop` | 2,599 |
| `core.Registration` | 41,341 |
| FKs enforced / untrusted | 75 / 0 |
| `SUM(PaidAmount)` | 1,789,889.8027 (unchanged) |
| Negative payments | 189 (unchanged) |
| Legacy workshop registrations | 78 (unchanged) |
| Quarantined | 259 (unchanged) |
| Transform idempotent | ✅ 16 batches, 0 errors |

All changes were made in [transform.sql](../../db/etl/transform.sql) rather than patched directly, so they survive a re-run.

---

## 6. Deferred

- **Recharts** — noted in the plan (§8.5) but not built. Requires backend aggregation endpoints plus frontend chart components; deferred as agreed.
- **259 quarantined rows** — still awaiting staff review, particularly the 184 registrations with orphan payees ($4,438.00).

---

## 7. Outstanding risk

The credential in `database/.env.example` remains unrotated. It is now gitignored, but it has been transmitted in plaintext and should be rotated before the repository is shared.
