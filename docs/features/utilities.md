# Utilities

Batch maintenance jobs that replace the Access macros and action queries. In
Access these were menu items that silently ran an `UPDATE` or `DELETE` across
whole tables; here each one is an explicit, counted, audited action.

- **Plan reference:** [`docs/plans/access-migration.md`](../plans/access-migration.md) §7.2 item 19
- **Route:** `/admin/utilities`
- **Access:** `SUPER_ADMIN` / `ADMIN` only
- **Status:** not built

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
POST /api/admin/utilities/:key/preview        # dry run, returns count + sample
POST /api/admin/utilities/:key/run            # execute, requires confirmation token
GET  /api/admin/utilities/runs                # audit history
```

`preview` returns a short-lived token that `run` must echo back. This prevents a
stale count from being used to authorise a different-sized change.

---

## 5. Acceptance criteria

- Every utility shows its affected row count before it can be run.
- No utility can run without an explicit confirmation that restates the count.
- Every run is recorded in `audit.UtilityRun` with the acting user.
- Merge duplicates refuses to proceed when both participants share a workshop.
- Reset certificate flags cannot run unscoped.
- Re-running backfill end dates twice changes nothing the second time.
