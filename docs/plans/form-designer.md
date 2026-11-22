# Form Designer

Let staff design the **questions** on the public registration form, per workshop,
without a code change.

- **Idea:** [`form-template.md`](./form-template.md)
- **Status:** approved — decisions recorded in §10
- **Scope:** form fields only. Workshop title, date, time, location, cost and
  CEUs always render and are never editable in the designer.

---

## 1. The problem

Today the public form is hard-coded in
[`PublicRegisterPage.tsx`](../../apps/web/src/pages/PublicRegisterPage.tsx) and
[`public.ts`](../../apps/api/src/routes/public.ts). Every workshop asks the same
six questions plus a two-branch role section.

Staff have no way to ask a workshop-specific question — "Which site do you work
at?", "Dietary requirements?", "How did you hear about us?" — without a
developer. The workaround is to cram it into "Anything we should know?", which
is a free-text box with no structure and no reporting value.

Meanwhile the answers to the *existing* role questions are already awkward:
`ChildrenAges` and `SecondCaregiverInfo` are **empty across all 14,403
participants**, because those columns were added for the parent branch and the
data was never collected before it existed.

---

## 2. What the idea proposes, and where I'd change it

The idea doc is a good starting point. Three things need deciding before code.

### 2.1 Branching is the hard part — I'd ship it later

The idea shows `BRANCH #1 - Ques1` with per-option question sets. That is a
conditional form builder: a question tree, per-branch validation, and a renderer
that walks it. It is also where the current form already lives (the
Educator/Parent split), so it is tempting to generalise immediately.

**Recommendation: Phase 1 ships a single flat list of questions.** No branches.
The existing Educator/Parent branch stays hard-coded as it is today, and custom
questions appear *after* it, common to both audiences.

Reason: a flat list covers the actual need ("ask one more question") and is
roughly a third of the work. Branching can be added in Phase 3 without
migrating data, because the branch is a property of a question, not of the
storage.

### 2.2 Storage: answers go in a side table, not new columns

The idea doc says "storage of the additional fields would need to be
determined". It should be a **name/value table**, not dynamic columns.

Dynamic columns (`ALTER TABLE ADD Custom1..Custom20`) is the obvious shortcut
and the wrong one: it caps the number of questions, makes every answer
`NVARCHAR(255)`, and turns "which workshops asked about dietary needs?" into a
schema question.

A row per answer keeps the schema fixed and makes reporting trivial.

### 2.3 Templates are versioned, and a link pins a version

The idea shows a `VERSION` column. That matters more than it looks: if staff
edit a template after 30 people have registered, the 31st registrant must not
see a different form than the first 30 did — and their answers must still line
up with the questions that were actually asked.

**A registration link pins a template *version*, not a template.** Editing a
template creates a new version; existing links keep pointing at the old one
until staff explicitly republish.

---

## 3. Data model

Four new tables. Migration `008-form-designer.sql`, applied to both databases.

### 3.1 `core.FormTemplate`

| Column | Type | Notes |
|---|---|---|
| `FormTemplateID` | INT PK | not IDENTITY (house rule) |
| `Name` | NVARCHAR(100) | "Standard Registration Form" |
| `Description` | NVARCHAR(500) NULL | shown to staff only |
| `IsActive` | BIT | inactive templates cannot be picked for new links |
| `CreatedBy` / `CreatedAt` | NVARCHAR(200) / DATETIME2 | |
| `UpdatedBy` / `UpdatedAt` | NVARCHAR(200) / DATETIME2 | |

### 3.2 `core.FormTemplateVersion`

| Column | Type | Notes |
|---|---|---|
| `FormTemplateVersionID` | INT PK | |
| `FormTemplateID` | INT FK | |
| `VersionNumber` | INT | 1, 2, 3… per template |
| `PublishedAt` | DATETIME2 NULL | NULL = draft, not usable for new links |
| `PublishedBy` | NVARCHAR(200) NULL | |

Unique on `(FormTemplateID, VersionNumber)`.

### 3.3 `core.FormQuestion`

| Column | Type | Notes |
|---|---|---|
| `FormQuestionID` | INT PK | |
| `FormTemplateVersionID` | INT FK | |
| `SortOrder` | INT | display order |
| `QuestionKey` | NVARCHAR(50) | stable machine name, e.g. `dietary` |
| `Label` | NVARCHAR(200) | the question, shown above the input |
| `HelpText` | NVARCHAR(300) NULL | persistent guidance under the input |
| `Placeholder` | NVARCHAR(100) NULL | grey hint inside an empty input |
| `FieldType` | NVARCHAR(20) | see §4 |
| `IsRequired` | BIT | renders `*` / `(optional)` — never typed into the label |
| `OptionsJson` | NVARCHAR(MAX) NULL | choices for select/radio/checkbox |
| `MaxLength` | INT NULL | text/longtext only |
| `MapsToColumn` | NVARCHAR(50) NULL | §5 — set only for built-in questions |
| `IsBuiltIn` | BIT | built-in questions cannot be deleted |

Unique on `(FormTemplateVersionID, QuestionKey)`.

### 3.4 `core.FormAnswer`

| Column | Type | Notes |
|---|---|---|
| `FormAnswerID` | BIGINT PK | |
| `RegistrationID` | INT FK | ties the answer to one registration |
| `FormQuestionID` | INT FK | |
| `AnswerText` | NVARCHAR(MAX) NULL | |
| `AnswerJson` | NVARCHAR(MAX) NULL | multi-select / checkbox |
| `CreatedAt` | DATETIME2 | |

Unique on `(RegistrationID, FormQuestionID)`. Index on `FormQuestionID` for
reporting.

**Why keyed on `RegistrationID`, not `ParticipantID`:** the same person
attending two workshops may answer differently ("which site?"), and the answer
belongs to the registration, not the person.

### 3.5 Link change

`core.WorkshopRegistrationLink` gains one nullable column:

```sql
ALTER TABLE core.WorkshopRegistrationLink
  ADD FormTemplateVersionID INT NULL;
```

`NULL` means "use the built-in form" — so every existing link keeps working
unchanged, and the feature is opt-in per workshop.

---

## 4. Field types

Six to start. Deliberately small — each type is a renderer, a validator, and a
reporting shape.

| Type | Renders as | Stored in |
|---|---|---|
| `text` | single-line input | `AnswerText` |
| `longtext` | textarea | `AnswerText` |
| `number` | number input | `AnswerText` |
| `select` | dropdown | `AnswerText` |
| `radio` | radio group | `AnswerText` |
| `checkbox` | multi-select checkboxes | `AnswerJson` |

Deliberately **not** in v1: date pickers, file upload, signature, matrix/grid
questions. Each adds real complexity (file storage, PII handling) for little
gain on a registration form.

---

## 4a. Label, help text, placeholder and required — the four display slots

Every question carries **four** pieces of display text, because the current form
already uses all four and the designer must reproduce it exactly rather than
flatten it.

| Slot | Column | Purpose | Example |
|---|---|---|---|
| **Label** | `Label` | The question itself | `How old are the students in your class?` |
| **Help text** | `HelpText` | Guidance under the label | `Ages in years, e.g. 3-4` |
| **Placeholder** | `Placeholder` | Grey hint inside the empty input | `e.g. 3-4 year olds` |
| **Required marker** | `IsRequired` | Renders `*` or `(optional)` | — |

### 4a.1 How the current form uses them

This matters because the existing form is not consistent, and the designer
should make the inconsistency visible rather than silently pick one.

Reading [`PublicRegisterPage.tsx`](../../apps/web/src/pages/PublicRegisterPage.tsx):

- **Required fields** show a red `*` and the word `(required)` in the label.
- **Optional fields** append `(optional)` in grey inside the label.
- **Placeholders** carry the examples: `e.g. 3-4 year olds`, `e.g. 2 and 4`,
  `Name, phone, email or anything else we should know`.
- **`.field-hint`** (12px, `--text-faint`, 5px below the input) exists and is
  styled, but the public form only uses it once — for the "Payment is arranged
  separately" note, not for a field.

So today, guidance lives in **placeholders**, not help text. Placeholders
disappear the moment someone types, which is exactly when they might still need
the guidance.

### 4a.2 What the designer should do

Give staff **both** slots and let them choose:

```
┌─ Edit question ────────────────────────────────────┐
│  Label         [How old are the students…      ]   │
│  Help text     [Ages in years, e.g. 3-4        ]   │
│                Shown under the input, stays        │
│                visible while typing.               │
│  Placeholder   [e.g. 3-4 year olds             ]   │
│                Grey hint inside the empty input.   │
│  Required      [ ] This question is required       │
│                                                    │
│  ┌─ Preview ────────────────────────────────────┐  │
│  │ How old are the students in your class?      │  │
│  │ (optional)                                   │  │
│  │ ┌──────────────────────────────────────────┐ │  │
│  │ │ e.g. 3-4 year olds                       │ │  │
│  │ └──────────────────────────────────────────┘ │  │
│  │ Ages in years, e.g. 3-4                      │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

The live preview in the editor renders all four slots together, so staff see
exactly what a registrant will see before publishing.

### 4a.3 Seeding the built-in questions

The six built-in questions are seeded **with their current wording moved into
the right slots**, so the default form looks identical to today's:

| Question | Label | Placeholder | Help text |
|---|---|---|---|
| `firstName` | First name | — | — |
| `lastName` | Last name | — | — |
| `email` | Email | — | — |
| `phone` | Phone | — | — |
| `agency` | School or agency | — | — |
| `notes` | Anything we should know? | — | — |

The two role-branch fields keep their placeholders (`e.g. 3-4 year olds`,
`Name, phone, email or anything else we should know`) when they move into the
designer in Phase 3.

### 4a.4 Validation rules

- **Label** is required, max 200 chars. A question with no label cannot be
  published.
- **Help text** is optional, max 300 chars, plain text only (no HTML).
- **Placeholder** is optional, max 100 chars. Rejected on `radio`, `checkbox`
  and `select`, where the concept does not apply.
- **Required marker** is derived from `IsRequired` — staff do not type
  `(optional)` into the label themselves. This is the main reason to model it
  as a flag rather than free text: it keeps the wording consistent and
  translatable.

### 4a.5 Accessibility

- Help text is linked to the input with `aria-describedby`, so a screen reader
  reads the label, then the guidance, then the field.
- The required state uses `aria-required` in addition to the visual `*` —
  colour and an asterisk alone are not sufficient.
- Placeholder text is **never** the only source of an instruction, because it
  vanishes on input and is not reliably announced. That is precisely why help
  text is a separate, persistent slot.

---

## 5. Built-in questions

The existing six fields stay as **built-in questions** so the designer shows the
whole form in one place, and so staff can relabel or reorder them without a
code change.

| `QuestionKey` | `MapsToColumn` | Label / help / placeholder | Required | Deletable |
|---|---|---|---|---|
| `firstName` | `Participant.FirstName` | editable | locked on | no |
| `lastName` | `Participant.LastName` | editable | locked on | no |
| `email` | `Participant.Email` | editable | locked on | no |
| `phone` | `Participant.HomePhone` | editable | editable | no |
| `agency` | `Participant.AgencyID` | editable | editable | no |
| `notes` | `Registration.Notes` | editable | editable | no |

`MapsToColumn` is the bridge: when set, the answer is written to the existing
column **and** to `FormAnswer`. That keeps every current screen, report and
export working, and means the 41,341 historical registrations still join
correctly.

Name and email cannot be deleted or made optional — the app needs a way to
identify the registrant.

### 5.1 The role question stays hard-coded (Phase 1)

`registrantRole` drives the branch and the mailing-list flags. Making it a
designer question in Phase 1 would mean the designer has to understand
branching. It stays built-in and fixed until Phase 3.

---

## 6. Screens

### 6.1 Form Designer — `/admin/forms`

Staff-only (`SUPER_ADMIN`, `ADMIN`, `MANAGER`).

```
┌─ Forms ────────────────────────────────────────────────────┐
│  [+ New form]                                              │
│                                                            │
│  Standard Registration Form      v2 · published   [Edit]   │
│  Parent Workshop Form            v1 · draft       [Edit]   │
└────────────────────────────────────────────────────────────┘
```

### 6.2 Template editor — `/admin/forms/:id`

Two panes: question list on the left, live preview on the right.

```
┌─ Standard Registration Form        v2 (published) ─────────┐
│  Questions                          │  Preview            │
│  ─────────────────────────────      │  ─────────────────  │
│  ⠿ First name          text   req   │  First name *       │
│    Last name           text   req   │  [__________]       │
│    Email               text   req   │  Last name *        │
│    Phone               text         │  [__________]       │
│    School or agency    select       │  …                  │
│    Anything we should  longtext     │                     │
│  ── Custom ──────────────           │                     │
│  ⠿ Dietary needs       text   opt   │  Dietary needs      │
│    [+ Add question]                 │  (optional)         │
│                                     │  [__________]       │
│                                     │  Tell us about any  │
│                                     │  allergies.         │
│                                     │                     │
│  [Save draft]  [Publish v3]         │                     │
└─────────────────────────────────────┴─────────────────────┘
```

- Drag to reorder (⠿ handle), or arrow buttons for keyboard users
- Click a question to edit **label, help text, placeholder, required flag** and
  options — see §4a.2 for the editor panel
- Built-in questions show a lock badge and cannot be deleted
- **Save draft** writes a new version with `PublishedAt = NULL`
- **Publish** stamps `PublishedAt` and bumps `VersionNumber`

### 6.3 Form selection on the registration link

The existing link panel ([`RegistrationLinkPanel.tsx`](../../apps/web/src/components/RegistrationLinkPanel.tsx))
gains a dropdown above "Create registration link":

```
PUBLIC REGISTRATION
Form template:  [Standard Registration Form ▾]  *
[Create registration link]
```

Only **published** versions appear. Changing the template on an existing link
warns that it will reset which questions future registrants see — existing
answers are never touched.

### 6.4 Public form — dynamic rendering

The workshop details block (title, code, date, time, location, cost, CEUs,
spots remaining) is unchanged and always renders.

Below it, the form is built from the pinned version:

1. Built-in questions in their configured order
2. The hard-coded role branch (Educator / Parent) as today
3. Custom questions, common to both audiences

Each question renders its four text slots in the order a person reads them:

```
Label *                    ← Label + required marker
┌────────────────────────┐
│ Placeholder            │ ← grey, disappears on input
└────────────────────────┘
Help text                  ← persistent, aria-describedby
```

Validation is generated from the question definitions: `IsRequired`, `MaxLength`,
and the allowed options for choice fields. The API re-validates server-side —
client validation is a convenience, never the gate.

### 6.5 Answers on the Registrants tab

The Registrants tab gains an expandable row (or a "View answers" action) showing
that registrant's custom answers as label/value pairs.

A new **Answers** export on the workshop drawer produces a CSV: one row per
registrant, one column per question.

---

## 7. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/forms?includeArchived=` | List templates with current version; archived ones only when asked for |
| `POST` | `/api/forms` | Create a template (seeds a v1 draft from the built-in set) |
| `GET` | `/api/forms/:id` | Template + all versions |
| `GET` | `/api/forms/:id/versions/:versionId` | One version with its questions |
| `POST` | `/api/forms/:id/versions` | Save a new draft version from a question list |
| `POST` | `/api/forms/:id/versions/:versionId/publish` | Publish a draft |
| `PATCH` | `/api/forms/:id` | Rename / activate / deactivate |
| `POST` | `/api/forms/:id/archive` | Retire a form. Refuse if any link references it. Nothing is deleted |
| `POST` | `/api/forms/:id/restore` | Un-retire a form |
| `GET` | `/api/public/registration-links/:slug` | **extended** — returns the pinned version's questions |
| `GET` | `/api/workshops/:id/form-answers` | Answers for the workshop's registrants |

The public registration POST accepts an `answers` object keyed by
`QuestionKey`, validates it against the pinned version, and writes
`core.FormAnswer` rows in the same transaction as the registration.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| **A published version is edited in place**, so two registrants saw different forms | Versions are immutable once published. Editing always creates a new draft. |
| **A form is deleted and its answers become unreadable** | Forms are never deleted. Archive hides a form from the list and the link picker but keeps every version and answer; it can be restored. Archiving is refused while a link still uses it. |
| **Deleting a question orphans answers** | Questions are soft-deleted (`IsActive = 0`) when a version has answers. Answers are never deleted with the question. |
| **A custom question collides with a built-in column** | `QuestionKey` is unique per version and custom keys are prefixed `custom_`. |
| **The public form becomes an injection surface** | Answers are parameterised and length-capped; labels are rendered as text, never HTML. |
| **Staff publish a broken form** (required question with no label) | Publish validates: every question needs a label, every choice field needs ≥1 option, and no placeholder is set on a radio/checkbox/select. |
| **Rate limiting is in-memory** (single instance) | Already true today; not made worse. Flagged for a future fix. |
| **Free-text answers are unsearchable** | Accepted for v1. Reporting is per-question, which is the point of structured fields. |

---

## 9. Phasing

| Phase | Scope | Est. |
|---|---|---|
| **1** | Migration 008, template/version/question tables, designer screen (flat list, 6 field types, label + help text + placeholder), publish flow, link dropdown, dynamic public rendering, answers on Registrants | **~3.5 days** |
| **2** | Answers CSV export, per-question summary counts on the workshop drawer, form answers on the participant detail, duplicate-template action | ~1.5 days |
| **3** | Branching (`BranchOnQuestionID` + `BranchOptionValue`), so the Educator/Parent split itself becomes designer-controlled | ~2 days |
| **4** | Additional field types (date, file upload), conditional "show this question if…" | ~2 days |

**Phase 1 is the shippable unit.** It delivers the actual ask — staff design
their own questions — without the branching complexity that makes form builders
notoriously hard to get right.

---

## 10. Decisions

All five open questions are answered. Recorded here so the build does not
re-litigate them.

| # | Question | Decision |
|---|---|---|
| 1 | Who can publish? | **`SUPER_ADMIN` / `ADMIN` only.** `MANAGER` may edit drafts but not publish. |
| 2 | What happens to in-flight registrations when a link is repointed to a new version? | **Existing answers stay attached to the old question rows and remain readable.** The new version applies only to registrations created after the change. |
| 3 | Do you want the built-in questions relabelable? | **Yes — label, help text and placeholder are editable. Deletion and the required flag stay locked** for name and email. |
| 4 | Should custom answers appear on the participant record too? | **Yes.** Answers are keyed on `RegistrationID` (so the same person can answer differently per workshop) but are also surfaced on the participant detail, grouped by workshop. |
| 5 | Should a template be scoped to a school year? | **No.** A form is a form; the workshop supplies the year. Templates are global and reusable across years. |

### 10.1 Consequences of decision 4

Because answers are registration-scoped but *visible* on the participant, the
participant detail needs a new section:

```
┌─ Form answers ─────────────────────────────────────┐
│  A Guided Observation… (TDB2717) · Dec 1, 2026     │
│    Dietary needs        Vegetarian                 │
│    How did you hear?    Colleague                  │
│                                                    │
│  Sensory Processing… (TPB2775) · Mar 4, 2027       │
│    Dietary needs        —                          │
└────────────────────────────────────────────────────┘
```

Grouped by workshop, newest first, showing only questions that existed on that
registration's pinned version. A question answered on one workshop never bleeds
into another's row.

### 10.2 Consequences of decision 3

`MapsToColumn` questions can be relabelled but their `QuestionKey` and
`MapsToColumn` are immutable. That keeps the write path stable: renaming
"Email" to "Work email" changes what the registrant reads, not where the answer
is stored.

---

## 11. What this does not change

- Workshop details (title, code, date, time, location, cost, CEUs, capacity)
  always render and are never part of the designer.
- The Educator / Parent branch stays as-is in Phase 1.
- Historical registrations are untouched; every existing screen keeps working
  because built-in questions still write to their original columns.
- The public form's visual language is unchanged — the designer reuses the
  existing `.field`, `.field-hint` and `.error` styles rather than introducing a
  parallel set.
