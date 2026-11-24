# Form Types and Storage — Generalising the Form Designer

**From:** `core.FormTemplate` is implicitly a *public registration* form; `core.FormAnswer` hangs off `RegistrationID`
**To:** A form has a declared **type**, and that type decides **where its answers are stored** and **who can submit it**
**Prepared:** 2026-11-23
**Status:** Draft for review — decisions in §10 need sign-off before Phase 1

**Related:** [Form Designer](./form-designer.md) · [Public registration](../features/public-registration.md) · [Workshop sessions](./workshop-sessions.md)

---

## 1. Executive summary

Two requests landed together, and they are the same request:

| Request | What it actually needs |
| --- | --- |
| A **"New Training Request"** form that populates the Training requests table | A form whose answers land in `core.TrainingRequest`, not in `core.FormAnswer` |
| A **"Workshop Feedback Form"** that participants fill out | A form that is *not* tied to a registration, whose answers land somewhere that can be reported on |

The Form Designer today can do neither. It is **not** a general form builder — it is a question editor for one specific form. Three things hard-code that:

1. **`core.FormAnswer` is keyed on `RegistrationID`.** An answer cannot exist without a registration. A feedback form filled in by someone who never registered, or a training request submitted by an agency, has no registration to hang off.
2. **A form is only reachable through a workshop's registration link.** `getVersionForLink()` takes a `RegistrationLinkID`, and a link belongs to one workshop. There is no way to say "this form is available at this URL, for anyone".
3. **There is no notion of what a form is *for*.** `FormTemplate` has a name and a description. Nothing records that one form collects registrations and another collects feedback, so nothing can route the answers.

**Recommendation: yes, add a form type — but a type is a *declaration of storage and audience*, not a free-text label.** A type that only labels a form would leave the hard part (where do the answers go?) unsolved, and staff would end up with a "Workshop Feedback Form" whose answers sit in a table nobody can query.

**Effort estimate: 3–4 weeks** for the generalisation plus the two forms. A narrower option that ships the two forms in ~1 week without generalising is in §9.

---

## 2. What exists today

### 2.1 The form tables

```sql
core.FormTemplate            -- Name, Description, IsActive, ArchivedAt
core.FormTemplateVersion     -- FormTemplateID, VersionNumber, PublishedAt
core.FormQuestion            -- FieldType, OptionsJson, MapsToColumn, IsBuiltIn, branching
core.FormAnswer              -- FormAnswerID, RegistrationID NOT NULL, FormQuestionID, AnswerText
```

`FormAnswer.RegistrationID` is `NOT NULL` with a foreign key to `core.Registration`. That single constraint is what makes the designer registration-only.

### 2.2 How a form is reached

```
/register/:slug  ->  core.WorkshopRegistrationLink (WorkshopID, FormTemplateVersionID)
                 ->  getVersionForLink(linkId)
                 ->  PublicRegisterPage renders the questions
                 ->  POST .../register writes core.Registration + core.FormAnswer rows
```

There is exactly one entry point, and it always produces a registration.

### 2.3 Field types

`text`, `longtext`, `number`, `select`, `radio`, `checkbox`, `agency`, `session`. The `session` type was added recently and shows the pattern for a type whose options come from data rather than a static list.

### 2.4 What the two new forms need

**New Training Request.** The target table already exists and is populated by the ETL:

```sql
core.TrainingRequest
    TrainingRequestID, AgencyID, RequestDate, RequestedBy, RequestPhone,
    RequestExt, RequestEmail, ParticipantCount, InvoiceNum, InvoiceDate,
    DueDate, AmtDue, IsActive
```

Every one of those is a single-valued field — a name, a phone, a date, a text range. This is a **flat form that maps one-to-one onto columns**. It does not need `FormAnswer` at all: it needs a form whose submission *is* an `INSERT INTO core.TrainingRequest`.

**Workshop Feedback.** There is no table for this. The closest existing objects are the legacy evaluation tables:

```sql
core.EvalQuestion        -- the questions, per EvaluationType
core.WorkshopEvalQuestion -- WorkshopID, EvalQuestID, WorkshopEvalRating, WorkshopEvalQuantity
core.WorkshopComment      -- WorkshopID, Comment
```

These are **aggregate** structures: `WorkshopEvalQuestion` stores a rating *and a count* per question per workshop, which is what you get when a paper form's answers are tallied. They cannot hold one participant's individual responses, and they have no link to who responded. Reusing them would mean either losing per-response detail or inventing a response id inside a table that was never designed for it.

**Recommendation: a new `core.FormSubmission` table** — see §4.3.

---

## 3. Design

### 3.1 A form type declares audience and storage

`core.FormTemplate` gains two columns:

```sql
IF COL_LENGTH('core.FormTemplate', 'FormType') IS NULL
    ALTER TABLE core.FormTemplate ADD FormType NVARCHAR(30) NOT NULL
        CONSTRAINT DF_FormTemplate_FormType DEFAULT 'Registration';

IF COL_LENGTH('core.FormTemplate', 'StorageKind') IS NULL
    ALTER TABLE core.FormTemplate ADD StorageKind NVARCHAR(30) NOT NULL
        CONSTRAINT DF_FormTemplate_StorageKind DEFAULT 'FormAnswer';
```

The default keeps every existing template working untouched: they are registration forms storing answers in `FormAnswer`.

| `FormType` | `StorageKind` | Answers go to | Reachable from |
| --- | --- | --- | --- |
| `Registration` | `FormAnswer` | `core.FormAnswer` (via `RegistrationID`) | A workshop's registration link |
| `TrainingRequest` | `TrainingRequest` | `core.TrainingRequest` columns | A standalone public link |
| `Feedback` | `FormAnswer` | `core.FormAnswer` (via `FormSubmissionID`) | A standalone public link, optionally per workshop |
| `Survey` (future) | `FormAnswer` | `core.FormAnswer` | A standalone public link |

**Why two columns rather than one.** `FormType` is what staff pick and what the UI groups by. `StorageKind` is what the code branches on. They are separate because a future `Survey` type will store answers exactly like `Feedback` — same storage, different purpose, different reporting. Collapsing them would force a code change every time a new *label* is added.

**Why not a lookup table.** The set of storage kinds is a code concern: each one has a writer. A `ref.FormType` row that no code knows how to handle is worse than a `CHECK` constraint, because it looks configurable and isn't. A `CHECK` constraint lists the supported values and rejects anything else.

```sql
ALTER TABLE core.FormTemplate ADD CONSTRAINT CK_FormTemplate_FormType
    CHECK (FormType IN ('Registration', 'TrainingRequest', 'Feedback', 'Survey'));
ALTER TABLE core.FormTemplate ADD CONSTRAINT CK_FormTemplate_StorageKind
    CHECK (StorageKind IN ('FormAnswer', 'TrainingRequest'));
```

### 3.2 A form can be reached without a registration link

The second missing piece. A new table:

```sql
core.FormLink
    FormLinkID      INT PK (not IDENTITY — house rule)
    FormTemplateVersionID INT NOT NULL FK
    Slug            NVARCHAR(24) NOT NULL UNIQUE
    Title           NVARCHAR(120) NULL      -- heading on the public page
    WorkshopID      INT NULL FK             -- optional: feedback for one workshop
    IsActive        BIT NOT NULL DEFAULT 0
    OpensAt         DATETIME2(0) NULL
    ClosesAt        DATETIME2(0) NULL
    RevokedAt       DATETIME2(0) NULL
    RevokedBy       NVARCHAR(100) NULL
    CreatedBy       NVARCHAR(100) NOT NULL
    CreatedAt       DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME()
```

This deliberately mirrors `core.WorkshopRegistrationLink`, which already has slug, active flag, open/close window and a revoke path. The differences are that it pins a *version* directly (no workshop required) and can optionally name a workshop.

**Why not reuse `WorkshopRegistrationLink` with a nullable `WorkshopID`.** That table's whole shape assumes a workshop: the public resolver joins `core.Workshop` and reads `MaxEnrollment`, `IsRegistrationOpen` and the capacity maths. Making `WorkshopID` nullable would put a `WHERE WorkshopID IS NOT NULL` branch through every capacity calculation to support a case that shares none of that logic. A separate table with a separate resolver is smaller and safer.

### 3.3 `core.FormAnswer` must stop requiring a registration

This is the change that makes the whole thing work, and the one with the most care needed.

```sql
-- RegistrationID becomes nullable; a submission reference is added.
IF COL_LENGTH('core.FormAnswer', 'FormSubmissionID') IS NULL
    ALTER TABLE core.FormAnswer ADD FormSubmissionID INT NULL;

-- Exactly one owner: a registration OR a submission, never both, never neither.
ALTER TABLE core.FormAnswer ADD CONSTRAINT CK_FormAnswer_Owner
    CHECK (
        (RegistrationID IS NOT NULL AND FormSubmissionID IS NULL) OR
        (RegistrationID IS NULL AND FormSubmissionID IS NOT NULL)
    );
```

`RegistrationID` is currently `NOT NULL`; the migration must drop that constraint before the `CHECK` will accept a submission-owned row. Existing rows all satisfy the first branch, so the constraint validates immediately.

`UQ_FormAnswer (RegistrationID, FormQuestionID)` stays as it is. SQL Server treats `NULL`s as distinct in a unique index, so it will not stop duplicate answers on submission-owned rows. A second unique index covers that:

```sql
CREATE UNIQUE INDEX UQ_FormAnswer_Submission
    ON core.FormAnswer (FormSubmissionID, FormQuestionID)
    WHERE FormSubmissionID IS NOT NULL;   -- filtered: only submission rows
```

### 3.4 `core.FormSubmission`

One row per completed form, for every storage kind that is not a registration:

```sql
core.FormSubmission
    FormSubmissionID INT PK (not IDENTITY — house rule)
    FormLinkID       INT NOT NULL FK core.FormLink
    FormTemplateVersionID INT NOT NULL FK   -- what was actually asked
    WorkshopID       INT NULL FK            -- copied from the link, for reporting
    SubmittedAt      DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME()
    SubmittedByIpHash VARBINARY(32) NULL    -- salted hash, never the raw IP
    UserAgent        NVARCHAR(400) NULL
    Status           NVARCHAR(20) NOT NULL DEFAULT 'Received'  -- Received | Processed | Rejected
    Notes            NVARCHAR(500) NULL
```

`FormTemplateVersionID` is stored on the submission as well as the link, because a link can be repointed at a new version and the submission must record which questions its answers belong to. This is the same rule the registration link already follows.

### 3.5 The training-request storage path

A `TrainingRequest` form does **not** write `FormAnswer` rows. Instead, its question keys map to columns, and submission inserts one `core.TrainingRequest` row.

The existing `MapsToColumn` mechanism is the natural fit — it already exists and already means "this answer belongs in a real column":

| `QuestionKey` | `MapsToColumn` | Field type |
| --- | --- | --- |
| `agency` | `TrainingRequest.AgencyID` | `agency` |
| `requestDate` | `TrainingRequest.RequestDate` | `text` (date) |
| `requestedBy` | `TrainingRequest.RequestedBy` | `text` |
| `requestPhone` | `TrainingRequest.RequestPhone` | `text` |
| `requestEmail` | `TrainingRequest.RequestEmail` | `text` |
| `participantCount` | `TrainingRequest.ParticipantCount` | `text` |
| `notes` | — | `longtext` (stored in `FormAnswer` on the submission) |

**The mapping must be validated at publish time, not at submit time.** A form that claims to write `TrainingRequest.Amountt` should fail when staff publish it, not when an agency has already filled it in. §5.2 covers the allowlist.

**Why not write `FormAnswer` rows as well.** For this type the answer *is* the row. Writing both would create two sources of truth for the same value, and the Training requests page reads the columns. Questions the columns cannot hold (a free-text note) still go to `FormAnswer`, which is why the submission row exists even for this type.

### 3.6 The feedback storage path

Feedback has no target table, so it is the plain case: one `FormSubmission` row plus `FormAnswer` rows.

Reporting reads through a view so the Feedback screen never has to know the storage:

```sql
CREATE VIEW core.vw_FormSubmissionAnswers AS
SELECT s.FormSubmissionID, s.FormLinkID, s.FormTemplateVersionID, s.WorkshopID,
       s.SubmittedAt, s.Status,
       q.QuestionKey, q.Label, q.FieldType, q.SortOrder,
       a.AnswerText, a.AnswerJson
  FROM core.FormSubmission s
  JOIN core.FormAnswer a ON a.FormSubmissionID = s.FormSubmissionID
  JOIN core.FormQuestion q ON q.FormQuestionID = a.FormQuestionID;
```

**Explicit non-goal: do not reuse `core.WorkshopEvalQuestion` or `core.WorkshopComment`.** They are aggregate tallies with no per-respondent identity. Writing individual responses into them would either lose the respondent or corrupt the counts the legacy reports depend on. If staff want the feedback to roll up into the existing evaluation reports, that is a separate aggregation job over `vw_FormSubmissionAnswers`, not a change to the storage.

---

## 4. Screens

### 4.1 Form Designer — template list

`/admin/forms` gains a **Type** column and a type filter, and the "New form" dialog asks for the type up front:

```
FORM NAME                        TYPE               VERSION   STATUS
Standard Registration Form       Registration       3         Published
New Training Request             Training Request   —         Draft
Workshop Feedback 2026-27        Feedback           —         Draft
```

The type is shown but **not editable after creation**. Changing a form's type would mean re-routing answers that have already been stored under the old rules, and there is no safe general answer to "what happens to the 40 submissions already in `FormAnswer`". A form of the wrong type should be archived and recreated — the archive path already exists and keeps the answers.

### 4.2 Form Designer — editor

For a `TrainingRequest` form, each question gains a **Stores in** select listing the allowed target columns (§5.2), instead of the free-text `MapsToColumn` field. For the other types the field is hidden, as it is today.

The publish step validates the mapping and refuses with a specific message:

> "Request date" is required but does not map to a column. A Training Request form must fill `RequestDate`.

### 4.3 Public form page

A new route `/form/:slug` renders a `FormLink`. It reuses the existing question renderer, so field types, branching and validation behave identically.

| Type | Heading | Extra |
| --- | --- | --- |
| `TrainingRequest` | "Request training" + the link's `Title` | Agency picker, as today |
| `Feedback` | The link's `Title` | If `WorkshopID` is set, the workshop name and date appear above the questions |
| `Registration` | Not reachable here | — |

The confirmation screen differs by type: a training request says "We'll be in touch about your request", feedback says "Thanks for your feedback". Neither claims a seat was reserved.

### 4.4 Staff screens for the new data

| Screen | What it shows |
| --- | --- |
| **Training requests** | No change. A submitted form appears as a normal row, because it *is* a normal row. Optionally a "Source: web form" column later. |
| **Feedback** (new, `/feedback`) | Submissions grouped by workshop, with per-question tallies for `select`/`radio`/`number` and the free-text answers listed. Filter by form, workshop and date range. |

The Feedback screen is the one genuinely new staff surface. It is deliberately a **report**, not an editor: feedback is a record of what someone said, and editing it would make it worthless.

---

## 5. API

### 5.1 New endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/forms?type=Feedback` | Filter the template list by type |
| `POST /api/forms` | Accepts `formType`; derives `storageKind` |
| `GET /api/forms/:id/links` | Links for a form |
| `POST /api/forms/:id/links` | Create a `FormLink` (slug generated, inactive by default) |
| `PATCH /api/form-links/:id` | Activate, set open/close window, revoke |
| `GET /api/public/forms/:slug` | Resolve a `FormLink`: state, title, workshop, questions |
| `POST /api/public/forms/:slug/submit` | Validate, then write by storage kind |
| `GET /api/form-submissions` | Staff list, filterable |
| `GET /api/feedback/summary` | Tallies and free-text for the Feedback screen |

### 5.2 The column allowlist

The mapping is validated against a hard-coded table, never by interpolating a client-supplied column name into SQL:

```ts
const TRAINING_REQUEST_TARGETS = {
  'TrainingRequest.AgencyID':        { column: 'AgencyID',        type: sql.Int,        fieldTypes: ['agency'] },
  'TrainingRequest.RequestDate':     { column: 'RequestDate',     type: sql.Date,       fieldTypes: ['text'] },
  'TrainingRequest.RequestedBy':     { column: 'RequestedBy',     type: sql.NVarChar(100), fieldTypes: ['text'] },
  'TrainingRequest.RequestPhone':    { column: 'RequestPhone',    type: sql.NVarChar(14),  fieldTypes: ['text'] },
  'TrainingRequest.RequestExt':      { column: 'RequestExt',      type: sql.Int,        fieldTypes: ['number'] },
  'TrainingRequest.RequestEmail':    { column: 'RequestEmail',    type: sql.NVarChar(100), fieldTypes: ['text'] },
  'TrainingRequest.ParticipantCount':{ column: 'ParticipantCount',type: sql.NVarChar(255), fieldTypes: ['text'] },
};
```

`InvoiceNum`, `InvoiceDate`, `DueDate` and `AmtDue` are deliberately **excluded**: those are set by staff when the request is priced, not by the agency asking. Letting a public form write an amount due would be a one-line way to invoice the wrong figure.

### 5.3 Submission rules

Shared by both public endpoints:

1. The link must be active, not revoked, and inside its open/close window — the same state machine as the registration link.
2. Required questions are checked against the pinned version, honouring branching (an invisible branched question is not required).
3. Rate limiting and the honeypot apply exactly as they do on the registration form.
4. Every submission is logged to `audit.PublicSubmission`, which already exists and already records `Outcome` and `Reason`.
5. Answers for a `TrainingRequest` form are written **inside one transaction** with the `core.TrainingRequest` insert, so a validation failure cannot leave a half-built request.

---

## 6. Data: what happens to what is already there

### 6.1 Existing templates

Every current template is a registration form. The migration's `DEFAULT 'Registration'` / `DEFAULT 'FormAnswer'` sets them correctly with no backfill. Verify afterwards:

```sql
SELECT FormType, StorageKind, COUNT(*) FROM core.FormTemplate GROUP BY FormType, StorageKind;
-- Expect one row: Registration / FormAnswer / <n>
```

### 6.2 Existing answers

`FormAnswer.RegistrationID` is already populated on every row. The `CHECK` in §3.3 validates immediately because every existing row satisfies the registration branch. Confirm before adding it:

```sql
SELECT COUNT(*) AS orphans FROM core.FormAnswer WHERE RegistrationID IS NULL;
-- Must be 0
```

### 6.3 `NOT NULL` removal

Dropping `NOT NULL` from `RegistrationID` is safe for existing data but is a schema change on a live table with roughly one row per answer. Do it in the same migration, and check the row count before and after:

```sql
SELECT COUNT(*) FROM core.FormAnswer;  -- before
-- ... migration ...
SELECT COUNT(*) FROM core.FormAnswer;  -- must match
```

---

## 7. Phasing

| Phase | Work | Effort | Depends on |
| --- | --- | --- | --- |
| **1. Schema** | Migration 014: `FormType`/`StorageKind`, `FormLink`, `FormSubmission`, `FormAnswer` nullable + `CHECK` + filtered index, `vw_FormSubmissionAnswers`. `schema.sql` mirrored. | 1 day | — |
| **2. Type plumbing** | Template list/create accept a type; storage kind derived; type shown and filtered in the designer; type immutable after creation. | 1–2 days | 1 |
| **3. Form links** | `FormLink` CRUD, `/form/:slug` route, public resolve endpoint reusing the existing renderer. | 2–3 days | 2 |
| **4. Feedback path** | Submission endpoint writing `FormSubmission` + `FormAnswer`; Feedback screen with tallies. | 3–4 days | 3 |
| **5. Training-request path** | Column allowlist, publish-time validation, transactional insert, "Stores in" picker in the editor. | 3 days | 3 |
| **6. Polish** | Confirmation copy per type, `audit.PublicSubmission` coverage, docs. | 1–2 days | 4, 5 |

**Total: 3–4 weeks.**

### Testing

- `form-types.test.ts` — storage kind derived from type; type immutable on update; unknown type rejected.
- `form-links.test.ts` — slug uniqueness; inactive link refuses; window enforced; revoked link refuses.
- `submission.test.ts` — required-question validation with branching; `CHECK` owner constraint rejects both-or-neither.
- `training-request-form.test.ts` — a form mapping an unknown column is refused at publish; a valid form creates exactly one `core.TrainingRequest` row and no duplicate on retry; a failure mid-insert leaves no row.
- `feedback.test.ts` — tallies match the underlying answers; free text is returned verbatim.

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| The `FormAnswer` owner `CHECK` fails on existing data | Low | High | §6.2 pre-check runs first; every existing row has a `RegistrationID` |
| A public training-request form is spammed | Medium | Medium | Rate limit + honeypot + `audit.PublicSubmission`, all already built for the registration form |
| Staff map a question to a column the form cannot fill, and only find out at submit | Medium | High | Publish-time validation (§4.2) |
| A form of the wrong type is created and cannot be retyped | Medium | Low | Type is shown before creation; archive-and-recreate is the documented path |
| Feedback is expected to appear in the existing evaluation reports | High | Medium | §3.6 states it does not; aggregation is a separate job |
| Two entry points (`/register/:slug` and `/form/:slug`) drift apart | Medium | Medium | Both resolve through the same question renderer and the same validation helper |

---

## 9. A narrower option, if 3–4 weeks is too long

If the goal is *only* the two forms, the generalisation can be skipped:

| Approach | Ships | Cost later |
| --- | --- | --- |
| **Narrow:** build "New Training Request" as a purpose-built page posting to the existing `POST /api/training-requests`, and "Workshop Feedback" as a new table with its own page | ~1 week | The next form request needs another bespoke page. This is the third time the same shape has come up. |
| **Generalise (this plan)** | 3–4 weeks | Adding a form type becomes a small, well-understood change |

**Recommendation: generalise.** The pattern is already repeating — registration, training request, feedback — and the narrow option pays the same design cost again on the fourth.

---

## 10. Decisions needed before Phase 1

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Is a form type a *storage declaration* or just a label? | Storage declaration. A label alone leaves the answers unqueryable, which is the actual complaint |
| 2 | One `FormType` column or `FormType` + `StorageKind`? | Both. Purpose and storage are separate concerns (§3.1) |
| 3 | Reuse `WorkshopRegistrationLink` for standalone forms? | No. Its capacity logic assumes a workshop (§3.2) |
| 4 | Reuse the legacy evaluation tables for feedback? | No. They are aggregate tallies with no respondent identity (§3.6) |
| 5 | Can a form's type be changed after creation? | No. Archive and recreate (§4.1) |
| 6 | Should the public form write `AmtDue` / `InvoiceNum`? | No. Those are staff decisions, not the requester's (§5.2) |
| 7 | Should feedback roll up into the existing evaluation reports? | Not in this plan. It is a separate aggregation job |

---

## 11. What this does not change

- The registration link, its capacity maths and its state machine.
- `core.Registration` and the existing registration form path.
- `core.WorkshopEvalQuestion` / `core.WorkshopComment` — untouched.
- The Training requests page — a web submission appears as a normal row.
- Question field types, branching, or the versioning rules.

---

## 12. Immediate next steps

1. **Decide §10.1** — whether the type is a storage declaration or a label. Everything else follows.
2. Confirm the feedback form's audience: does it apply to a specific workshop (link carries `WorkshopID`) or to the programme generally (no workshop)?
3. On sign-off, write migration 014 and mirror it in `db/schema.sql` in the same change.
