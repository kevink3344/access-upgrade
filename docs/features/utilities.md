# Utilities

Batch maintenance jobs that replace the Access macros and action queries. In
Access these were menu items that silently ran an `UPDATE` or `DELETE` across
whole tables; here each one is an explicit, counted, audited action.

- **Plan reference:** [`docs/plans/access-migration.md`](../plans/access-migration.md) §7.2 item 19
- **Route:** `/admin/utilities`
- **Access:** `SUPER_ADMIN` / `ADMIN` only
- **Status:** built (2026-11-25) — see §6 for what shipped and what did not

---

## 1. What Access actually had

Read from `TrainingDatabase.accdb` via DAO: **11 macros** and **54 action
queries** (21 update, 25 append, 3 delete, 5 make-table). The plan's "10 macros
+ action queries" was close but never enumerated them.

### 1.1 Macros

| Macro | Purpose | Keep? |
| --- | --- | --- |
| `mcrRemoveDupParticipants` | Merge one participant into another | **Yes** |
| `mcrResetEmailTeacherParentConfirmations` | Clear `EmailConfirmation` | **Yes** |
| `mcrResetGiftCertificateEmails` | Clear gift-certificate email flags | **Yes** |
| `mcrCurrentWksAttend` | Rebuild current-workshop attendance scratch table | No — obsolete |
| `mcrEmailsToRemove` | Bulk-clear suppressed participant emails | **Yes** |
| `mcrAddWksDatesTimes` | Bulk-add workshop dates/times | No — replaced by the workshop form |
| `mcrRefresh` | Refresh linked tables | No — no linked tables |
| `mcrFolder` | Open folder builder | No — it is a screen |
| `mcrOpen` / `mcrClose` | Startup / shutdown | No — app shell |
| `~TMPCLPMacro` | Access internal | No |

### 1.2 Action queries

Grouped by what they do, not by name.

**Merge duplicates** — `updRemoveDup1/2/3`, `delRemoveDup`
Reassigns `SessionParticipants`, `Registrations` and `CreditSlips` from an old
`ParticipantID` to a new one, then deletes the orphan.

**Reset certificate flags** — `updResetCEU_CHCCertificates`
`UPDATE Participants SET CEUCertificate = No, CHCCertificate = No` — **no
`WHERE` clause**. It clears every participant in the database.

**Reset email confirmations** — `updResetTeacherParentConfirmations`,
`updResetGiftCertificateConfirmations`
Clears the "confirmation sent" flag so mail can be re-sent.

**Backfill end dates** — `updEndDatesfromStartDates`
`SET EndDate = StartDate WHERE EndDate IS NULL AND StartDate IS NOT NULL`.

**Recalculate registration totals** — `updTotalRegistrations`
Recomputes `TotalRegistrations` from `PublicRegistrations + eSchoolRegistered`.

**Purge stale emails** — `updEmailsToRemove`, `delParticipantEmails`
Clears participant emails matched against a suppression list.

**Group ID resolution** — `updGroupCity`, `updGroupStates`,
`updGroupSalutations`, `updGroupStreetTypes`, `updGroupCreditTypes`,
`updGroupPaymentMethod`, `updGroupWorkshops`, `updGroupGetIDs`,
`updGroupParticipantUpdate`
Resolved text values to lookup IDs during bulk import. **Obsolete** — the API
takes IDs directly and validates them.

**Scratch-table plumbing** — `aUpdPaymentTemp*`, `aMak*`, `apdRegistration1-5`,
`apdClient*Email*`, `apdAddDF1-5`, `apdCurrentWksAttend`, `delCurrentWksAttend`,
`makAttendDetails1-Reg`, `makParticipantRegions`, `makPublicRegistrations`
Access used make-table queries as scratch space. **Obsolete** — the new app
does not create temp tables.

---

## 2. The utilities to build

Six. Not all 54.

| # | Utility | Replaces | Risk |
| --- | --- | --- | --- |
| 1 | **Merge duplicate participants** | `mcrRemoveDupParticipants`, `updRemoveDup1/2/3`, `delRemoveDup` | High |
| 2 | **Reset certificate flags** (scoped) | `updResetCEU_CHCCertificates` | High |
| 3 | **Reset email confirmations** | `updResetTeacherParentConfirmations`, `updResetGiftCertificateConfirmations` | Medium |
| 4 | **Backfill end dates** | `updEndDatesfromStartDates` | Low |
| 5 | **Verify registration counts** | `updTotalRegistrations` | Low |
| 6 | **Purge stale emails** | `updEmailsToRemove`, `delParticipantEmails` | High |

### 2.1 Merge duplicate participants

The one that matters. **962 duplicate participant email groups exist today.**

Input: `oldParticipantId`, `newParticipantId`. The job:

1. Reassign `core.Registration.ParticipantID`
2. Reassign `core.SessionParticipant.ParticipantID`
3. Reassign `core.CreditSlip.ParticipantID`
4. Move any `core.CertificateOverride` rows
5. Delete the orphaned participant
6. Write an `audit.UtilityRun` row with before/after counts

Must run in a transaction. Must refuse if the two participants have
registrations for the *same* workshop — that would create a duplicate
enrolment, and Access did not guard against it.

### 2.2 Reset certificate flags

Access cleared every participant with no `WHERE`. Here the scope is explicit:

- Required: school year (and optionally certificate type)
- Shows the affected count before enabling Run
- Confirmation dialog restates the count

### 2.3 Reset email confirmations

Same shape: scope by school year, show the count, confirm.

### 2.4 Backfill end dates

`SET EndDate = StartDate WHERE EndDate IS NULL AND StartDate IS NOT NULL`.
Dry-run first, showing the affected rows. Low risk but still counted.

### 2.5 Verify registration counts

In the new schema the workshop's registered count is **derived** from
`core.Registration`, not stored. So this becomes a verification report rather
than a repair: compare the derived count against any stored total and list
discrepancies. Read-only unless a mismatch is found.

### 2.6 Purge stale emails

Takes an uploaded suppression list (CSV of email addresses), matches against
`core.Participant.Email`, and clears the matches. Shows the match count before
running. Never deletes participants.

---

## 3. Screen design

A card grid, one card per utility.

```
┌──────────────────────────────────────────────────────────┐
│  Merge duplicate participants                    HIGH    │
│  Reassigns registrations, attendance and credit slips    │
│  from one participant to another, then removes the       │
│  duplicate.                                              │
│                                                          │
│  Affects: 962 duplicate groups                           │
│                                    [ Review duplicates ] │
└──────────────────────────────────────────────────────────┘
```

Each card shows:

- Name and one-sentence description
- **Affected row count, computed before Run is enabled** — the single most
  important element on the screen
- Risk badge (`LOW` / `MEDIUM` / `HIGH`) using the pastel badge palette
- A primary action that opens a scoped form, never a bare "Run"

### 3.1 Confirmation

Destructive utilities require typing the affected count into the dialog. That
is deliberately annoying — it is the difference between a tool and a footgun.

### 3.2 Audit

Every run writes to `audit.UtilityRun`:

| Column | Content |
| --- | --- |
| `UtilityKey` | e.g. `merge-participants` |
| `Parameters` | JSON of the inputs |
| `AffectedRows` | Count actually changed |
| `RunBy` | User email |
| `RunAt` | UTC timestamp |
| `Succeeded` | Bit |
| `Error` | Message when failed |

Utilities are also **idempotent where possible** — re-running backfill end dates
changes nothing the second time.

---

## 4. API surface

```
GET  /api/admin/utilities                     # list + affected counts
GET  /api/admin/utilities/participants        # participant picker for the merge
GET  /api/admin/utilities/school-years        # years + duplicate counts for the dropdown
GET  /api/admin/utilities/duplicate-participants   # groups sharing an email (?schoolYearId=)
GET  /api/admin/utilities/negative-payments        # review list
GET  /api/admin/utilities/registrations-no-workshop # review list
POST /api/admin/utilities/merge-participants/preview  # dry run, returns count + token
POST /api/admin/utilities/merge-participants/run      # execute, requires the token
GET  /api/admin/utilities/runs                # audit history
```

`preview` returns a short-lived token that `run` must echo back. This prevents a
stale count from being used to authorise a different-sized change. The token
also carries a fingerprint of the row counts, so a merge that was previewed
before someone else fixed a row is refused with `409 stale_preview` rather than
running against numbers nobody saw.

All endpoints require `SUPER_ADMIN` or `ADMIN`. Reports and lists are read-only;
only `merge-participants/run` writes.

---

## 5. Acceptance criteria

- Every utility shows its affected row count before it can be run.
- No utility can run without an explicit confirmation that restates the count.
- Every run is recorded in `audit.UtilityRun` with the acting user.
- Merge duplicates refuses to proceed when both participants share a workshop.
- Reset certificate flags cannot run unscoped.
- Re-running backfill end dates twice changes nothing the second time.

---

## 6. What shipped (2026-11-25)

The screen is one page with a tab per tool, because staff work through a
backlog and move between them. The merge opens in a drawer so the list it came
from stays put.

| Tool | Mode | What it does |
| --- | --- | --- |
| **Duplicate participants** | review → merge | Groups participants by normalised email, scoped to a school year (see §6.1), picks the busiest record to keep by default, and offers a merge per duplicate. |
| **Merge two participants** | action | Source/target picker, preview, then type-the-count confirmation. |
| **Negative payments** | review | Every registration with `PaidAmount < 0`, split by whether the registration is cancelled. |
| **Registrations with no workshop** | review | Every registration with `WorkshopID IS NULL`, with the payment it carries. |

### 6.1 Participants by year

The whole backlog is **937 duplicate groups** and almost all of it is history
nobody will merge. The Duplicate participants tab therefore opens on the
**newest school year** and offers the rest through a dropdown:

| Year | Groups to review |
| --- | --- |
| 2026-27 | 1 |
| 2025-26 | 6 |
| 2024-25 | 9 |
| 2023-24 | 11 |
| … | … |
| **All years** | 937 |

(Counts as of 2026-11-25; the dropdown computes them live.)

A participant is "in" a year when they hold a registration for a workshop in
it — cancelled registrations included, because the duplicate exists because the
address was reused, not because the enrolment stuck. The filter is applied to
the **participants in a group, not to the groups**: a group is still shown with
every participant on that address, so a merge can never be offered against a
record that is not on screen.

Past years carry a note — "Most duplicates here are history — merge only what
still matters" — and **All years** is labelled as the full historic backlog.

### 6.2 The merge

The order is fixed and runs in one transaction:

1. `Registration.ParticipantID` → target
2. `SessionParticipant` — rows that would collide with the target's own
   attendance are deleted first (the primary key is
   `(ParticipantID, WorkshopSessionID)`), then the rest move
3. `CreditSlip.ParticipantID` and `CreditSlip.UsedParticipantID`
4. `CertificateOverride` — the target's row wins where both exist for the same
   school year and type (the unique key would reject the second)
5. `CertificateIssue.ParticipantID`
6. The target's `HasCeuCertificate` / `HasChcCertificate` flags become the OR of
   both, so a certificate issued to the duplicate is not lost
7. The source participant is deleted **only when nothing points at it any more**

**Refusals.** The merge refuses with `409 shared_workshop` when both
participants have an active registration for the same workshop — that would
create a duplicate enrolment, which Access never guarded against. It refuses
with `409 stale_preview` when the counts changed since the preview, or when the
token was not issued by this process (a restart invalidates every token, which
is the safe direction).

**Drops are reported, not silent.** Attendance and override rows that would
collide are counted in the preview's `blockers.notes` and shown before the run.

### 6.3 Audit

`audit.UtilityRun` (migration `028`) records every attempt, including refusals —
"we tried and it was blocked" is the question asked later. A failed audit write
is logged and swallowed: it must never turn a refused merge into a `500`.

### 6.4 Not built

- **Reset certificate flags**, **reset email confirmations**, **backfill end
  dates**, **verify registration counts** and **purge stale emails** from §2 are
  not built. They are the same preview-then-run shape as the merge and belong in
  the same page when they are needed.
- **Resolving a negative payment** is a link to the registration, not an edit
  here. Money changes go through the Payments screen so they are audited there.
- **Resolving an orphan registration** is a link to the Registrations screen.
- **Merge tokens are in memory.** Correct for one App Service instance; a
  restart simply means previewing again. If the app ever scales out, the token
  store needs to move to the database.
- **`audit.UtilityRun` must exist before the screen works.** Migration `028` is
  applied to test and production by hand, like every other migration. On
  production the deploy login cannot create objects in `audit` (it is not
  `db_ddladmin` there), so the table has to be created once by an `db_owner`
  login — see [the completion record](../completions/2026-11-25-utilities-screen.md) §6.
  Until then the screen works but records no runs: the audit write and the
  history read are both guarded.
