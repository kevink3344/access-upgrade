# School Cash Online — Payment Data Integration Plan

**From:** Manual payment entry (staff type amounts into `core.Payment` / `core.Registration`)
**To:** Automated ingestion of School Cash Online transaction data
**Prepared:** 2026-11-20
**Status:** Draft for review — **blocked on vendor confirmation** (see §9)

---

## 1. Executive summary

School Cash Online (SCO) is a **KEV Group** product. The question "is there an API or FTP method?" has a specific answer:

| Question | Answer |
| --- | --- |
| **Is there a REST API?** | **No.** No public, partner, or documented outbound API exists. |
| **Is there an FTP method?** | **Yes — SFTP, CSV files.** That is the vendor's sanctioned integration path. |
| **Can we scrape the site?** | **No.** Incapsula/Imperva bot protection plus `robots.txt: Disallow: /`. Technically blocked and a policy violation. |

**Recommendation: build a file-landing-zone ingestion pipeline, not an API poller.**

```
SCO scheduled report  ──►  SFTP / secure location  ──►  poller  ──►  staging  ──►  core.Payment
   (vendor side)              (vendor side)            (ours)      (raw CSV)     (reconciled)
```

Two vendor-sanctioned doors exist, and we should pursue both:

| Path | Cost | Cadence | Data | Verdict |
| --- | --- | --- | --- | --- |
| **A. Saved Report → "secure location for third-party systems"** | Probably included | Daily | Item Order Report (purchase-level) | **Primary** |
| **B. Bulk Fee Export (SFTP add-on)** | Paid add-on | Configurable (nightly) | Transaction-level, stable schema | **Preferred if affordable** |
| C. ERP Extract feed | Included | Nightly | **GL/accounting level only** | Finance reconciliation, not per-student |
| D. Manual CSV download | Free | Manual | Merchant Reconciliation / Item Order | Interim fallback |

**Effort estimate: 3–4 weeks** of engineering once vendor access is confirmed, plus 1–2 weeks of vendor lead time and 1 week of reconciliation sign-off.

---

## 2. What was verified, and how confident we are

This plan rests on vendor documentation, not assumption. The distinction matters because **§9 asks you to confirm four things before any code is written.**

### 2.1 Confirmed from primary sources

| Finding | Source |
| --- | --- |
| KEV describes ERP integration as "a unidirectional integration via a **flat file data export (.csv format)**" — no API | KEV "ERP Data Integration" specification PDF |
| Saved Reports can be scheduled **daily** and "stored automatically in a **secure location**… accessed and picked up automatically by the District's **third-party system**" | KEV KB 3000124132 |
| Email delivery is a **link requiring interactive login** — *not* machine-consumable | Same article |
| Report formats: PDF, **CSV (vendor-recommended)**, Excel | KEV KB 3000105904 |
| Report types include **Item Order Report** ("who bought what"), Item Attachment, Batch, Merchant Reconciliation Export | KEV KB 3000124290, 3000127566 |
| **Bulk Fee Export** is a **paid add-on**, CSV via SFTP, schedule set by KEV | KEV KB 3000132887 |
| SFTP host `kevftp-us.schoolcash.net`, **port 54321** | KEV SIS Extract spec PDF |
| **Cap of 10 saved reports per school** | KEV KB 3000114029 |
| **Student number masking** (last-3-digits) exists, district-controlled, **OFF by default** | KEV KB 3000124121 |
| Receipt prefixes distinguish channel: `SCO…` online, `POS…` point-of-sale, `SCR-…` register | KEV KB 3000127566 |
| Site protected by Incapsula/Imperva; `robots.txt` is `Disallow: /` | Live probe |

### 2.2 Confirmed data schema (Bulk Fee Export template)

This is the closest thing to an official transaction contract, downloaded verbatim from KEV:

```
fee_type, external_item_id, external_fee_id, student_number,
transaction_type, transaction_amount, transaction_date,
receipt_number, payment_id, payment_tender
```

That maps almost one-to-one onto what we need. **`receipt_number` + `payment_id` is the natural idempotency key.**

### 2.3 NOT confirmed — treat as open risk

| Open question | Why it matters |
| --- | --- |
| Is the "secure location" SFTP, S3, or HTTPS? | Determines the entire ingestion design |
| Which report types can be dropped there? | If Batch/Reconciliation are excluded, financial reconciliation needs path D |
| Is the drop **full snapshot or incremental**? | Determines whether absence-of-row means deletion |
| How are refunds, voids and waives represented? | We have 189 negative legacy payments; we must handle the equivalent |
| Is the secure-location drop **free** or paid? | Budget |
| Complete Item Order Report column list (A–Y) | Only ~10 columns confirmed by name |
| Is `student_number` the SIS local ID or a KEV-internal ID? | Determines the participant matching key |

**None of these can be answered from public sources.** The setup instructions sit behind the district admin login. See §9.

---

## 3. Why not scrape

For completeness, since it is the obvious "quick" option:

| Blocker | Evidence |
| --- | --- |
| Incapsula/Imperva challenge on every host | `Set-Cookie: visid_incap_…`, `X-Iinfo` headers; 212-byte interstitials |
| `robots.txt` | `User-Agent: *` … `Disallow: /` |
| Terms of service | Automated retrieval outside the sanctioned path is a breach risk |
| Fragility | Any markup change breaks extraction silently |

A scraper would be technically hard, legally risky, and would break without warning. **Recommended against.**

---

## 4. Target architecture

### 4.1 Pipeline

```
┌───────────────────────────────────────────────────────────────────┐
│  KEV / School Cash Online                                         │
│  Scheduled Saved Report  or  Bulk Fee Export                      │
└───────────────────────────┬───────────────────────────────────────┘
                            │  CSV, daily
┌───────────────────────────▼───────────────────────────────────────┐
│  Landing zone                                                     │
│  SFTP folder (or blob container) — one file per drop              │
└───────────────────────────┬───────────────────────────────────────┘
                            │  poll every 15 min
┌───────────────────────────▼───────────────────────────────────────┐
│  Ingest job (Node, scheduled)                                     │
│  1. claim file (rename to .processing)                            │
│  2. checksum → skip if already ingested                           │
│  3. parse CSV → staging.ScoTransaction (raw, all text)            │
│  4. transform → core.Payment + link to core.Registration          │
│  5. move to archive/<yyyy-mm-dd>/                                 │
│  6. write audit.ScoImportRun                                      │
└───────────────────────────┬───────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────┐
│  SQL Server — staging.ScoTransaction → core.Payment               │
└───────────────────────────────────────────────────────────────────┘
```

**Why a landing zone and not direct-to-database:** the same reasoning as the Access migration. Land the raw file first, transform second. A parse bug then costs a re-run, not a corrupted payment table.

### 4.2 Idempotency

Every row is keyed on **`(receipt_number, payment_id)`** from the vendor. Re-running an import is a no-op. This is non-negotiable — SFTP drops get re-picked after outages, and vendors sometimes resend.

### 4.3 Never delete on absence

The Item Order Report "includes ALL purchases, not just those which are new", but we do **not** know whether the secure-location drop is a full snapshot. Until the vendor confirms, **absence of a row must never be treated as a deletion**. Refunds and voids must arrive as explicit rows.

---

## 5. Data model

### 5.1 New table — `staging.ScoTransaction`

Raw landing, everything as text, nothing coerced. Mirrors `staging.RawRow` from the migration.

```sql
CREATE TABLE staging.ScoTransaction (
    ScoTransactionID BIGINT IDENTITY(1,1) PRIMARY KEY,
    ImportRunID      INT            NOT NULL,
    RowNumber        INT            NOT NULL,
    FeeType          NVARCHAR(100)  NULL,
    ExternalItemId   NVARCHAR(100)  NULL,
    ExternalFeeId    NVARCHAR(100)  NULL,
    StudentNumber    NVARCHAR(100)  NULL,
    TransactionType  NVARCHAR(50)   NULL,
    TransactionAmount NVARCHAR(50)  NULL,   -- keep as text; parse in transform
    TransactionDate  NVARCHAR(50)   NULL,
    ReceiptNumber    NVARCHAR(50)   NULL,
    PaymentId        NVARCHAR(50)   NULL,
    PaymentTender    NVARCHAR(50)   NULL,
    RawJson          NVARCHAR(MAX)  NULL,
    LoadedAt         DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_ScoTransaction_Key ON staging.ScoTransaction(ReceiptNumber, PaymentId);
```

### 5.2 New table — `audit.ScoImportRun`

```sql
CREATE TABLE audit.ScoImportRun (
    ImportRunID   INT IDENTITY(1,1) PRIMARY KEY,
    FileName      NVARCHAR(260) NOT NULL,
    FileHash      VARBINARY(32) NOT NULL,   -- SHA-256 of the raw file
    RowCount      INT           NOT NULL,
    AcceptedCount INT           NOT NULL,
    RejectedCount INT           NOT NULL,
    StartedAt     DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CompletedAt   DATETIME2(0)  NULL,
    Status        NVARCHAR(20)  NOT NULL,   -- Running | Succeeded | Failed
    ErrorMessage  NVARCHAR(2000) NULL
);
CREATE UNIQUE INDEX UX_ScoImportRun_Hash ON audit.ScoImportRun(FileHash);
```

The unique index on `FileHash` is what makes "have I already ingested this file?" a one-row lookup rather than a scan.

### 5.3 Additions to `core.Payment`

The existing table has 9 columns — enough for manual entry, not for reconciliation.

```sql
ALTER TABLE core.Payment ADD
    Source            NVARCHAR(20)  NOT NULL DEFAULT 'Manual',  -- Manual | SCO
    ExternalPaymentId NVARCHAR(50)  NULL,   -- SCO payment_id
    ExternalReceipt   NVARCHAR(50)  NULL,   -- SCO receipt_number
    TenderType        NVARCHAR(50)  NULL,   -- SCO payment_tender
    ScoImportRunID    INT           NULL;

CREATE UNIQUE INDEX UX_Payment_External
    ON core.Payment(ExternalPaymentId, ExternalReceipt)
    WHERE ExternalPaymentId IS NOT NULL;
```

**Why a filtered unique index:** legacy manual payments have no external ID, and `NULL` values would otherwise collide. The filter makes the constraint apply only to imported rows.

### 5.4 Participant matching

SCO gives us `student_number` and (in the Item Order Report) student name, grade, homeroom, and purchaser email. Our `core.Participant` has **no student number column**.

Three options, in order of preference:

| Option | Mechanism | Risk |
| --- | --- | --- |
| **A. Add `Participant.ExternalStudentNumber`** | Populate from SIS; match on it | Requires a reliable student-number source |
| **B. Match on purchaser email** | Item Order Report has `Purchaser Email` | Parents share emails; 962 duplicate groups already |
| **C. Manual review queue** | Unmatched rows land in a queue for staff | Safe, but labour |

**Recommendation: A as primary, C as fallback, B as a hint.** Never auto-create a participant from a payment — a payment is evidence someone paid, not evidence of who they are.

---

## 6. Implementation phases

### Phase 0 — Vendor access (1–2 weeks, mostly waiting)

| Task | Owner | Output |
| --- | --- | --- |
| Send the question list in §9 to the KEV Account Manager | You / IT | Written answers |
| Request the "instructions on how to access reports made available for third-party systems" PDF | You | The missing artifact |
| Obtain SFTP credentials and confirm IP allow-listing | IT | Working connection |
| Confirm whether Bulk Fee Export add-on is in the subscription | You | Budget decision |
| Confirm student-number masking is OFF for our tenant | You | Written confirmation |

**Exit criteria:** we know the transport, the schema, the cadence, and the cost.

### Phase 1 — Schema and landing zone (3 days)

- `staging.ScoTransaction`, `audit.ScoImportRun`, `core.Payment` additions
- SFTP poller skeleton with a dry-run mode that only downloads and hashes
- Verify we can retrieve a real file end to end

**Exit criteria:** a real CSV from SCO lands in `staging.ScoTransaction` and the row count matches the file.

### Phase 2 — Transform and matching (1 week)

- Parse and normalise: amounts, dates, tender types
- Match to `core.Payment` on `(payment_id, receipt_number)` — upsert
- Match to `core.Participant` — by student number, else queue
- Handle refunds/voids explicitly
- Every rejection written to a quarantine table with a reason

**Exit criteria:** a full month of SCO transactions loads with zero unexplained rejections.

### Phase 3 — Reconciliation report (3 days)

- **SCO total vs `core.Payment` total, per school year and per day**
- Unmatched payments, unmatched participants, duplicate receipts
- Variance report for staff

This is the gate that matters: if the totals don't tie out, the integration isn't done.

### Phase 4 — Operational hardening (3 days)

- Scheduled job, alerting on failure and on variance
- Admin screen showing import history and the review queue
- Runbook in `docs/runbooks/`

**Exit criteria:** two consecutive weeks of clean imports with zero variance.

---

## 7. Reconciliation — the part that decides success

The migration already proved this discipline works: **$1,789,889.8027 reconciled exactly** between Access and SQL Server. The same gate applies here.

| Check | Pass condition |
| --- | --- |
| Row count | SCO rows = imported rows + quarantined rows |
| Financial total | `SUM(SCO transaction_amount)` = `SUM(core.Payment.PaymentTotal)` for imported rows, to the cent |
| Per-day totals | Daily sums match |
| No duplicates | Zero rows with the same `(payment_id, receipt_number)` |
| No orphans | Every imported payment links to a participant, or is in the queue |

**Do not go live on a partial match.** A payment integration that is 99% right is worse than manual entry, because staff stop checking.

---

## 8. Risks

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| 1 | **Secure location is not SFTP** (S3/blob instead) | Medium | Medium | Design the poller behind a `LandingZone` interface; swap the adapter |
| 2 | **Secure location excludes Batch/Reconciliation reports** | Medium | High | Fall back to manual Merchant Reconciliation for GL, keep Item Order automated |
| 3 | **Student number masked to last 3 digits** | Low | High | Get written confirmation it is OFF before building matching |
| 4 | **Drop is incremental, not snapshot** — or vice versa | Medium | High | Ask explicitly; never delete on absence until confirmed |
| 5 | **Refunds/voids arrive as separate row types** we haven't seen | Medium | Medium | Handle unknown `transaction_type` by quarantining, not guessing |
| 6 | **Bulk Fee Export is a paid add-on** outside budget | Medium | Medium | Path A (Saved Report) is the fallback and is probably free |
| 7 | **Duplicate payments** — someone pays online *and* staff record it manually | High | Medium | Match on receipt/payment ID; flag manual payments that later appear in SCO |
| 8 | **Vendor changes the report layout** | Medium | Medium | Schema-validate every file; fail loudly rather than silently mis-mapping |
| 9 | **10-saved-report cap per school** | Low | Low | One report per school is enough for our use |
| 10 | **FERPA** — student payment data leaving the district | Low | High | SFTP with key auth, IP allow-list, encrypted at rest, DPA in place |

---

## 9. Questions to send the vendor — **blocking**

These are the ones that change the design. The research could not answer them from public sources because the setup instructions sit behind the district admin login.

**Transport**
1. What is the "secure location for third-party systems" — SFTP, S3/Azure blob, or HTTPS?
2. Host, port, authentication method (password or key), and IP allow-listing requirements?
3. Please send the "Click here to download instructions…" PDF directly.

**Content**
4. Which report types can be dropped there? Specifically Batch Report, Merchant Reconciliation, and Customized Transaction Report — or only Item Attachment/Order/Option?
5. Is the drop a **full snapshot** or **incremental**? What is the retention window?
6. How are refunds, voids and waives represented?
7. Is there a stable row-level primary key across drops?

**Schema**
8. Complete column list and data dictionary for the Item Order Report CSV (all columns, with types).
9. For Bulk Fee Export: allowable `transaction_type` values, `payment_tender` enum, date format and timezone, currency handling.
10. Is `student_number` the SIS local ID or a KEV-internal ID?
11. Is student-number masking OFF in our tenant, and can it stay off for the third-party feed?

**Commercial**
12. Is the secure-location drop included in our subscription, or a paid add-on?
13. Is Bulk Fee Export in our contract? If not, what does it cost?
14. Is there **any** outbound API or webhook — even under NDA or paid professional services — and is one on the roadmap?

**Governance**
15. SOC 2 Type 2 report and a DPA covering our ingestion endpoint.
16. Written confirmation that automated retrieval from the secure location is permitted under our agreement.

---

## 10. What this means for the existing app

| Area | Change |
| --- | --- |
| **Payments screen** (not yet built) | Must show `Source` and `TenderType`; manual entry stays, but becomes the exception |
| **Registrations** | `PaymentID` can now be set automatically; the "unpaid" count becomes accurate |
| **Dashboard** | Revenue card should distinguish SCO-collected from manually recorded |
| **Reports** | Any report summing payments must include SCO rows — the reconciliation gate enforces this |
| **Public registration form** | Unchanged — payment remains the vendor's job, as specified |

---

## 11. Recommended next step

**Send §9 to the KEV Account Manager before writing any code.**

The single highest-value artifact is the *"instructions on how to access reports made available for third-party systems"* PDF. Everything else in this plan is contingent on it, and it is a five-minute request.

If you can obtain that document, I can turn Phase 1 into concrete code within a day.

---

## Appendix A — Vendor products and naming

| Name | What it is |
| --- | --- |
| **School Cash Online (SCO)** | Parent-facing online payment portal |
| **SchoolCash Accounting (SCA)** | Accounting module |
| **SchoolFunds Online (SFO)** | Fundraising module |
| **KEV Group** | The vendor |
| `kevftp-us.schoolcash.net:54321` | SFTP host referenced in KEV's SIS spec |

> **Correction to a common assumption:** School Cash Online is **KEV Group**, not Veracross. No evidence of a Veracross relationship was found; treat them as unrelated.

## Appendix B — Receipt number prefixes

Useful for spotting channel at a glance:

| Prefix | Channel |
| --- | --- |
| `SCO…` | School Cash Online |
| `POS…` | Point-of-sale device |
| `SCR-…` | SchoolCash Register (in-person) |

## Appendix C — Sources

- KEV "ERP Data Integration" specification (PDF, © 2024 KEV Group)
- KEV SIS Extract specification (SFTP host/port)
- KEV knowledge base: 3000124132 (scheduled reports / secure location), 3000105904 (export formats), 3000124290 (catalog reports), 3000127566 (merchant reconciliation), 3000132887 (Bulk Fee Import/Export), 3000114029 (saved report limits), 3000124121 (student number masking)
- Live HTTP probes of `schoolcashonline.com` hosts (Incapsula headers, `robots.txt`)
