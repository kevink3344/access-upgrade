# Completion — Participants Screen

**Date:** 2026-11-20
**Status:** ✅ Complete and verified end-to-end
**Route:** `http://localhost:5180/participants` · API: `/api/participants`

---

## 1. What was built

The last of the three high-traffic screens — and the one that closes the data-entry loop.

| Artifact | Purpose |
| --- | --- |
| [`apps/web/src/pages/ParticipantsPage.tsx`](../../apps/web/src/pages/ParticipantsPage.tsx) | List, search, agency filter, sortable columns |
| [`apps/web/src/components/ParticipantDrawer.tsx`](../../apps/web/src/components/ParticipantDrawer.tsx) | Create/edit with **live duplicate detection** |
| [`apps/api/src/routes/participants.ts`](../../apps/api/src/routes/participants.ts) | `POST`, `PATCH`, `DELETE`, `check-duplicate` added |

**26 documented paths** total.

---

## 2. The duplicate-email problem

The migration found **962 duplicate email groups** in the legacy data. This screen is the first place that stops the problem growing.

**How it works:** as staff type an email (or a first + last name), a debounced call to `/api/participants/check-duplicate` looks for matches. If any are found, a warning appears above the form showing:

- The matching person's name, email, and agency
- How many registrations they already have
- Whether the match was on **email** or **name**

The warning is dismissible — staff may legitimately need to add a second "Jane Smith" — but it makes the consequence explicit: *"creating a second record for the same person splits their registration history."*

**Matching is case-insensitive on email**, so `Kenyajones0307@` and `kenyajones0307@` are recognised as the same person. That was the exact case that made the migration's duplicate count 32 rather than 29.

---

## 3. API

| Method | Path | Roles |
| --- | --- | --- |
| `GET` | `/api/participants` | any |
| `GET` | `/api/participants/:id` | any |
| `GET` | `/api/participants/:id/registrations` | any |
| `GET` | `/api/participants/check-duplicate` | any |
| **`POST`** | `/api/participants` | Admin, Manager, Editor |
| **`PATCH`** | `/api/participants/:id` | Admin, Manager, Editor |
| **`DELETE`** | `/api/participants/:id` | Admin only |

### Guards

| Rule | Response |
| --- | --- |
| First or last name required | **422** |
| Invalid email format | **422** |
| Delete blocked when registrations, credit slips, or attendance exist | **409** with counts |
| Empty email string stored as `NULL`, not `''` | — |

---

## 4. Cross-links

| From | To |
| --- | --- |
| Participant row → registration count | `/registrations?participantId=<id>` — filtered list with a clearable chip |
| Participant drawer → registration list | Each registration links to `/registrations?edit=<id>` |
| Registrations page → participant | Existing behaviour |

The registrations page now honours `?participantId=` and shows a **"Filtered to one participant"** chip with a Clear button, so the filter is never invisible.

---

## 5. Verification

| Test | Result |
| --- | --- |
| List renders | ✅ 25 rows, 14,403 total, "Page 1 of 577" |
| Search | ✅ |
| Agency filter | ✅ 200 agencies loaded |
| Sort by name/email/agency | ✅ |
| **Duplicate warning fires** | ✅ Kenya Surles, matched on email, 2 registrations |
| Warning clears on unique email | ✅ |
| Create | ✅ 14,403 → 14,404 |
| Edit — values load correctly | ✅ |
| Edit — save | ✅ |
| Delete with confirmation | ✅ 14,404 → 14,403 |
| Delete guard (has registrations) | ✅ 409 |
| Validation (empty body) | ✅ 422 |
| Registration count link → filtered list | ✅ chip shown, 1 result |
| Test data cleanup | ✅ 0 test rows remain |

---

## 6. Bugs found and fixed

**Route ordering, for the third time.** `check-duplicate` was appended after `/:id`, so it matched as an ID. Moved before the parameterised route.

This has now happened on three routers. It's a systematic hazard of hand-ordered Express routes — worth a lint rule or a route-registration helper that sorts static paths before parameterised ones.

**`$PID` is a reserved PowerShell variable.** A test script failed with *"Cannot overwrite variable PID"*. Renamed to `$newId`. Test-harness issue only, not product code.

**Missing `agencies` API client.** The participant drawer needs an agency picker; the client method didn't exist. Added, with `AgencyRow` / `AgencyListResponse` types.

---

## 7. Not built

- **Agency create/edit from the participant drawer.** The picker lists existing agencies; adding a new one requires the Agencies screen.
- **Merge tool for existing duplicates.** The 962 legacy groups are still there — the warning prevents new ones but does not clean up old ones. Plan §11 open question 3.
- **Bulk import.** No CSV upload.
- **Tests.** Manual verification only.

---

## 8. Suggested next steps

1. **Payments screen** — registrations reference a `PaymentID` that nothing creates yet, so receipts and reconciliation don't work end to end.
2. **Attendance grid** — the phone-first screen from plan §4.1, and the first real test of the mobile requirement.
3. **Duplicate merge tool** — 962 legacy groups remain; staff will want to resolve them.
