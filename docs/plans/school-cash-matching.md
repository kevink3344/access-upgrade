# School Cash Online — Matching Registrants to Payments

**From:** Payments are typed in by hand, one registration at a time
**To:** An admin uploads the daily School Cash CSV, reviews what matched, resolves the rest by hand, and applies the result — with a permanent history of every run
**Prepared:** 2026-11-24
**Status:** Draft for review — decisions in §11 need sign-off before Phase 1

**Related:** [School Cash integration plan](./schoolcash-integration.md) (the *automated* SFTP pipeline — a different, later step) · [Public registration](../features/public-registration.md) · [Payments](../features/public-registration.md)

---

## 1. Executive summary

This is **not** the automated SFTP pipeline in [schoolcash-integration.md](./schoolcash-integration.md). That plan waits on vendor access and a paid Bulk Fee Export. This one starts from the file staff **already download by hand today** — `database/ItemOrderReport_*.csv` — and turns the reconciliation into a screen.

The workflow staff asked for:

```
Upload CSV  →  Match  →  Review  →  Resolve manually  →  Apply  →  History
```

**Effort estimate: 2–3 weeks.**

### 1.1 What the real CSV actually contains

Measured against `database/ItemOrderReport_1793719554413.csv` (98 rows, 28 columns). Only the columns this feature uses are listed:

| Column | Present? | Note |
| --- | --- | --- |
| `Purchaser Email` | **Yes, 98/98** | The only reliable identity key |
| `Purchaser Name` | Yes | "Barber, Bria" — surname first |
| `Recipient Name` | Yes | Often a school name, not a person |
| `Item Id` / `Item Name` | Yes | e.g. "A Full Center Guided Observation - Appleseeds" |
| `Paid Amount` | Yes | Gross charge: item price + online fee ($312 for a $300 item) |
| `Paid Item Balance` | Yes | The item price alone ($300) |
| `Paid Transaction Fee` | Yes | The online fee alone ($12) |
| `Purchased` | Yes | The date the purchase was made |
| `Owing`, `Refunded`, `Waived`, `Refund in Progress` | Yes | Always present, usually `$0.00` |

**This shapes the design.** The existing integration plan proposes matching on a student identifier; this export carries none that is usable. **Matching is driven by purchaser email**, which is a materially weaker key — see §4.

### 1.2 What the data says about feasibility

| Measure | Result |
| --- | --- |
| Distinct purchaser emails in the file | 52 |
| Emails that match an existing participant | **44 (85%)** |
| Emails with no participant | 8 |
| Distinct item names | 36 |
| Item names matching a `WorkshopName` | **13 of 36** |
| Registrations with no payment recorded | **26,612 of 41,346** |

Two conclusions:

1. **Email matching is good but not sufficient.** 85% auto-match leaves 8 rows per file for manual review — acceptable, and exactly why the manual step exists.
2. **Item name cannot identify the workshop.** Only 13 of 36 item names match a workshop name, because the item is a *purchase*, not a *registration*. The workshop must be inferred from the **registration**, not the item name — see §5.2.

---

## 2. Scope

| In scope | Out of scope |
| --- | --- |
| Upload a CSV by hand, one file at a time | Scheduled SFTP polling (that is the other plan) |
| Auto-match rows to registrations | Creating participants from a payment |
| Manual matching for the rest | Editing the CSV before upload |
| Apply matched payments to registrations | Refund processing |
| Permanent history of every run | Reconciling against the merchant settlement report |

---

## 3. The workflow, step by step

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 1. Upload    │──►│ 2. Match     │──►│ 3. Review    │──►│ 4. Apply     │
│  CSV file    │   │  automatic   │   │  + resolve   │   │  payments    │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
                                              │                  │
                                              ▼                  ▼
                                       unmatched rows      history row
                                       wait for a human    (permanent)
```

### 3.1 Upload

Drag-and-drop or file picker on `/admin/schoolcash`. The file is parsed and **staged, not applied**. Nothing touches `core.Payment` until step 4.

Validation at upload:

- Must be a CSV with the header the matcher needs. Only these columns are **required**:

  | Required column | Used for |
  | --- | --- |
  | `Purchaser Email` | Participant matching |
  | `Item Name`, `Item Id` | Evidence shown when a human decides a match |
  | `Paid Item Balance`, `Paid Transaction Fee` | The amounts written to the payment |
  | `Purchased` | Shown on the review screen; the date the payment was made |

  A missing required column is rejected with that column named. Any other column in the file is ignored.
- The file's SHA-256 is checked against history. Re-uploading the same file is refused with *"This file was already imported on 24 Nov 2026 by Kevin Key"* rather than silently duplicating rows.
- Rows are stored verbatim, as text, before any coercion — the same rule the Access ETL follows.

### 3.2 Match

Each row is matched in this order, and the **first** rule that produces exactly one candidate wins:

| # | Rule | Confidence | What it means |
| --- | --- | --- | --- |
| 1 | Purchaser email → participant, **and** exactly one unpaid registration | **High** | Auto-apply |
| 2 | Purchaser email → participant, **several** unpaid registrations, **and** the amount matches exactly one of them | **High** | Auto-apply |
| 3 | Purchaser email → participant, several candidates, amount matches none or several | **Low** | Needs a human |
| 4 | Purchaser email → no participant | **None** | Needs a human |
| 5 | Row already applied (same receipt + payment id) | — | Skipped as a duplicate |

**Rule 2 is the one that does the work.** A parent with two unpaid registrations and one $312 charge is resolved by comparing the **$300 item balance** against each registration's cost — not the $312 gross, which would match nothing (§11.2).

### 3.3 Review

A screen listing every row with its outcome:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Uploaded 24 Nov 2026 10:25 · 98 rows · 44 matched · 8 need review  │
├─────────────────────────────────────────────────────────────────────┤
│ ✓ Matched (44)   ⚠ Needs review (8)   ⊘ Already applied (46)        │
├──────────────┬──────────────────┬────────────┬──────────┬──────────┤
│ Purchaser    │ Item             │ Paid       │ Workshop │ Status   │
├──────────────┼──────────────────┼────────────┼──────────┼──────────┤
│ bria@apple…  │ Guided Obs -     │ $312.00    │ TPB2600  │ ✓ High   │
│              │ Appleseeds       │            │          │          │
│ unknown@…    │ Guided Obs -     │ $468.00    │ —        │ ⚠ Match… │
└──────────────┴──────────────────┴────────────┴──────────┴──────────┘
```

### 3.4 Resolve manually

Clicking a "needs review" row opens a picker:

- Search participants by name or email, pre-seeded with the purchaser name.
- Once a participant is chosen, list **their unpaid registrations** with workshop, date and cost.
- The amount is shown next to each so a $312 payment can be lined up against a $300 item.

The admin picks a registration, or marks the row **Ignore** (a refund, a duplicate, a payment for something outside this system). Ignored rows are recorded with a reason and never applied.

### 3.5 Apply

One button. It writes, in a single transaction:

1. A `core.Payment` row per matched CSV row.
2. `Registration.PaymentID` and `Registration.PaidAmount` on the chosen registration.
3. A status of **Matched** on the staged row.

If any write fails, nothing is applied — a half-applied run is worse than a failed one.

### 3.6 History

Every upload is a permanent row: who uploaded it, when, the file name and hash, how many rows matched automatically, how many were resolved by hand, how many were ignored, and what was applied. Any past run can be opened read-only.

---

## 4. Matching is the hard part

### 4.1 Why email is a weak key

The old integration plan already noted **962 duplicate email groups** among participants. Email alone is not an identity.

Consequences, all handled:

| Problem | Handling |
| --- | --- |
| Two participants share an email | Rule 1 fails (two candidates); falls to rule 2 or manual |
| One participant, several unpaid registrations | Rule 2 resolves by amount; ambiguity goes to manual |
| Purchaser is not the participant | Common — a director pays for a teacher. Manual match handles it; the UI says so |
| Email differs by case or has trailing space | Normalised to lower-case and trimmed before comparing |
| Participant exists but has no unpaid registration | Row is marked "no open registration" — not a match failure, a different state |

### 4.2 What is deliberately never automatic

- **No participant is ever created from a CSV row.** A payment is evidence someone paid, not evidence of who they are.
- **No registration is ever created.** If the payment has no matching registration, it waits for a human.
- **No amount is ever split.** A $312 payment cannot be applied to two $156 registrations; that is a judgement call, not a rule.

### 4.3 The transaction fee — settled

The CSV's `Paid Amount` ($312) includes a 4% online transaction fee; `Paid Item Balance` ($300) is the item price and `Paid Transaction Fee` ($12) is the difference.

**Decision (2026-11-24): separate them.** `PaidAmount` holds the item balance, `FeeAmount` holds the fee. See §11.2 for what that means for reports and for the matcher.

---

## 5. Data model

### 5.1 New tables

> **Implemented in `core`, not `staging`.** The plan originally put these in
> `staging`, alongside the ETL's `staging.RawRow` and `staging.Quarantine`. The
> application login (`wcpss-sql-writer`) has `ALTER` on `core` but no rights at
> all on `staging` in production — `CREATE TABLE staging.*` fails with Msg 2760
> — and granting that needs a database administrator. `core` is the schema the
> app already owns, so the tables live there rather than blocking the feature
> on a permission change. They are still staging *in behaviour*: nothing reads
> them as authoritative, and applying an import is what creates payments.
> If `GRANT ALTER ON SCHEMA::staging TO [wcpss-sql-writer]` is ever run in
> production, they can be moved back with a rename migration.

```sql
-- One row per upload.
core.ScoImport
    ScoImportID    INT IDENTITY PK
    FileName       NVARCHAR(260) NOT NULL
    FileHash       VARBINARY(32) NOT NULL      -- SHA-256, unique
    TotalRows      INT NOT NULL                -- "RowCount" is a T-SQL keyword
    MatchedCount   INT NOT NULL DEFAULT 0
    ReviewCount    INT NOT NULL DEFAULT 0
    IgnoredCount   INT NOT NULL DEFAULT 0
    AppliedCount   INT NOT NULL DEFAULT 0
    Status         NVARCHAR(20) NOT NULL       -- Staged | Applied | Discarded
    UploadedBy     NVARCHAR(200) NOT NULL
    UploadedAt     DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME()
    AppliedBy      NVARCHAR(200) NULL
    AppliedAt      DATETIME2(0) NULL

-- One row per CSV line, kept verbatim as text.
core.ScoRow
    ScoRowID       BIGINT IDENTITY PK
    ScoImportID    INT NOT NULL FK
    RowNumber      INT NOT NULL
    PurchaserEmail NVARCHAR(255) NULL
    PurchaserName  NVARCHAR(255) NULL
    RecipientName  NVARCHAR(255) NULL
    ItemId         NVARCHAR(50)  NULL
    ItemName       NVARCHAR(255) NULL
    PaidAmount     NVARCHAR(50)  NULL          -- gross charge, e.g. $312.00
    ItemBalance    NVARCHAR(50)  NULL          -- item price, e.g. $300.00
    TransactionFee NVARCHAR(50)  NULL          -- e.g. $12.00
    PurchasedDate  NVARCHAR(50)  NULL
    Owing          NVARCHAR(50)  NULL
    Refunded       NVARCHAR(50)  NULL
    RawJson        NVARCHAR(MAX) NULL          -- the whole line, so nothing is lost
    -- What the matcher decided
    MatchedRegistrationID INT NULL
    MatchConfidence NVARCHAR(10) NULL          -- High | Low | None | Duplicate | Ignored
    MatchMethod    NVARCHAR(20) NULL           -- email | email+amount | manual | duplicate
    MatchNote      NVARCHAR(255) NULL
    IgnoreReason   NVARCHAR(255) NULL
    AppliedPaymentID INT NULL
```

**Why `RawJson` as well as named columns:** the Item Order Report has 28 columns and KEV has changed it before. Storing the whole line means a column we did not anticipate is still recoverable without a re-upload. Only the columns listed in §3.1 are parsed.

### 5.2 Why the workshop comes from the registration, not the item

Only 13 of 36 item names match a workshop name. The item is a *purchase* ("A Full Center Guided Observation - Appleseeds"), while the workshop is a *scheduled session* ("Guided Observation of the DPS and FLC", code `TPB2600`).

So the screen shows the workshop **via the matched registration**, and the item name is displayed only as evidence for the human deciding the match.

### 5.3 Additions to existing tables

```sql
ALTER TABLE core.Payment ADD
    Source            NVARCHAR(20) NOT NULL DEFAULT 'Manual',   -- Manual | SchoolCash
    ExternalReceipt   NVARCHAR(100) NULL,
    ExternalPaymentId NVARCHAR(100) NULL,
    FeeAmount         DECIMAL(19,4) NULL;                        -- the 4% online fee

-- Idempotency: the same CSV line can never become two payments.
CREATE UNIQUE INDEX UX_Payment_External
    ON core.Payment(ExternalReceipt, ExternalPaymentId)
    WHERE ExternalReceipt IS NOT NULL;
```

`core.Payment` currently has no source or external-reference columns, so a payment created by this feature is indistinguishable from a typed one. That is the gap this closes.

### 5.4 Status

The request says the registration status becomes **"Matched"** with the amount paid. Today `core.Registration` has no status column — it derives status from `PaidAmount`, `Attended` and `IsCancelled` (see the Registrations screen's `StatusCell`).

Two options:

| Option | Change | Cost |
| --- | --- | --- |
| **A. Derive it** | A registration with a `PaymentID` whose `Source = 'SchoolCash'` shows "Matched" | No schema change; keeps one source of truth |
| B. Store it | Add `Registration.PaymentStatus` | A second truth that can drift from `PaidAmount` |

**Recommendation: A.** The status is a fact about the payment, and the payment already records where it came from.

---

## 6. Screens

### 6.1 `/admin/schoolcash` — upload and history

```
┌──────────────────────────────────────────────────────────────────┐
│ School Cash matching                                             │
│ Upload the daily Item Order Report to match payments.            │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐  │
│  │   Drop the CSV here, or browse                           │  │
│  └────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ Recent uploads                                                   │
│ 24 Nov 2026 · 98 rows · 44 matched · 8 reviewed · Applied        │
│ 23 Nov 2026 · 91 rows · 40 matched · 6 reviewed · Applied        │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 `/admin/schoolcash/:id` — review one upload

Three tabs, matching the three outcomes: **Matched**, **Needs review**, **Ignored / duplicates**. A summary bar shows the counts and the total value.

> **Sample screen:** [`mockups/school-cash-matching.html`](./mockups/school-cash-matching.html) ·
> [`mockups/school-cash-matching.pdf`](./mockups/school-cash-matching.pdf) — built with the app's own
> design tokens and component classes, using amounts from the real Item Order Report.

The **Apply** button is disabled while any row is still in "needs review" — an admin must either resolve or explicitly ignore every row first. That rule prevents the most likely mistake: applying a run that silently skipped half the file.

### 6.3 Manual match picker

A drawer, reusing the existing `Typeahead` component for participant search:

```
┌────────────────────────────────────────────────────────────┐
│ Match payment                                              │
│ Purchaser   unknown@example.org                            │
│ Item        A Full Center Guided Observation - Appleseeds   │
│ Paid        $468.00                                        │
├────────────────────────────────────────────────────────────┤
│ Participant  [ Search by name or email…            ]       │
├────────────────────────────────────────────────────────────┤
│ Unpaid registrations                                       │
│  ○ TPB2600 · Guided Observation · 15 Mar 2027 · $450.00    │
│  ○ TVB2700 · Transition to K    · 22 Mar 2027 · $100.00    │
├────────────────────────────────────────────────────────────┤
│ [ Ignore this row ]                        [ Match ]       │
└────────────────────────────────────────────────────────────┘
```

Note the $468 payment against a $450 registration — the difference is the transaction fee, which is why §4.3 matters.

---

## 7. API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/schoolcash/imports` | Upload a CSV (multipart). Returns the import id and counts |
| `GET /api/schoolcash/imports` | History, newest first |
| `GET /api/schoolcash/imports/:id` | One import with its rows, filterable by confidence |
| `PATCH /api/schoolcash/rows/:rowId` | Set a manual match or ignore a row |
| `POST /api/schoolcash/imports/:id/apply` | Write payments; refuses if any row is unresolved |
| `GET /api/schoolcash/participants/:id/unpaid` | That participant's unpaid registrations, for the picker |

All admin-only (`SUPER_ADMIN`, `ADMIN`), matching the Webhooks screen's gate. Upload is capped at 5 MB — the sample is 27 KB and a year of daily files would still be well under.

---

## 8. Phasing

| Phase | Work | Effort |
| --- | --- | --- |
| **1. Schema + upload** | Migration 016, CSV parse, hash dedupe, history list | 3 days |
| **2. Matcher** | The five rules, confidence, duplicate detection — pure functions, unit-tested | 3 days |
| **3. Review screen** | Table, tabs, counts, filters | 3 days |
| **4. Manual match** | Participant search, unpaid-registration picker, ignore | 2 days |
| **5. Apply** | Transactional write, `core.Payment` columns, derived status | 2 days |
| **6. Polish** | Empty states, error handling, CSV column validation | 1–2 days |

**Total: 2–3 weeks.**

### Testing

- `match.test.ts` — pure matcher against a fixture CSV: the five rules, the ambiguous cases, case/whitespace normalisation, the duplicate key.
- `apply.test.ts` — applying twice is a no-op; a failure mid-apply leaves no partial writes; an unresolved row blocks apply.
- Manual: upload the real `ItemOrderReport_1793719554413.csv`, confirm 44 auto-match and 8 need review.

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Admin applies a run before resolving every row | Medium | High | Apply is disabled while any row is unresolved |
| Same file uploaded twice | High | Medium | SHA-256 unique constraint; refuses with the prior upload's date |
| A payment is applied to the wrong registration | Medium | **High** | High-confidence matches only auto-apply; anything ambiguous needs a human; the whole run is reversible from history |
| Email matching degrades as more families share addresses | Medium | Medium | Rule 2 (amount) and manual review absorb it |
| The CSV format changes | Medium | Medium | Header validated at upload; `RawJson` keeps the original line |
| Fee vs item balance recorded inconsistently | Medium | Medium | Settled in §11.2: balance and fee stored separately, matcher compares against the balance |

---

## 10. What this does not change

- `core.Registration` — no new columns; status stays derived.
- The existing manual payment entry on the Registration drawer.
- The Registrations screen's filters — though a **Source** filter would be a natural follow-on.
- The automated SFTP pipeline in [schoolcash-integration.md](./schoolcash-integration.md); this is the manual predecessor, and the staging tables here are a reasonable foundation if that plan is ever built.

---

## 11. Decisions

### 11.1 Settled (2026-11-24)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Match on purchaser email? | **Yes** — it is the only identity data the export contains |
| 2 | Record the item balance ($300) or the paid amount ($312) as `PaidAmount`? | **Separate the fee.** `PaidAmount` = the item balance ($300), `FeeAmount` = the $12 transaction fee. A payment row therefore reconciles with the merchant statement *and* does not overstate revenue |
| 3 | Should the registration's "Matched" status be derived or stored? | **Derived** from the payment's source (§5.4) |
| 4 | Can one CSV row ever pay for more than one registration? | **No** — a split is a judgement call; use manual entry |
| 5 | What happens to rows that are refunds or out-of-scope payments? | An explicit **Ignore** with a reason, recorded in history |
| 6 | Should an apply be reversible? | **Not automatically**; history is read-only. A correction is a new run |
| 7 | Who may reconcile? | **Admins only.** An admin must resolve or explicitly ignore every row before Apply is enabled — no manager override, no partial apply |

### 11.2 What decision 2 means concretely

The CSV carries both figures, and they differ by the online transaction fee:

| CSV column | Example | Stored as |
| --- | --- | --- |
| `Paid Item Balance` | `$300.00` | `core.Payment.PaymentTotal` → `Registration.PaidAmount` |
| `Paid Transaction Fee` | `$12.00` | `core.Payment.FeeAmount` |
| `Paid Amount` | `$312.00` | Not stored directly; equals the sum of the two |

Consequences:

- **Revenue reports are correct without change.** They sum `PaidAmount` on registrations, which now means the item price rather than the gross charge.
- **Merchant reconciliation still works.** `PaymentTotal + FeeAmount` equals what the district was actually charged.
- **The review screen shows both** — "$300.00 + $12.00 fee" — so an admin matching by amount can see why a $312 charge lines up with a $300 registration.
- **Rule 2 of the matcher compares against the item balance**, not the gross charge. Comparing $312 against a $300 registration would fail on every row.

### 11.3 Decision 7: the Apply gate

Apply is disabled unless **every** row in the run is either matched or explicitly ignored. The button carries the reason when disabled:

> *"8 rows still need review. Match or ignore each one before applying."*

This is deliberately not a warning that can be clicked through. A run applied with unresolved rows would silently leave those payments unrecorded, and nothing on screen would say so afterwards.

---

## 12. Immediate next steps

1. On sign-off, build Phase 1 and 2 together: the matcher is pure and testable, and it decides whether the rest of the screen is pleasant or painful.
2. Review the sample screen in `docs/plans/mockups/school-cash-matching.html` (and the PDF beside it) — it shows the review screen with a mix of high-confidence matches, a row needing review, and an ignored row.
