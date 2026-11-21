# Certificates

Staff issue a CEU or CHC certificate to a participant after they complete a
workshop. In Access this was the `rptCEUCertificate` / `rptCHCCertificate`
report family, opened in design view to change the logo, title and signatories.

This document covers how that works in the web app: the template staff edit, the
per-participant overrides you asked about, and how a certificate is produced.

- **Plan reference:** [`docs/plans/access-migration.md`](../plans/access-migration.md) §8.6
- **Schema:** `core.CertificateTemplate`, `core.vw_ParticipantCertificate`
- **Status:** schema and seed templates exist; API and UI not yet built

---

## 1. What exists today

| Piece | State |
| --- | --- |
| `core.CertificateTemplate` | ✅ Created, 2 seed rows (CEU + CHC for SY 2025-26) |
| `core.vw_ParticipantCertificate` | ✅ Created (participant + flags only) |
| `core.Participant.HasCeuCertificate` / `HasChcCertificate` | ✅ Migrated |
| Certificate API endpoints | ❌ Not built |
| Template editor UI | ❌ Not built |
| PDF rendering | ❌ Not built |

### 1.1 The data problem you need to know about

The Access certificate flags did **not** migrate usefully. Only **one**
participant (ID 15443, Jessica Slessman) carries a CEU flag, and **none** carry a
CHC flag — out of 14,403 participants.

Why: in Access the flag lived on the participant *and* the report filtered by
`SYID` hardcoded per query (`sqryCEUCertificates` hardcodes `SYID = 16`,
`sqryCHCCertificates` hardcodes `SYID = 13`). So "has a certificate" was never a
permanent participant property — it was "this person got one **this year**".

**Implication:** do not treat `HasCeuCertificate` as the source of truth. The
real eligibility rule is derived, see §3.

---

## 2. How the template works

### 2.1 What staff can change

| Setting | Control | Notes |
| --- | --- | --- |
| **Logo** | Image upload (PNG/SVG, ≤ 1 MB) | Versioned per school year |
| **Title** | Text | Default "Certificate of Credit" |
| **Subtitle / organisation block** | Text | Default "Project Enlightenment" |
| **Program Director name + title** | Text | First signature block |
| **Approving Director name + title** | Text | Second signature block |
| **Credit-unit label** | Text | "Unit(s) of Renewal Credit" (CEU) / "Child Care Hours" (CHC) |
| **Footer disclaimer** | Text | Default keeps the WCPSS-employee notice |
| **Field visibility** | Toggles | See §2.2 |
| **Layout** | Select | Portrait (8.5×11) or landscape (11×8.5) |

**Not configurable:** field positions, page size beyond the two orientations, fonts. Those
need a developer. This is the line between "configurable template" and "report
designer", and the latter is a product in its own right.

### 2.1.1 Layout

`core.CertificateTemplate.Layout` stores `'portrait'` or `'landscape'`, defaulting to
portrait. Landscape reduces the type scale to 82% so the same content still fits one
sheet — the alternative is a second layout that overflows onto a second page.

The choice is per template, so a school year can differ from its neighbours, and an
already-issued certificate keeps the orientation it was issued with.

### 2.2 Field visibility

The Access certificate printed **Social Security Number** and the **full home
address**. Both are off by default.

| Field | Default | Rationale |
| --- | --- | --- |
| Name | **On** | Required |
| Certificate type (Initial / Continuing) | **On** | Required |
| Program title | **On** | Required |
| Program director | **On** | Required |
| Inclusive dates | **On** | Required |
| Units of renewal credit | **On** | Required |
| School / agency | On | Useful for employer records |
| Employed by | On | — |
| Substitute / Assistant / Teacher flags | On | — |
| **Social Security Number** | **Off** | Sensitive; not needed on a certificate |
| **Home address** | **Off** | Unnecessary exposure |
| Certificate expiration date | Off | Only meaningful for some types |

Staff can turn any back on; the defaults are the safe ones.

### 2.3 Versioning

Templates are keyed by `(SchoolYearID, CertificateType)` and **never edited in
place across years**. A new school year gets a copy. This is what lets a
certificate reissued for 2024-25 still print that year's logo and signatories.

---

## 3. Eligibility — who gets a certificate

Derived, not stored. A participant is eligible for a certificate in a school
year when they have at least one **attended, non-cancelled** registration in a
workshop whose code starts with `t`.

This mirrors `sqryCEUCertificates`:

```sql
SELECT p.ParticipantID, p.FirstName, p.LastName,
       SUM(w.SessionHours)              AS TotalHours,
       SUM(w.SessionHours * 0.1)        AS TotalCeus
FROM core.Participant p
JOIN core.Registration r ON r.ParticipantID = p.ParticipantID
JOIN core.Workshop   w ON w.WorkshopID  = r.WorkshopID
JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
WHERE r.Attended = 1
  AND r.IsCancelled = 0
  AND w.WorkshopCode LIKE 't%'
  AND sy.SchoolYear = @schoolYear
GROUP BY p.ParticipantID, p.FirstName, p.LastName
```

Two legacy rules worth keeping:

- **`WorkshopCode LIKE 't%'`** — only "t" codes count for credit. This is why
  the query is not simply "attended anything".
- **Late attendees are excluded** (`sqryCEUCertificates` filters `Late = No`).
  The new schema has no `Late` column; if staff still need it, add
  `Registration.IsLate`.

### 3.1 Credit maths

`CEUs = SessionHours × 0.1`. Ten contact hours is one CEU. `SessionHours` is
`DECIMAL` on `core.Workshop`; 36 of 2,599 workshops have no hours recorded, so
those contribute zero and should be flagged in the UI rather than silently
dropped.

### 3.2 How many are eligible

Attended registrations by school year — the realistic certificate volume:

| School year | Attended registrations | Distinct participants |
| --- | --- | --- |
| 2025-26 | 1 | 1 |
| 2024-25 | 1 | 1 |
| 2023-24 | 1 | 1 |
| 2022-23 | 14 | 14 |
| 2021-22 | 9 | 9 |
| 2020-21 | 64 | 64 |
| 2018-19 | 566 | 414 |
| 2017-18 | 1,280 | 776 |
| 2016-17 | 1,533 | 859 |
| 2015-16 | 1,801 | 1,030 |
| 2014-15 | 1,696 | 1,000 |
| 2013-14 | 2,195 | 1,311 |
| 2012-13 | 2,241 | 1,694 |
| 2011-12 | 2,451 | 1,647 |
| 2010-11 | 1,572 | 1,121 |
| 2009-10 | 1,971 | 1,261 |
| 2008-09 | 3,017 | 1,832 |
| 2007-08 | 3,284 | 2,012 |
| 2006-07 | 3,280 | 1,725 |

A typical year is **1,000–2,000 certificates**, not 14,000. Batch generation
must handle that comfortably.

---

## 4. Per-participant images and text

You asked for staff to be able to add images and text **for each participant**.
That is a different concern from the template, and it needs its own table.

### 4.1 Why not just edit the template

The template is shared by everyone in a school year. If staff could put text on
"the certificate", it would appear on all 1,500. Per-participant content has to
be stored per participant.

### 4.2 Proposed table

```sql
CREATE TABLE core.CertificateOverride (
    CertificateOverrideID INT IDENTITY(1,1) PRIMARY KEY,
    ParticipantID         INT           NOT NULL REFERENCES core.Participant(ParticipantID),
    SchoolYearID          INT           NOT NULL REFERENCES ref.SchoolYear(SchoolYearID),
    CertificateType       NVARCHAR(10)  NOT NULL,   -- 'CEU' | 'CHC'

    -- Free text a staff member adds to this person's certificate
    CustomText            NVARCHAR(500) NULL,
    CustomTextLabel       NVARCHAR(100) NULL,       -- e.g. "Note:", "Awarded for:"

    -- One optional extra image per participant
    ImagePath             NVARCHAR(400) NULL,
    ImageAltText          NVARCHAR(200) NULL,       -- required when ImagePath is set
    ImagePlacement        NVARCHAR(20)  NULL,       -- 'header' | 'body' | 'footer'

    UpdatedBy             NVARCHAR(200) NULL,
    UpdatedAt             DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT UQ_CertificateOverride UNIQUE (ParticipantID, SchoolYearID, CertificateType)
);
```

One row per participant per year per type. Absent row = use the template as-is.

### 4.3 Where the image lives

**Not in the database.** Store a path; keep the bytes on disk or in blob
storage. Three reasons:

1. A 500 KB logo × 1,500 participants would add ~750 MB to a 42 MB database.
2. `bcp`-based copies (`db/etl/copy-database.ps1`) would slow to a crawl.
3. Backups stay small.

Layout:

```
apps/api/uploads/certificates/
  templates/{schoolYearId}/{CEU|CHC}/logo-{timestamp}.png
  participants/{participantId}/{schoolYearId}/{CEU|CHC}-{timestamp}.png
```

Served read-only through an authenticated endpoint — never as a static
directory, or every certificate image is world-readable.

### 4.4 Accessibility

The certificate is a public-school artifact and must stay readable by screen
readers. Two rules:

- **`ImageAltText` is required whenever `ImagePath` is set.** The form blocks
  save without it.
- **No flattened background images.** A Canva export was considered and
  rejected (plan §8.6.1): flattening turns text into pixels, so the certificate
  loses selectable, searchable, screen-reader-readable text.

---

## 5. Generating a certificate

```
Workshop detail → Registrants → select attendees
  → Preview (one page per attendee)
  → Download PDF (single or combined)
```

Or from a participant:

```
Participant detail → Certificates tab → pick school year + type → Preview → Download
```

Rendered server-side by Playwright from the same HTML template used for
preview, so preview and print cannot diverge.

### 5.1 Template resolution order

For each participant, merge in this order — later wins:

1. `core.CertificateTemplate` for `(schoolYear, type)`
2. `core.CertificateOverride` for `(participant, schoolYear, type)`, if present
3. Live data: name, agency, workshop titles, dates, hours, CEUs

### 5.2 Mobile

The certificate is never reflowed. On a phone staff see a scaled preview and a
**Download PDF** action. Print layout is fixed at 8.5×11.

---

## 6. API surface

```
GET    /api/certificates/templates?schoolYear=&type=
GET    /api/certificates/templates/:id
POST   /api/certificates/templates              # create for a new school year
PATCH  /api/certificates/templates/:id
POST   /api/certificates/templates/:id/logo     # multipart upload

GET    /api/certificates/eligible?schoolYear=&type=&q=&page=
GET    /api/certificates/overrides/:participantId?schoolYear=&type=
PUT    /api/certificates/overrides/:participantId
POST   /api/certificates/overrides/:participantId/image
DELETE /api/certificates/overrides/:participantId

POST   /api/certificates/render                 # { participantIds[], schoolYear, type } → PDF
GET    /api/certificates/preview/:participantId # HTML for live preview
```

All admin-gated except `preview`, which any staff role may use.

---

## 7. Acceptance criteria

- A staff member changes the logo and title, previews against a real attendee,
  and saves — without developer involvement.
- A staff member adds custom text and an image to one participant, and that
  participant's certificate shows it while everyone else's does not.
- Certificates generated before a template change keep their original logo and
  signatories.
- SSN and home address are absent from the PDF by default.
- The PDF is print-accurate at 8.5×11 with no reflow between preview and print.
- Every uploaded image has alt text, and the PDF remains screen-reader readable.
- A workshop with no `SessionHours` is flagged in the UI rather than silently
  producing a zero-credit certificate.

---

## 8. Open questions

1. **Late attendees.** The Access query excluded them. Is that still a rule? If
   yes, `Registration.IsLate` needs adding.
2. **Who signs?** The seed templates have titles but no names. Confirm the
   current Program Director and Approving Director.
3. **Logo storage.** Local disk is fine for one App Service instance; if you
   scale out, move to Azure Blob Storage. Which do you want?
4. **Reissue.** If a template changes after certificates went out, should the
   app be able to regenerate the *old* version? Versioning supports it, but the
   UI needs a "reissue as of" control.
