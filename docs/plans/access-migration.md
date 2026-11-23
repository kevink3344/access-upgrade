# Project Enlightenment Training Database — Migration & Re-platform Plan

**From:** `TrainingDatabase.accdb` (Microsoft Access, single-file, desktop)
**To:** SQL Server 2025 + Node.js/React web application
**Prepared:** 2026-11-19
**Status:** Draft for review

---

## 1. Executive summary

`TrainingDatabase.accdb` is a 42 MB Access application that runs the Project Enlightenment training operation: workshop catalog and scheduling, participant and agency records, registrations, payments and receipts, attendance, credit slips, CEU/CHC certificates, training requests and quotes, community events, and roughly 150 saved queries feeding 112 printed reports and mailing lists.

The database itself is in good shape for a migration — identifiers are stable surrogate keys, there are no OLE/attachment blobs, and referential integrity is almost entirely clean. The real complexity is not the data: it is the **112 reports, 150 saved queries, and the folder/brochure/email workflows** that staff depend on every registration cycle.

This plan recommends:

| Decision | Recommendation | Why |
| --- | --- | --- |
| Database | **SQL Server 2025** (already installed locally, Standard Developer Edition) | Already present; `sqlcmd` + ODBC driver 18 available; strongest reporting ecosystem; native Windows auth |
| Migration method | **Scripted ETL** (Node + `mssql`), not SSMA | Schema is small and clean; a scripted load is repeatable, diffable, and re-runnable against staging |
| Backend | **Node.js 24 + TypeScript + Fastify + Kysely** | Typed SQL without an ORM hiding the legacy queries; first-class SQL Server support |
| Frontend | **React 19 + Vite + TanStack Query/Router + WCPSS theme** | Fast iteration, strong table/form ecosystem, theme tokens already extracted |
| Reports | **Server-rendered HTML → PDF** (Playwright/Chromium), same templates as screen | One template per report; no second layout language |
| Rollout | **Parallel run**, Access read-only, 5 phases | Staff cannot lose a registration cycle |

Estimated effort: **~14–18 weeks** for a single full-stack developer, or **~9–11 weeks** with two developers plus a part-time domain expert. Phase 0–2 (data + core CRUD) is roughly 45% of the work; reports and the folder/brochure workflows are the other 55%.

> **Deliverables in this folder:** this plan (`access-migration.md`), `access-migration.html` (styled, self-contained), and `access-migration.pdf` (printable, includes UI mockups). UI mockups were generated from the actual WCPSS design tokens.

---

## 2. What we actually found in the database

Everything below was read directly from `database/TrainingDatabase.accdb` on 2026-11-19.

### 2.1 Inventory

| Object type | Count | Notes |
| --- | --- | --- |
| Tables | 70 | 29 `lst*` lookups, 34 `tbl*` core, 5 `stbl*` staging, 2 scratch |
| Rows (largest) | 41,345 | `tblRegistrations`; `tblSessionParticipants` 36,686; `tblRegistrationAttendances` 34,040 |
| Saved queries | 150 | ~60 read-only, ~35 append/update, ~20 delete, rest ad-hoc |
| Forms | 48 | 9 top-level `frm*`, 36 subforms `sfrm*`, 3 dialogs `dlg*`, 1 switchboard |
| Reports | 112 | 8 obsolete (`OLD_*`) |
| Macros | 10 | All are simple `OpenForm`/`RunQuery`/`SetTempVar` navigation macros |
| VBA modules | 0 | **No standard modules.** Only 3 forms have code-behind, and it is only `Form_BeforeUpdate` timestamp stamping (4, 3, and 4 lines) |
| Enforced relationships | 0 | Referential integrity is entirely enforced by the application |
| Linked tables | 1 | `lnkEmailsToRemove` → `S:\Project Enlightenment\...\EmailsToRemove.xlsx` (a manual exclusion list) |

**This is a very favourable finding.** The absence of VBA means there is no business logic to reverse-engineer — the logic lives in the saved queries and in staff knowledge. That is where the discovery effort must go.

### 2.2 Data model (core entities)

```
lstSchoolYrs (SYID) ──┐
lstCategoryTypes ─────┤
lstComponents ────────┼──> tblWorkshops ──┬──> tblWorkshopSessions ──┐
lstEvalTypes ─────────┤   (2,598)          │      (3,677)             │
tblWorkshopNames ─────┘                    │                          │
                                           ├──> tblWorkshopPresenters ──> tblPresentersAndStaff
                                           ├──> tblWorkshopRegistrations (via tblRegistrations)
                                           ├──> tblWorkshopEvalQuestions ──> tblEvalQuestions
                                           ├──> tblWorkshopComments / LikedMost / LikedLeast / Practices
                                           ├──> tblWorkshopDesiredTopics / PreferredTimes / Referrals
                                           └──> tblWorkshopSummaryCounts / tblOtherCounts

tblAgencies (811) ──┬──> tblAgencyMailAddresses
  lstCities/Counties/Regions/States/StreetTypes/AgencyTypes/FacilityTypes
                    └──> tblParticipants (14,435) ──┬──> tblRegistrations (41,345)
                                                    │       └──> tblPayments (6,034) ──> tblPayees
                                                    │       └──> lstPaymentMethods / lstCreditTypes
                                                    ├──> tblSessionParticipants (36,686) ──> tblWorkshopSessions
                                                    └──> tblCreditSlips (846)

tblTrainingRequests (108) ──┬──> tblTrainingRequestsContacts (463)
                            ├──> tblTrainingRequestsQuotes (126)
                            ├──> tblTrainingRequestsScheduled (84)
                            └──> tblTrainingRequestsPayments (68)

tblCommunityEvents (399) ──> tblCommunityEventStaff (620)
tblBoardMembers (36) ──> tblAgencies
```

### 2.3 Domain glossary

| Term | Meaning |
| --- | --- |
| **SY** / `SYID` | School year, July 1 – June 30. `lstSchoolYrs` holds 21 years; SY 2026-27 is current |
| **Workshop** | A scheduled offering (`tblWorkshops`), tied to a catalog entry (`tblWorkshopNames`) |
| **Workshop Name** | The reusable catalog definition: title, description, prerequisites, age range |
| **Session** | One dated meeting of a workshop (`tblWorkshopSessions`); multi-session workshops have several |
| **Participant** | An individual attendee (teacher, parent, staff) |
| **Agency** | The school, center, or organization a participant belongs to |
| **Registration** | A participant's enrollment in a workshop, with payment and attendance state |
| **Credit Slip** | An internal voucher issued when a workshop is cancelled or a participant overpaid; redeemable against a future registration |
| **CEU / CHC** | Continuing Education Unit / Child Care Hours certificates generated per participant per year |
| **Folder** | The printed packet prepared for each workshop: roster, attendance slip, evaluations, contact list, banner |
| **Brochure** | The printed/emailed catalog of upcoming workshops, split by audience (teacher/parent) and size |
| **Training Request** | An agency asking Project Enlightenment to deliver a workshop on-site; goes quote → schedule → invoice |
| **eSchools** | The external registration system. Access stores its counts in `tblWorkshops.ESchool*` columns and staff reconcile them by hand via `frmESchoolsEntry`; there is no integration. **All registration data in Access is manually derived.** |

### 2.4 Where the business logic actually lives

| Logic | Location today | Migration treatment |
| --- | --- | --- |
| Validation | Access form control properties + table validation rules | Re-implement as API-level schema validation (Zod) |
| Derived values | Saved queries (`qry*`) | Port to SQL views, then expose as API endpoints |
| Batch maintenance | Action queries (`upd*`, `apd*`, `del*`, `mak*`) | Re-implement as admin "Utilities" jobs with audit logging |
| Navigation | `Switchboard Items` table + 10 macros | Replace with React router + role-based nav |
| Email lists | `qryEmails*`, `qryMailingList*` → export → Outlook | Replace with server-side list builder + mail merge / SMTP |
| Certificates | `qryCEUCertificates`, `rptCEUCertificate*` | Report templates + PDF generation |
| Registration intake | Manual entry + eSchools reconciliation | **New:** public per-workshop registration form — see [`docs/features/public-registration.md`](../features/public-registration.md) |
| Timestamps | 3 `Form_BeforeUpdate` handlers | Database `DEFAULT`/`AFTER UPDATE` triggers |

### 2.5 Data quality findings

Measured against the live data. These drive the "clean before load" tasks in Phase 1.

| Check | Result | Impact / decision needed |
| --- | --- | --- |
| Registrations with orphan `ParticipantID` | **2** | Quarantine; likely deleted participants |
| Registrations with orphan `WorkshopID` | **2** | Quarantine |
| Registrations with `NULL WorkshopID` | **78** | Placeholder/draft rows — confirm with staff whether to archive |
| Participants with `NULL AgencyID` | **5,353** (37%) | Legitimate (parents/individuals). Make `AgencyID` nullable, not required |
| Participants with orphan `AgencyID`/`CityID` | **0** | Clean |
| Workshops with orphan `WorkshopNameID`/`CategoryID`/`SYID` | **0** | Clean |
| Workshop sessions with orphan `WorkshopID` | **11** | Quarantine |
| Workshop presenters with orphan `WorkshopID` | **11** | Quarantine |
| Session participants orphans | **0** | Clean |
| Payments with orphan `PayeeID`/`PaymentMethodID` | **0** | Clean |
| **Duplicate participant emails** | **962 groups** | **Business decision required** — merge, keep-all, or flag. Blocks a unique constraint on email |
| Duplicate participant names (first+last) | **233 groups** | Expected for common names; do not auto-merge |
| Malformed emails (no `@` or `.`) | **32** | Flag for cleanup, do not block |
| Workshops with `NULL StartDate` | **20** | Unscheduled placeholders |
| Workshops with `StartDate > EndDate` | **9** | Data-entry errors; correct during load |
| Registrations with negative `PaidAmt` | **189** | Likely refunds — confirm sign convention before migrating |

**No attachment or OLE-object columns exist**, which removes the single most painful Access migration problem.

---

## 3. Target architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Staff app (React 19 + Vite, WCPSS theme)          — internal        │
│  TanStack Router · TanStack Query · TanStack Table · React Hook Form │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS / JSON  (Entra ID SSO or local accounts)
┌───────────────┴──────────────────────────────────────────────────────┐
│  Public registration form (React 19 + Vite)        — internet-facing │
│  Separate route tree, no auth, own code-split bundle                 │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS / JSON  (rate-limited, no session)
┌───────────────▼──────────────────────────────────────────────────────┐
│  Node.js 24 · TypeScript · Fastify                                   │
│  ├── routes/        REST endpoints per resource                      │
│  ├── routes/public/ public registration endpoints (no auth)          │
│  ├── services/      domain rules (registration, payment, credit)     │
│  ├── reports/       HTML templates → PDF via Playwright              │
│  ├── jobs/          scheduled utilities, backups, email lists        │
│  └── auth/          session + role guards (admin/editor/viewer)      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ mssql / Kysely (typed SQL)
┌───────────────▼──────────────────────────────────────────────────────┐
│  SQL Server 2025  ·  database: TrainingDB                            │
│  schemas: core · ref · staging · audit                               │
└──────────────────────────────────────────────────────────────────────┘
```

Two web surfaces share one API. The public form is the only thing exposed to the internet; the staff app stays behind SSO. Both are **responsive and mobile-first** — see [`docs/features/responsive-mobile.md`](../features/responsive-mobile.md).

### 3.1 Why SQL Server over MySQL

| Criterion | SQL Server 2025 | MySQL 8 | Verdict |
| --- | --- | --- | --- |
| Already installed here | Yes — Standard Developer Edition, running | No | **SQL Server** |
| Tooling present | `sqlcmd`, ODBC Driver 18 | none | **SQL Server** |
| Access migration | Native ODBC + `OPENROWSET`; clean `IDENTITY` mapping | ODBC via connector | SQL Server |
| Report queries | Window functions, `PIVOT`, CTEs — matches Access crosstab needs | Weaker `PIVOT` | **SQL Server** |
| Windows/Entra auth | Native | Needs plugin | **SQL Server** |
| Licensing cost | Developer Edition free for non-production; Standard for prod | Free (GPL) | MySQL |

**Recommendation: SQL Server.** It is installed, licensed at this site's scale, and the reporting workload (crosstabs, year-over-year summaries) maps far more directly. MySQL only becomes the better answer if there is a hard organizational mandate or a Linux-only hosting target. The schema in §5 is written to be portable — the only SQL Server-specific constructs are `IDENTITY`, `DATETIME2`, `NVARCHAR`, and `BIT`, all of which have direct MySQL equivalents.

### 3.2 Technology choices

| Layer | Choice | Rationale |
| --- | --- | --- |
| Runtime | Node.js 24 LTS | Already installed; native `fetch`, built-in test runner |
| Language | TypeScript (strict) | The legacy schema is messy; types catch the `ComponenetID`-style typos |
| HTTP | Fastify 5 | Fast, schema-first validation, first-class TypeScript |
| API contract | **OpenAPI 3.1** via `zod-to-openapi` | Contract-first: one schema drives validation, docs, and the generated client |
| API docs | **Swagger UI** (`/swagger`) + **Scalar** (`/docs`) | Same document, two renderers. See §7.3 |
| API client | `openapi-typescript` | Typed frontend client generated from the spec — no hand-written fetch wrappers |
| Query layer | Kysely + `mssql` driver | Explicit SQL, no ORM magic, easy to port the 150 legacy queries verbatim |
| Validation | Zod | Shared schemas between API and forms |
| Frontend | React 19 + Vite 7 | Fast HMR; the app is a data-entry tool, not a content site |
| Routing | TanStack Router | Type-safe routes, file-based |
| Data fetching | TanStack Query | Caching, optimistic updates for fast data entry |
| Tables | TanStack Table (virtualized) | `tblRegistrations` at 41K rows needs virtualization |
| Forms | React Hook Form + Zod resolver | Access-style dense forms with keyboard-first entry |
| Styling | **Plain CSS with WCPSS CSS custom properties** | The site is not Tailwind; matching it is easier with the real tokens |
| Charts | **Recharts** | Declarative React SVG charts; composes with the existing component layer. See §8.5 for the print caveat |
| PDF | Playwright (Chromium) rendering the same HTML templates | One template per report; pixel-identical preview and print |
| Testing | Vitest + Testing Library; Playwright E2E | Report regression is the highest-risk area |
| Auth | Entra ID (OIDC) with local fallback | WCPSS staff already have WakeID/Entra accounts |

---

## 4. Design system — WCPSS theme

Tokens extracted from `https://www.wcpss.net` on 2026-11-19 (theme `default_25`).

### 4.1 Colour

| Token | Value | Usage |
| --- | --- | --- |
| `--primary-color` | `#165788` | Header, primary buttons, links, active nav |
| `--secondary-color` | `#df6d1c` | Call-to-action accents, badges, focus highlights |
| `--tertiary-color` | `#00add0` | Secondary accents, chart series |
| `--cc-fourth-color` | `#fed100` | Warnings, "unpaid" status |
| `--cc-fifth-color` | `#6e273d` | Error/destructive |
| `--cc-sixth-color` | `#BED600` | Success |
| `--cc-seventh-color` | `#c90062` | Category tags |
| `--cc-eighth-color` | `#455560` | Muted text, table headers |
| Body text | `#525252` | Default copy |
| Heading text | `#262626` | `h1`–`h6` |
| Neutral surface | `#e5e5e5` | Hover, disabled, table stripes |

Each colour is also exposed by the site in HSL components (`--primary-color-h`, `-s`, `-l`) so tints can be derived with `hsl(var(--primary-color-hsl) / 0.1)`.

### 4.2 Typography

| Token | Value |
| --- | --- |
| `--font-primary` | `'Open Sans', sans-serif` — body, UI, tables |
| `--font-secondary` | `'Solway', serif` — page titles, section headings |
| Body | `1.125rem` / `1.75rem`, colour `#525252` |
| `h1` | `2.5rem`, weight 700, `#262626` |
| `h2` | `2rem` · `h3` `1.5rem` · `h4` `1.25rem` · `h5` `1.125rem` · `h6` `1rem` |
| Heading spacing | `margin-top: 40px` when following a paragraph |

### 4.3 Component conventions

- **Buttons** — solid `--primary-color` with white text; hover/focus shifts to `#e5e5e5` background with inverted text (as on the district site); `0.4s all` transition.
- **Cards / panels** — white surface, `1px solid #e5e5e5`, `4px` radius, generous padding.
- **Tables** — `--cc-eighth-color` header row, white text, `#e5e5e5` zebra stripes, right-aligned currency.
- **Status pills** — Open (`#BED600`), Closed (`#455560`), Cancelled (`#6e273d`), Unpaid (`#fed100`), Paid (`#BED600`).
- **Accessibility** — WCAG 2.1 AA. `#165788` on white is 7.4:1. Never place white text on `#fed100` or `#BED600`.

### 4.4 Theme implementation

```css
/* src/styles/wcpss-tokens.css */
:root {
  --primary-color-h: 205.79;  --primary-color-s: 72.15%;  --primary-color-l: 30.98%;
  --primary-color: #165788;
  --primary-color-hsl: var(--primary-color-h), var(--primary-color-s), var(--primary-color-l);
  --secondary-color: #df6d1c;
  --tertiary-color: #00add0;
  --cc-fourth-color: #fed100;
  --cc-fifth-color: #6e273d;
  --cc-sixth-color: #BED600;
  --cc-seventh-color: #c90062;
  --cc-eighth-color: #455560;
  --text-body: #525252;
  --text-heading: #262626;
  --surface-neutral: #e5e5e5;
  --font-primary: 'Open Sans', sans-serif;
  --font-secondary: 'Solway', serif;
  --radius: 4px;
  --transition: .4s all;
}
```

Fonts are loaded from Google Fonts exactly as the district site does:

```html
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,600;0,700&family=Solway:wght@300;400;700&display=swap" rel="stylesheet">
```

> **Branding note:** reusing the district palette is fine for an internal tool. Do not copy the WCPSS logo, wordmark, or page layouts from `wcpss.net`; use the palette and typography only, and confirm with Communications if the tool will be externally visible.

---

## 5. Target schema

Four schemas: `ref` (lookups), `core` (entities), `audit` (change history), `staging` (ETL landing).

### 5.1 Type mapping rules

| Access type | SQL Server | Rule |
| --- | --- | --- |
| AutoNumber (Long) | `INT IDENTITY(1,1)` | Preserve original values with `SET IDENTITY_INSERT` |
| Long Integer | `INT` | |
| Integer / Byte | `SMALLINT` / `TINYINT` | |
| Yes/No | `BIT NOT NULL DEFAULT 0` | Access stores `True/False`; normalise `NULL` → `0` |
| Text(n) | `NVARCHAR(n)` | Keep original lengths; `NVARCHAR(MAX)` for type-12 |
| Hyperlink (type 12) | `NVARCHAR(MAX)` | Access hyperlinks store `display#url#` — strip to display text |
| Date/Time | `DATETIME2(0)` | Access date-only fields keep `00:00:00`; time-only fields carry `1899-12-30` |
| Currency | `DECIMAL(19,4)` | |
| Double | `FLOAT` | Only 3 columns; `tblWorkshops.TotalRegistrations/TotalParticipants` become computed |
| Replication ID | `UNIQUEIDENTIFIER` | None present |

**Field-name normalisation.** Legacy names contain spaces, `#`, `?`, and typos. Every column is renamed in the target; a mapping table (§5.4) preserves traceability.

| Legacy | Target |
| --- | --- |
| `ComponenetID` | `ComponentID` |
| `Receipt#` | `ReceiptNumber` |
| `ParentMailingList?` | `IsParentMailingList` |
| `In-Person` | `InPerson` |
| `lstNCZipCodes.[Zip Code]` | `ZipCode` |
| `tblWorkshopEvalQuestions.WorkshopEvaluations` | `WorkshopEvaluationID` |

### 5.2 Core tables (abridged DDL)

```sql
CREATE SCHEMA ref;
CREATE SCHEMA core;
CREATE SCHEMA audit;
CREATE SCHEMA staging;
GO

-- ---------- reference ----------
CREATE TABLE ref.SchoolYear (
    SchoolYearID   INT IDENTITY(1,1) PRIMARY KEY,
    SchoolYear     NVARCHAR(50)  NOT NULL,
    IsPastYear     BIT           NOT NULL DEFAULT 0,
    BeginDate      DATETIME2(0)  NULL,
    EndDate        DATETIME2(0)  NULL,
    CONSTRAINT UQ_SchoolYear UNIQUE (SchoolYear)
);

CREATE TABLE ref.Category (
    CategoryID     INT IDENTITY(1,1) PRIMARY KEY,
    CategoryCode   NVARCHAR(50)  NOT NULL,
    CategoryType   NVARCHAR(10)  NULL,      -- 'Classroom' | 'Workshops' | 'Grant'
    IsInUse        BIT           NOT NULL DEFAULT 1
);

CREATE TABLE ref.City (
    CityID   INT IDENTITY(1,1) PRIMARY KEY,
    RegionID INT NULL REFERENCES ref.Region(RegionID),
    City     NVARCHAR(30) NOT NULL
);

CREATE TABLE ref.ZipCode (
    ZipCode  NVARCHAR(10) NOT NULL PRIMARY KEY,
    RegionID INT NULL REFERENCES ref.Region(RegionID),
    City     NVARCHAR(255) NULL,
    County   NVARCHAR(255) NULL
);

-- ---------- core ----------
CREATE TABLE core.Agency (
    AgencyID           INT IDENTITY(1,1) PRIMARY KEY,
    WakeSitesFacilityID INT          NULL,
    CountyID           INT          NULL REFERENCES ref.County(CountyID),
    StreetTypeID       INT          NULL REFERENCES ref.StreetType(StreetTypeID),
    CityID             INT          NULL REFERENCES ref.City(CityID),
    StateID            INT          NULL REFERENCES ref.State(StateID),
    AgencyTypeID       INT          NULL REFERENCES ref.AgencyType(AgencyTypeID),
    FacilityTypeID     INT          NULL REFERENCES ref.FacilityType(FacilityTypeID),
    AgencyName         NVARCHAR(250) NULL,
    AgencyShortName    NVARCHAR(255) NULL,
    Address1           NVARCHAR(255) NULL,
    Address2           NVARCHAR(50)  NULL,
    Zip                NVARCHAR(10)  NULL,
    Phone              NVARCHAR(16)  NULL,
    Fax                NVARCHAR(16)  NULL,
    Email              NVARCHAR(50)  NULL,
    Website            NVARCHAR(100) NULL,
    DirectorFirstName  NVARCHAR(50)  NULL,
    DirectorLastName   NVARCHAR(50)  NULL,
    AltContactFirst    NVARCHAR(30)  NULL,
    AltContactLast     NVARCHAR(30)  NULL,
    IsOutOfBusiness    BIT            NOT NULL DEFAULT 0,
    SchoolCode         NVARCHAR(255) NULL,
    Calendar           INT            NULL,
    IsWorkshopSite     BIT            NOT NULL DEFAULT 0,
    Notes              NVARCHAR(MAX)  NULL,
    CreatedAt          DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt          DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Agency_Name ON core.Agency(AgencyName);

CREATE TABLE core.Participant (
    ParticipantID      INT IDENTITY(1,1) PRIMARY KEY,
    WebID              INT            NULL,
    SalutationID       INT            NULL REFERENCES ref.Salutation(SalutationID),
    AgencyID           INT            NULL REFERENCES core.Agency(AgencyID),
    StreetTypeID       INT            NULL REFERENCES ref.StreetType(StreetTypeID),
    CityID             INT            NULL REFERENCES ref.City(CityID),
    StateID            INT            NULL REFERENCES ref.State(StateID),
    FirstName          NVARCHAR(30)   NULL,
    LastName           NVARCHAR(30)   NULL,
    MiddleName         NVARCHAR(20)   NULL,
    HomePhone          NVARCHAR(15)   NULL,
    HomeFax            NVARCHAR(15)   NULL,
    WorkPhone          NVARCHAR(15)   NULL,
    WorkPhoneExt       NVARCHAR(6)    NULL,
    Address1           NVARCHAR(200)  NULL,
    Address2           NVARCHAR(50)   NULL,
    Zip                NVARCHAR(10)   NULL,
    Email              NVARCHAR(100)  NULL,
    Email2             NVARCHAR(100)  NULL,
    Email3             NVARCHAR(255)  NULL,
    Position           NVARCHAR(255)  NULL,
    GradeLevel         NVARCHAR(255)  NULL,
    IsParentMailingList  BIT NOT NULL DEFAULT 0,
    IsTeacherMailingList BIT NOT NULL DEFAULT 0,
    IsDirectorMailingList BIT NOT NULL DEFAULT 0,
    IsStaff            BIT NOT NULL DEFAULT 0,
    IsWcpss            BIT NOT NULL DEFAULT 0,
    HasCeuCertificate  BIT NOT NULL DEFAULT 0,
    HasChcCertificate  BIT NOT NULL DEFAULT 0,
    CreatedAt          DATETIME2(0)   NULL,
    UpdatedAt          DATETIME2(0)   NULL
);
CREATE INDEX IX_Participant_LastName  ON core.Participant(LastName, FirstName);
CREATE INDEX IX_Participant_Email     ON core.Participant(Email);   -- non-unique: 962 dup groups
CREATE INDEX IX_Participant_Agency    ON core.Participant(AgencyID);

CREATE TABLE core.WorkshopName (
    WorkshopNameID  INT IDENTITY(1,1) PRIMARY KEY,
    AgesID          INT           NULL REFERENCES ref.Age(AgesID),
    WorkshopName    NVARCHAR(255) NULL,
    ShortName       NVARCHAR(100) NULL,
    ECourseNum      INT           NULL,
    WLCourse        INT           NULL,
    Prerequisites   NVARCHAR(255) NULL,
    Description     NVARCHAR(MAX) NULL,
    TopicNums       NVARCHAR(15)  NULL,
    IsLiteracy      BIT NOT NULL DEFAULT 0
);

CREATE TABLE core.Workshop (
    WorkshopID       INT IDENTITY(1,1) PRIMARY KEY,
    LegacyWorkshopID INT           NULL,          -- tblWorkshops.WorkshopID_Old
    WorkshopNameID   INT           NULL REFERENCES core.WorkshopName(WorkshopNameID),
    EvalTypeID       INT           NULL REFERENCES ref.EvalType(EvalTypeID),
    ComponentID      INT           NULL REFERENCES ref.Component(ComponentID),
    CategoryID       INT           NULL REFERENCES ref.Category(CategoryID),
    AgencyID         INT           NULL REFERENCES core.Agency(AgencyID),
    SchoolYearID     INT           NULL REFERENCES ref.SchoolYear(SchoolYearID),
    WorkshopCode     NVARCHAR(10)  NULL,
    ESessionNum      INT           NULL,
    WLSession        INT           NULL,
    StartDate        DATETIME2(0)  NULL,
    EndDate          DATETIME2(0)  NULL,
    StartTime        TIME(0)       NULL,          -- from 1899-12-30 datetime
    EndTime          TIME(0)       NULL,
    DatesText        NVARCHAR(125) NULL,          -- legacy display strings retained
    TimesText        NVARCHAR(100) NULL,
    MaxEnrollment    INT           NULL,
    MinEnrollment    INT           NULL,
    ESchoolSeats     INT           NULL,
    Room             SMALLINT      NULL,
    IsBrochure       BIT NOT NULL DEFAULT 0,
    IsFolder         BIT NOT NULL DEFAULT 0,
    IsLabel          BIT NOT NULL DEFAULT 0,
    IsClosed         BIT NOT NULL DEFAULT 0,
    IsCancelled      BIT NOT NULL DEFAULT 0,
    IsContracted     BIT NOT NULL DEFAULT 0,
    IsWcpc           BIT NOT NULL DEFAULT 0,
    IsStaffDev       BIT NOT NULL DEFAULT 0,
    ConsultFee       DECIMAL(19,4) NULL,
    Cost1            DECIMAL(19,4) NULL,
    Cost2            DECIMAL(19,4) NULL,
    CreditPossible   NVARCHAR(50)  NULL,
    SessionCount     INT           NULL,
    SessionHours     FLOAT         NULL,
    SessionCeus      DECIMAL(19,4) NULL,
    ESchoolRegistered SMALLINT     NULL,
    ESchoolAttended  INT           NULL,
    ESchoolDropped   SMALLINT      NULL,
    ESchoolLateDropped INT         NULL,
    ESchoolNoShow    INT           NULL,
    EvaluationCount  SMALLINT      NULL,
    PracticeCount    SMALLINT      NULL,
    IsVirtual        INT           NULL,
    IsInPerson       INT           NULL,
    InternetYes      SMALLINT      NULL,
    InternetNo       SMALLINT      NULL,
    PublicRegistrations INT        NULL,
    Notes            NVARCHAR(MAX) NULL,
    SpecialNotes     NVARCHAR(MAX) NULL,
    IsFullyCodified  BIT NOT NULL DEFAULT 0,
    CreatedAt        DATETIME2(0)  NULL,
    UpdatedAt        DATETIME2(0)  NULL,
    CONSTRAINT CK_Workshop_Dates CHECK (EndDate IS NULL OR StartDate IS NULL OR EndDate >= StartDate)
);
CREATE INDEX IX_Workshop_SY_Start ON core.Workshop(SchoolYearID, StartDate);
CREATE INDEX IX_Workshop_Code   ON core.Workshop(WorkshopCode);

CREATE TABLE core.Registration (
    RegistrationID   INT IDENTITY(1,1) PRIMARY KEY,
    ParticipantID    INT NOT NULL REFERENCES core.Participant(ParticipantID),
    WorkshopID       INT NULL     REFERENCES core.Workshop(WorkshopID),
    CreditTypeID     INT NULL     REFERENCES ref.CreditType(CreditTypeID),
    PaymentID        INT NULL     REFERENCES core.Payment(PaymentID),
    PaymentMethodID  INT NULL     REFERENCES ref.PaymentMethod(PaymentMethodID),
    PayeeID          INT NULL     REFERENCES core.Payee(PayeeID),
    PaidAmount       DECIMAL(19,4) NULL,
    TicketCount      INT          NULL,
    IsScholarship    BIT NOT NULL DEFAULT 0,
    RegistrationDate DATETIME2(0) NULL,
    IsCancelled      BIT NOT NULL DEFAULT 0,
    Notes            NVARCHAR(255) NULL,
    EmailConfirmation BIT NOT NULL DEFAULT 0,
    ReceiptNumber    INT          NULL,
    CheckNumber      INT          NULL,
    CheckTotal       DECIMAL(19,4) NULL,
    PaidDate         DATETIME2(0) NULL,
    Attended         BIT NOT NULL DEFAULT 0,
    UpdatedAt        DATETIME2(0) NULL
);
CREATE INDEX IX_Registration_Workshop    ON core.Registration(WorkshopID);
CREATE INDEX IX_Registration_Participant ON core.Registration(ParticipantID);
CREATE INDEX IX_Registration_Payment     ON core.Registration(PaymentID);
```

The remaining 60 tables follow the same pattern. The full mapping table is generated by the ETL script (§6.3) so it is always in sync with reality.

### 5.3 Integrity rules to add (Access had none)

| Rule | Rationale |
| --- | --- |
| `core.Registration.WorkshopID` → `core.Workshop` FK | 2 orphans must be quarantined first |
| `core.WorkshopSession.WorkshopID` → `core.Workshop` FK | 11 orphans |
| `core.WorkshopPresenter.WorkshopID` → `core.Workshop` FK | 11 orphans |
| `core.SessionParticipant` composite PK → both parents | Already clean |
| `CK_Workshop_Dates` | Catches the 9 inverted date ranges going forward |
| `core.Participant.Email` **indexed but not unique** | 962 duplicate groups; uniqueness needs a business decision first |
| `audit.ChangeLog` trigger on all `core` tables | Replaces the three `BeforeUpdate` handlers and gives a real audit trail |

### 5.4 Derived data — replace stored totals with views

`tblWorkshops.TotalRegistrations` and `TotalParticipants` are stored doubles that drift. Replace with a view:

```sql
CREATE VIEW core.vw_WorkshopCounts AS
SELECT w.WorkshopID,
       COUNT(DISTINCT r.RegistrationID)                       AS TotalRegistrations,
       COUNT(DISTINCT r.ParticipantID)                        AS TotalParticipants,
       COUNT(DISTINCT CASE WHEN r.Attended = 1 THEN r.ParticipantID END) AS TotalAttended
FROM core.Workshop w
LEFT JOIN core.Registration r ON r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0
GROUP BY w.WorkshopID;
```

The same treatment applies to the 5 `stbl*` staging tables: they are report-support caches and are **not migrated**. Their queries are rewritten as views over live data.

---

## 6. Data migration strategy

### 6.1 Approach

A **scripted, idempotent ETL** in TypeScript, run against a restore-and-reload loop. SSMA is not recommended here: it would generate hundreds of linked-table stubs and convert all 150 queries into unreadable views, and the schema is small enough that explicit control is cheaper than curating generated output.

```
Access .accdb
   │  1. extract   (odbc: "Microsoft Access Driver (*.mdb, *.accdb)")
   ▼
staging.*  (raw, all NVARCHAR(MAX) — nothing is lost or coerced)
   │  2. profile   (counts, nulls, orphans, duplicates, type inference)
   ▼
staging.profile_report.json  ← reviewed by domain expert
   │  3. transform (type coercion, renames, lookup resolution, quarantine)
   ▼
core.* / ref.*  (IDENTITY_INSERT to preserve original IDs)
   │  4. verify    (row counts, checksums, FK validity, spot samples)
   ▼
migration_report.md  ← sign-off gate
```

### 6.2 Why staging-first

Loading straight into `core` would make every mapping mistake destructive and hard to diagnose. Landing everything as text in `staging` means the transform step can be re-run indefinitely while the mapping rules are refined, and every rejected row lands in `staging.Quarantine` with a reason instead of being silently dropped.

### 6.3 Key ETL rules

| Rule | Detail |
| --- | --- |
| **Preserve IDs** | `SET IDENTITY_INSERT core.Workshop ON` … insert with legacy `WorkshopID` … `OFF`. Referential links stay valid with zero re-mapping |
| **Yes/No** | `NULL → 0`, `True → 1`, `False → 0` |
| **Time-only columns** | `StartTime`/`EndTime` store `1899-12-30 HH:MM`; extract `CAST(col AS TIME)` |
| **Hyperlink columns** | Split on `#`; keep the display segment, keep the URL in a `*_Url` column if non-empty |
| **Negative payments** | Load as-is into a `PaidAmount` that permits negatives; flag rows in the report for staff confirmation |
| **Duplicates** | Do **not** merge. Load all 14,435 participants; emit a duplicate-email report for a later merge decision |
| **Orphans** | Write to `staging.Quarantine` with `TableName`, `RowID`, `Reason`, `RawJson`; do not load |
| **Excluded objects** | `aTempGroup`, `Paste Errors`, `aTempEmails`, `lnkEmailsToRemove`, all `stbl*`, `tblWorkshopEvalSummaries_OLD`, `Switchboard Items` |
| **Obsolete reports** | The 8 `OLD_*` reports are not rebuilt (see §8.4) |

### 6.4 Verification gates

The migration is not "done" until all of these pass:

1. **Row-count parity** — every table's source count equals the target count plus its quarantine count.
2. **Checksum parity** — `CHECKSUM_AGG(BINARY_CHECKSUM(*))` per table, compared to a checksum computed from the Access extract.
3. **FK validity** — zero rows violate any constraint after load.
4. **Financial reconciliation** — `SUM(PaidAmount)` per school year matches the Access totals exactly; the 189 negative rows are individually listed.
5. **Spot samples** — 20 randomly selected registrations compared field-by-field by the domain expert.
6. **Report parity** — for 10 representative reports, the PDF totals match the Access report totals for the same parameters.

---

## 7. Application design

### 7.1 Navigation (replaces the Access switchboard)

The Access switchboard has 6 top-level items. The web app keeps the same mental model so retraining is minimal, adding a dashboard as the landing page.

| Access switchboard item | Web route |
| --- | --- |
| *(none — new)* | `/` — Dashboard |
| Add/Edit Data | `/data/*` — Workshops, Participants, Agencies, Presenters, Payments, Credit Slips, Training Requests, Community Events |
| Preview/Print Folder Reports… | `/folders` |
| Preview/Approve Workshops… | `/workshops/approval` |
| Preview Date Range Reports… | `/reports?range=` |
| Preview Administrative Reports… | `/reports/admin` |
| Utilities… | `/admin/utilities` |

### 7.2 Screen inventory

| # | Screen | Replaces | Key capability |
| --- | --- | --- | --- |
| 1 | Dashboard | — | Current SY counts, upcoming workshops, unpaid registrations, recent activity |
| 2 | Workshops list | `frmWorkshops` (175 controls) | Virtualized grid, filter by SY/category/status, inline status pills |
| 3 | Workshop detail | `frmWorkshops` + 12 subforms | Tabs: Details · Sessions · Presenters · Registrations · Evaluations · Comments · Topics · Referrals |
| 4 | Workshop catalog | `frmWorkshopNames` | Reusable definitions with rich-text description |
| 5 | Participants list | `frmParticipants` (85 controls) | Search by name/email/agency, dedupe hints on save |
| 6 | Participant detail | `frmParticipants` + subforms | Registrations, credit slips, certificates, mailing flags |
| 7 | Agencies | `frmAgencies` | Address, mailing address, director, board members |
| 8 | Presenters & staff | `frmPresentersAndStaff` | Contact details, retired flag |
| 9 | Registrations | `sfrmWorkshopRegistrations` | Bulk add, payment assignment, attendance toggle |
| 10 | Attendance | `sfrmWorkshopAttendance` | Per-session checklist with late flag |
| 11 | Payments & receipts | `frmPayments` | Receipt numbering, payee, method |
| 12 | Credit slips | `frmCreditSlips` | Issue/redeem, tracking year, email flag |
| 13 | Training requests | `frmTrainingRequests` | Quote → schedule → invoice workflow |
| 14 | Community events | `frmCommunityEvents` | Event + staff + attendance counts |
| 15 | eSchools reconciliation | `frmESchoolsEntry` | Side-by-side seat counts |
| 15a | **Workshop registration link** | *(new)* | Shareable public link, open/close + revoke toggles, web seat cap — see [public-registration](../features/public-registration.md) |
| 16 | Folder builder | `dlgFolderForms` | Pick workshop → generate full packet |
| 17 | Reports hub | `dlgReportsDateRange`, `dlgObservationsDateRange` | Parameter form → preview → PDF |
| 18 | Mailing lists | `dlgCreateEmailList` | Build, preview, export CSV, send |
| 19 | Utilities | 10 macros + action queries | Backup, dedupe, reset flags, recalc |
| 20 | Admin | — | Users, roles, SY close, audit log |

### 7.3 API surface — full REST API with Swagger UI

The API is the backbone of the app: staff enter data as requests arrive, the public form writes registrations, and reports read from the same layer. It is therefore specified as a **complete CRUD REST API**, not a handful of endpoints.

#### 7.3.1 Contract-first with OpenAPI 3.1

The OpenAPI document is the **source of truth**, not an afterthought generated from code.

| Concern | Decision |
| --- | --- |
| Specification | **OpenAPI 3.1** (JSON Schema 2020-12 — aligns with Zod) |
| Authoring | Zod schemas in `packages/shared`, converted to OpenAPI via `@asteasolutions/zod-to-openapi` |
| Documentation UI | **Scalar** at `/docs` (default) or **Swagger UI** at `/swagger` — both served from the same document |
| Runtime validation | Fastify validates requests/responses against the same schemas — no drift between docs and behaviour |
| Client generation | `openapi-typescript` produces the frontend's typed client from the published spec |
| Versioning | Spec published at `/openapi.json`; breaking changes bump a URL prefix (`/api/v2`) |

**Why contract-first matters here:** the frontend, the public form, and any future integrations all consume the same contract. If the spec is generated from code, a renamed field silently breaks consumers; if the spec is written first, the compiler catches it.

#### 7.3.2 Resource endpoints — full CRUD

Every core entity gets the same five operations. `GET` collection endpoints support filtering, sorting, and pagination.

| Resource | Collection | Item |
| --- | --- | --- |
| Workshops | `GET/POST /api/workshops` | `GET/PATCH/DELETE /api/workshops/:id` |
| Workshop catalog | `GET/POST /api/workshop-names` | `GET/PATCH/DELETE /api/workshop-names/:id` |
| Sessions | `GET/POST /api/workshops/:id/sessions` | `GET/PATCH/DELETE /api/sessions/:id` |
| Presenters | `GET/POST /api/presenters` | `GET/PATCH/DELETE /api/presenters/:id` |
| Participants | `GET/POST /api/participants` | `GET/PATCH/DELETE /api/participants/:id` |
| Agencies | `GET/POST /api/agencies` | `GET/PATCH/DELETE /api/agencies/:id` |
| Board members | `GET/POST /api/agencies/:id/board-members` | `GET/PATCH/DELETE /api/board-members/:id` |
| Registrations | `GET/POST /api/registrations` | `GET/PATCH/DELETE /api/registrations/:id` |
| Payments | `GET/POST /api/payments` | `GET/PATCH/DELETE /api/payments/:id` |
| Payees | `GET/POST /api/payees` | `GET/PATCH/DELETE /api/payees/:id` |
| Credit slips | `GET/POST /api/credit-slips` | `GET/PATCH/DELETE /api/credit-slips/:id` |
| Attendance | `GET/POST /api/sessions/:id/attendance` | `PATCH /api/attendance/:sessionId/:participantId` |
| Community events | `GET/POST /api/community-events` | `GET/PATCH/DELETE /api/community-events/:id` |
| Training requests | `GET/POST /api/training-requests` | `GET/PATCH/DELETE /api/training-requests/:id` |
| Training quotes | `GET/POST /api/training-requests/:id/quotes` | `GET/PATCH/DELETE /api/training-quotes/:id` |
| Evaluations | `GET/POST /api/workshops/:id/evaluations` | `GET/PATCH/DELETE /api/evaluations/:id` |
| **All lookups** (`ref.*`) | `GET/POST /api/lookups/:name` | `GET/PATCH/DELETE /api/lookups/:name/:id` |

The lookup endpoints are generic — one route serves all 28 `ref.*` tables, so adding a lookup needs no new code.

#### 7.3.3 Conventions every endpoint follows

| Convention | Detail |
| --- | --- |
| **Pagination** | `?page=1&pageSize=50` (max 200). Response: `{ data, page, pageSize, total }` |
| **Filtering** | Query params per resource, e.g. `?schoolYear=21&status=open` |
| **Sorting** | `?sort=startDate:desc` — whitelisted columns only |
| **Search** | `?q=` for free-text on the resource's indexed columns |
| **Partial update** | `PATCH` with only the changed fields (not `PUT`) — matches how forms save |
| **Soft delete** | `DELETE` sets a flag where history matters (registrations, payments); hard delete only for lookups |
| **Validation errors** | `422` with a field-level array: `{ errors: [{ path, message }] }` |
| **Concurrency** | `If-Match` with a row version on `PATCH`; `409` on conflict |
| **Idempotency** | `Idempotency-Key` header honoured on `POST` — matters for the public form |
| **Audit** | Every write records who/what/when to `audit.ChangeLog` |

#### 7.3.4 Non-CRUD operations

Some actions are not plain CRUD and get their own routes:

```
POST /api/workshops/:id/registration-link      # issue/rotate the public link
POST /api/workshops/:id/close                  # close registration
POST /api/credit-slips/:id/redeem
POST /api/payments/:id/receipt                 # generate receipt PDF

GET  /api/reports                              # catalog
POST /api/reports/:key/render                  # returns job id
GET  /api/reports/:key/:jobId.pdf

GET  /api/mailing-lists/:key?schoolYear=21
POST /api/mailing-lists/:key/export

POST /api/admin/utilities/:key/run             # admin only
```

#### 7.3.5 Public endpoints (no auth)

Mounted under `/api/public`, rate-limited, and unable to reach internal routes — see [public-registration](../features/public-registration.md).

```
GET  /api/public/registration-links/:slug
POST /api/public/registration-links/:slug/match
POST /api/public/registration-links/:slug/registrations
GET  /api/public/registrations/:token/confirm
POST /api/public/registrations/:token/cancel
```

#### 7.3.6 Documentation and discoverability

| Surface | URL | Audience |
| --- | --- | --- |
| **Swagger UI** | `/swagger` | Staff developers, integrations — familiar, supports "Try it out" |
| **Scalar** | `/docs` | Default landing — cleaner reading experience |
| **OpenAPI JSON** | `/openapi.json` | Tooling, client generation, CI contract tests |
| **Health** | `/health`, `/health/ready` | Ops, container probes |

Both UIs render the same document, so they cannot disagree. In non-production they are unauthenticated; in production they sit behind SSO.

#### 7.3.7 Acceptance criteria

- Every `core.*` and `ref.*` table is reachable through the API.
- The OpenAPI document validates against the 3.1 schema in CI.
- A generated TypeScript client compiles against the spec with zero `any`.
- Swagger UI "Try it out" works end-to-end against a seeded database.
- Contract tests fail the build if a response shape drifts from the spec.

### 7.4 Roles

| Role | Capability |
| --- | --- |
| `viewer` | Read-only access to data and reports |
| `editor` | Create/edit participants, agencies, workshops, registrations, payments |
| `manager` | Editor + approve/close workshops, run folder and mailing workflows |
| `admin` | Everything + utilities, user management, school-year close |

---

## 8. Reports — the largest work item

112 reports is where this project will succeed or fail. They are not 112 distinct problems: they cluster into **7 families**, and each family needs one template plus a parameter set.

### 8.1 Report families

| Family | Count | Shared template | Notes |
| --- | --- | --- | --- |
| **Folder packet** (`rptFolder*`) | 34 | Roster / Attendance slip / Evaluation / Contact list / Banner / Label | Grouped by workshop; printed as one PDF packet |
| **Brochure** (`rptBrochure*`) | 12 | Teacher / Parent / Web / E-Schools variants | Chronological and grouped layouts; print + web upload |
| **Evaluation summaries** (`rptWorkshopEval*`, `rptAttendSum*`) | 14 | Crosstab by question, by workshop, by category | Needs `PIVOT`; the Access crosstabs map cleanly |
| **Certificates** (`rptCEUCertificate*`, `rptCHCCertificate*`) | 6 | Certificate + detail sheet | Fixed layout, one per participant |
| **Email/confirmation** (`rptEmail*`) | 8 | Confirmation letter, gift certificate email | Merge fields from participant + workshop |
| **Training requests** (`rptTrainingRequest*`, `rptReceipt*`) | 8 | Quote / Invoice / Receipt | Agency-facing; needs the WCPSS look |
| **Administrative** (`rptAttend*`, `rptNCDemo*`, `rptCommEvents*`, `rptWorkshops*`, `rptRefund*`, `rptSaturday*`, `rptDesiredTopics`, `rptPreferredTimes`, `rptBackupSchedule*`, `rptNotPaidRegistrations`, `rptObservationsDateRange`, `rptESchoolsPercentages`, `rptPaymentRegistrationsCurrent`, `rptReceiptsCurrent`, `rptWorkshopAttendUndup`, `rptWorkshopEvalScores`, `rptWorkshopEvalSummary`, `rptWorkshopsCurrentCheckList`, `rptWorkshopsDateRange*`) | ~22 | Parameter form + table | Mostly views + a generic tabular template |
| **Obsolete** (`OLD_*`) | 8 | — | **Not rebuilt** — confirm with staff |

### 8.2 Report implementation pattern

Every report is a React component rendered server-side to HTML, then printed to PDF by Chromium:

```
ReportDefinition { key, title, family, params: ZodSchema, query(ctx, params) → rows, template }
```

1. **Parameter form** — generated from `params` (date range, school year, category, workshop picker).
2. **Query** — a Kysely query or SQL view per report; ported from the Access SQL with the same filters.
3. **Template** — one React component per family, with per-report overrides only where the layout genuinely differs.
4. **Output** — HTML preview in-browser; PDF via Playwright for print, email attachment, and archive.

### 8.3 Report parity testing

For each report, capture the Access output as a PDF for a fixed parameter set **before** decommissioning Access. Store these as golden files. The test suite renders the new report with the same parameters and compares:
- row counts and group counts,
- all numeric totals (exact),
- column headers and order.

Visual diffing is a manual review step, not an automated gate — pixel comparison of Access vs. web output is not meaningful given the intentional restyle.

### 8.4 Scope decision needed

**The 8 `OLD_*` reports** (`OLD_rptParentRosterSpanish`, `OLD_rptParentRosterSpanishBlank`, `OLD_rptSchedulesCalendarAll`, `OLD_rptTeacherSurveyProductionArea`, and 4 more) should be confirmed as dead before Phase 4. Dropping them removes ~7% of the report work.

### 8.5 Charts (Recharts)

Staff will want to read trends, not just tables. **Recharts** is the charting library for the app — declarative React SVG, composes with the existing component layer, and needs no additional build step.

**Where charts add value.** Most of the 112 Access reports are tabular and stay tabular. Charts suit the ~22 administrative reports: attendance trends by school year, evaluations by category, registrations per workshop, revenue by month, desired topics and preferred times.

**The print caveat.** Recharts renders client-side SVG. Playwright's PDF renderer must wait for a chart to paint before printing, or the output will be blank. Two rules follow:

| Report kind | Approach |
| --- | --- |
| Fixed-layout print documents (certificates, folder packets, brochures) | **No charts.** These are print artifacts; charts would not survive the layout |
| Chart-based analytical reports | Render the chart, wait for paint, then print — or render the underlying table in the PDF and keep the chart on screen only |

**Keep the layers separate.** The query layer returns data; the template layer decides whether that data is shown as a table, a chart, or both. One query should be able to feed a table and a chart without duplication — this keeps report parity testing (§8.3) meaningful, because the numbers being compared come from the same source.

**Accessibility.** Charts must not be the only way to read the data. Every chart needs an accessible table equivalent (visually hidden or toggleable), and colours must not be the sole carrier of meaning — WCAG 2.1 AA applies to charts as much as to forms.

### 8.6 Certificate template customization

In Access, staff can open `rptCEUCertificate` in design view and change the logo, title, signatory names, and which fields print. **Losing that is a capability regression**, so the certificate template is configurable in the app rather than hardcoded.

**Scope: certificates only.** Folder packets, brochures, receipts, and confirmation letters stay developer-built for now — they have far more layout variance and lower change frequency.

#### 8.6.1 What staff can change

| Setting | Control | Notes |
| --- | --- | --- |
| **Logo** | Image upload (PNG/SVG, ≤ 1 MB) | Versioned per school year — old certificates keep the logo they were issued with |
| **Title** | Text | Default: "Certificate of Credit" |
| **Subtitle / organisation block** | Rich text | Default: Project Enlightenment, address |
| **Program Director name + title** | Text | Appears above the signature line |
| **Approving Director name + title** | Text | Second signature block |
| **Footer disclaimer** | Text | Default keeps the WCPSS-employee notice |
| **Field visibility** | Toggles per field | See §8.6.2 |
| **Credit-unit label** | Text | "Unit(s) of Renewal Credit" for CEU, "Child Care Hours" for CHC |

**Not configurable:** layout, field positions, page size, fonts. Those require a developer. Stating this explicitly sets expectations — it is the line between "configurable template" and "report designer", and the latter is a product in its own right.

> **Decision (2026-11-19): no Canva / external design upload.** Staff customize the certificate entirely within the app using the settings below. A Canva export was considered as a background-image option and rejected: the exported PDF/PNG flattens text into an image, so the certificate would lose selectable, searchable, screen-reader-readable text — an accessibility problem for a public school district. It would also make the app depend on an external tool, and the merge fields would not follow if staff moved a field in Canva. The app owns the layout; staff own the content.

#### 8.6.2 Field visibility

The current Access certificate prints **Social Security Number** and the **full home address**. Both are legacy artifacts and should be off by default.

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
| **Home address** | **Off** | Unnecessary exposure; city/ZIP optional |
| Certificate expiration date | Off | Only meaningful for some certificate types |

Staff can turn any of these back on, but the defaults are the safe ones.

#### 8.6.3 Data model

```sql
CREATE TABLE core.CertificateTemplate (
    CertificateTemplateID INT IDENTITY(1,1) PRIMARY KEY,
    SchoolYearID          INT           NOT NULL REFERENCES ref.SchoolYear(SchoolYearID),
    CertificateType       NVARCHAR(10)  NOT NULL,   -- 'CEU' | 'CHC'
    Title                 NVARCHAR(200) NULL,
    Subtitle              NVARCHAR(500) NULL,
    LogoPath              NVARCHAR(400) NULL,
    ProgramDirectorName   NVARCHAR(100) NULL,
    ProgramDirectorTitle  NVARCHAR(100) NULL,
    ApprovingDirectorName NVARCHAR(100) NULL,
    ApprovingDirectorTitle NVARCHAR(100) NULL,
    CreditUnitLabel       NVARCHAR(100) NULL,
    FooterText            NVARCHAR(500) NULL,
    VisibleFields         NVARCHAR(MAX) NULL,       -- JSON array of field keys
    UpdatedAt             DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
    -- No unique constraint on (SchoolYearID, CertificateType): a year may have
    -- several templates of the same type (migration 014). A Name column tells
    -- them apart.
);
```

**Versioned by school year** so a certificate reissued for SY 2024-25 still uses that year's logo and signatories. Templates are never edited in place across years — a new school year gets a copy.

#### 8.6.4 Staff workflow

```
Certificates → Template settings
  ├─ Pick school year + certificate type (CEU / CHC)
  ├─ Upload logo · edit title, signatories, footer
  ├─ Toggle which fields print
  ├─ Live preview against a real attendee (picker) — updates as you type
  └─ Save  →  applies to all certificates generated from now on
```

**Live preview is the key affordance.** Staff see the actual PDF layout with real data before saving, which is what makes the settings safe to use without a developer.

#### 8.6.5 Generating certificates

```
Workshop detail → Registrations → select attendees
  → Preview (one page per attendee)
  → Download PDF (single or combined)
```

Rendered by Playwright from the same template used for preview. On a phone, staff see a scaled preview and a **Download PDF** action — the certificate is never reflowed (§8.5).

#### 8.6.6 Acceptance criteria

- A staff member changes the logo and title, previews against a real attendee, and saves — without developer involvement.
- Certificates generated before a template change keep their original logo and signatories.
- SSN and home address are absent from the PDF by default.
- The PDF is print-accurate at 8.5×11 with no reflow between preview and print.

---

## 9. Phased delivery plan

Timeline assumes one full-stack developer with part-time domain-expert availability. Two developers compress Phases 2–4 substantially.

### Phase 0 — Foundations (1 week)

| Task | Output |
| --- | --- |
| Confirm SQL Server target and hosting | Decision recorded |
| Extract full schema + queries to `docs/discovery/` | Reproducible inventory (already captured — commit it) |
| Create repo structure (`apps/api`, `apps/web`, `packages/shared`, `db/`) | Monorepo skeleton |
| Implement WCPSS token layer and base components | Button, Card, Table, Pill, FormField |
| **Responsive primitives** — breakpoints, bottom tab bar shell, card-row table pattern | Mobile-first foundation (see [responsive-mobile](../features/responsive-mobile.md)) |
| **Decide public hosting split** — internet-facing form vs. internal staff app; domain | Architecture decision |
| **OpenAPI pipeline** — Zod schemas → OpenAPI 3.1, Swagger UI + Scalar mounted, client generation in CI | API contract foundation (see §7.3) |
| **`.gitignore` + secret hygiene** — env files, `*.accdb`, build output | Nothing sensitive reaches the repository |
| CI: lint, typecheck, unit tests | Green pipeline |

**Exit criteria:** `npm run dev` serves a themed shell that works at 320 px; CI is green.

### Phase 1 — Schema + ETL + verification (2–3 weeks)

| Task | Output |
| --- | --- |
| Author `db/schema.sql` for all 70 tables across 4 schemas | DDL |
| Build extract → staging loader | `staging.*` populated |
| Build profiler | `profile_report.json` |
| Resolve 6 open data questions (§11) | Decisions recorded |
| Build transform + quarantine | `core.*`/`ref.*` populated |
| Build verification suite | `migration_report.md`, all gates green |
| Restore-and-reload rehearsal ×3 | Repeatable, timed run |

**Exit criteria:** all §6.4 gates pass; the domain expert signs off on spot samples.

### Phase 2 — Core application (4 weeks)

| Week | Deliverable |
| --- | --- |
| 1 | Auth, roles, app shell, dashboard, API scaffolding |
| 1 | **OpenAPI contract + Swagger UI** — spec pipeline, `/swagger` and `/docs` live, client generation wired into CI |
| 2 | Participants + Agencies (list, detail, create/edit, dedupe hints) |
| 3 | Workshops + catalog + sessions + presenters |
| 4 | Registrations + payments + attendance + credit slips |

Every screen in this phase is built responsive from the start, with attendance optimised for phone use. Each screen's CRUD is backed by the documented API rather than bespoke endpoints.

**Exit criteria:** staff can complete a full registration cycle in the new app for a test workshop, and take attendance for it on a phone.

### Phase 2b — Public registration (2 weeks, parallel with Phase 3)

Schema (`WorkshopRegistrationLink`, `Registration.Source`, `audit.PublicSubmission`), staff-side link panel with active/inactive toggles, and the public API (link resolution, participant matching, submission, confirmation). See [public-registration](../features/public-registration.md).

**Exit criteria:** a test workshop is opened for web registration and a submission lands on the roster with `Source = 'Web'`.

### Phase 3 — Reports, part 1 (3 weeks)

Folder packet (34) and brochure (12) families. These are the highest-frequency, highest-risk outputs.

**Exit criteria:** a real workshop's folder packet and brochure are produced from the new app and reviewed by staff.

### Phase 4 — Reports, part 2 + workflows (3 weeks)

Evaluation summaries, certificates, email/confirmations, training requests, administrative reports. Mailing lists, eSchools reconciliation, utilities.

**Certificates:** one template covers the whole family — `CEU` and `CHC` variants differ only in title, credit-unit label, and footer. Output is a print-ready PDF (8.5×11) generated from the same HTML template used for preview. The certificate is never reflowed for mobile — on a phone, staff see a scaled preview and a **Download PDF** action. Logo, title, signatories and field visibility are **staff-configurable per school year, entirely within the app** (see §8.6).

**Exit criteria:** all in-scope reports have golden-file parity; utilities replace the 10 macros.

### Phase 5 — Parallel run + cutover (2 weeks)

| Step | Detail |
| --- | --- |
| Parallel run | Access remains the system of record; new app runs read-only against a nightly refresh |
| Reconciliation | Daily row-count and financial diff between the two |
| Freeze | Final delta sync; Access set to read-only |
| Cutover | New app becomes system of record; Access archived |
| Hypercare | 2 weeks of daily triage |

**Exit criteria:** two consecutive weeks with zero reconciliation differences.

### Timeline summary

| Phase | Duration | Cumulative |
| --- | --- | --- |
| 0 Foundations | 1 wk | 1 |
| 1 Schema + ETL | 2–3 wk | 3–4 |
| 2 Core app | 4 wk | 7–8 |
| 2b Public registration | 2 wk (parallel) | 8–9 |
| 3 Reports pt.1 + public form UI | 3 wk | 10–11 |
| 4 Reports pt.2 | 3 wk | 13–14 |
| 5 Parallel + cutover | 2 wk | 15–16 |

Phase 2b runs alongside Phase 3 and does not extend the critical path. The public form **UI** is built in Phase 3, mobile-first, against the performance budget in [responsive-mobile §8](../features/responsive-mobile.md).

---

## 10. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| 1 | **Report scope creep** — 112 reports is the dominant cost | High | High | Family-based templates; confirm the 8 `OLD_*` are dead; agree the in-scope list in Phase 0 |
| 2 | **Undocumented business rules** — no VBA, so logic lives in staff heads | High | High | Weekly domain-expert sessions in Phase 1–2; record rules in `docs/features/` |
| 3 | **Duplicate participants** (962 email groups) | High | Medium | Load as-is; build a merge tool in Phase 2; never auto-merge |
| 4 | **Negative payments** (189) sign convention unknown | Medium | Medium | Resolve in Phase 1 before financial reconciliation |
| 5 | **Access-only behaviour** — e.g. `TempVars` switchboard, `DoCmd`-driven flows | Medium | Medium | Inventory every macro; each maps to an explicit UI action |
| 6 | **`lnkEmailsToRemove` on `S:\`** — a manual Excel exclusion list | Medium | Low | Replace with a proper suppression table + admin screen |
| 7 | **Print fidelity** — staff expect the exact folder layout | Medium | High | Golden-file parity in Phase 3; physical print test before cutover |
| 8 | **Single-developer bus factor** | Medium | High | Documented schema, ETL, and report patterns; everything in source control |
| 9 | **Parallel-run drift** | Medium | High | Nightly refresh + automated daily reconciliation |
| 10 | **Entra ID integration delays** | Low | Medium | Local accounts as fallback; auth is a Phase 2 week-1 task |
| 11 | **Branding misuse** | Low | Low | Palette/typography only; no logo or layout copying; Communications sign-off if public |
| 12 | **SQL Server licensing for production** | Low | Medium | Developer Edition for dev; confirm Standard licensing before Phase 5 |
| 13 | **Seat-count reconciliation across three sources** — web form, eSchools (manually typed), and manual entry. All Access registration data is manually derived, so the combined count is always slightly stale | High | High | Separate `WebSeatCap` per workshop (see [public-registration §5](../features/public-registration.md)); coarse availability bands; never enforce `MaxEnrollment` across all sources until staff data entry is proven timely |
| 14 | **Public form abuse** — the link is the only access control | High | Medium | Opaque revocable slugs; rate limits per IP/email/link; honeypot + timing check; email confirmation before a seat is held |
| 15 | **Mobile retrofit cost** — screens designed desktop-first are expensive to make responsive later | Medium | High | Responsive primitives land in Phase 0; "works at 320 px" is a per-screen acceptance criterion (see [responsive-mobile](../features/responsive-mobile.md)) |
| 16 | **Public form accessibility failure** — a public school district form is subject to WCAG 2.1 AA | Medium | High | Manual keyboard + screen-reader passes per phase; axe scan in CI; no CAPTCHA by default |

---

## 11. Open questions for review

These block or shape specific phases. Owner and phase in brackets.

| # | Question | Blocks |
| --- | --- | --- |
| 1 | **SQL Server confirmed?** Or is there an organizational mandate for MySQL / a Linux host? | Phase 0 |
| 2 | **Where will production run?** Azure is confirmed for the public form; confirm the staff app host too | Phase 0, Phase 5 |
| 3 | **Duplicate emails (962 groups)** — merge, keep-all, or flag? | Phase 1 |
| 4 | **Negative `PaidAmt` (189 rows)** — are these refunds, adjustments, or errors? | Phase 1 |
| 5 | **78 registrations with no workshop** — archive or keep? | Phase 1 |
| 6 | **Are the 8 `OLD_*` reports dead?** | Phase 3 |
| 7 | **Authentication** — Entra ID/WakeID SSO, or local accounts? | Phase 2 |
| 8 | **Who is the domain expert** and how many hours per week? | All phases |
| 9 | **Is the app internal-only**, or will agencies see training-request quotes/invoices? | Phase 4 (drives branding sign-off) |

> **Resolved:** the app is no longer internal-only. A public registration form is confirmed (see [public-registration](../features/public-registration.md)), so branding sign-off with Communications is required before Phase 3. Question 9 now applies only to training-request quotes/invoices.
| 10 | **Does eSchools have an API** we can integrate with, or is manual reconciliation permanent? | Phase 4 |
| 11 | **Retention** — how many school years must remain queryable in the app? | Phase 0 (affects indexing) |
| 12 | **Printing** — do staff print from the app, or export PDF to a print queue? | Phase 3 |
| 13 | **Public form payment methods** — the vendor handles payment, so what does the form record? | Phase 2 (see [public-registration §11](../features/public-registration.md)) |
| 14 | **Public domain / subdomain** and hosting split (internet-facing form vs. internal staff app) | Phase 0 |
| 15 | **Offline scope** — is attendance-only offline support enough, or is full offline data needed? | Phase 0 (see [responsive-mobile §7](../features/responsive-mobile.md)) |

---

## 12. Deliverables and next steps

### Immediate (this week)

1. Review this plan and answer the open questions in §11.
2. Commit the discovery artifacts — the schema inventory, query list, form/report list, and data-quality results — into `docs/discovery/`.
3. Confirm SQL Server as the target and identify the production host.

### Phase 0 kickoff

4. Create the monorepo (`apps/api`, `apps/web`, `packages/shared`, `db/`).
5. Land the WCPSS token layer and base components.
6. Schedule the first domain-expert session; start the business-rule register in `docs/features/`.

### Companion artifacts

| File | Purpose |
| --- | --- |
| `docs/plans/access-migration.md` | This plan (source of truth) |
| `docs/plans/access-migration.html` | Styled, self-contained HTML version for sharing |
| `docs/plans/access-migration.pdf` | Printable PDF with UI mockups |
| `docs/features/public-registration.md` | Public per-workshop registration form — data model, API, abuse protection |
| `docs/features/responsive-mobile.md` | Breakpoints, navigation, per-screen mobile treatment, WCAG 2.1 AA |

---

## Appendix A — Full object inventory

### A.1 Core tables

| Table | Rows | PK | Purpose |
| --- | --- | --- | --- |
| `tblWorkshops` | 2,598 | `WorkshopID` | Scheduled workshop offerings (57 columns) |
| `tblWorkshopNames` | 804 | `WorkshopNameID` | Catalog definitions |
| `tblWorkshopSessions` | 3,677 | `WorkshopSessionID` | Dated sessions |
| `tblWorkshopPresenters` | 3,131 | `WorkshopPresenterID` | Workshop ↔ staff |
| `tblParticipants` | 14,435 | `ParticipantID` | People |
| `tblAgencies` | 811 | `AgencyID` | Organizations |
| `tblAgencyMailAddresses` | 65 | `AgencyID` | Separate mailing address |
| `tblBoardMembers` | 36 | `BoardID` | Agency board contacts |
| `tblRegistrations` | 41,345 | `RegistrationID` | Enrollments |
| `tblPayments` | 6,034 | `PaymentID` | Payments |
| `tblPayees` | 3,003 | `PayeeID` | Who pays |
| `tblSessionParticipants` | 36,686 | `ParticipantID`+`WorkshopSessionID` | Per-session attendance |
| `tblCreditSlips` | 846 | `CreditSlipID` | Vouchers |
| `tblPresentersAndStaff` | 159 | `PresenterStaffID` | Staff roster |
| `tblTrainingRequests` | 108 | `TrainingRequestID` | On-site requests |
| `tblTrainingRequestsContacts` | 463 | `TrainingRequestContactID` | Request contact log |
| `tblTrainingRequestsQuotes` | 126 | `TrainingRequestQuoteID` | Quotes |
| `tblTrainingRequestsScheduled` | 84 | `TrainingRequestID`+`WorkshopID` | Scheduled requests |
| `tblTrainingRequestsPayments` | 68 | `TrainingRequestID`+`PaymentID` | Request payments |
| `tblCommunityEvents` | 399 | `EventID` | Outreach events |
| `tblCommunityEventStaff` | 620 | `EventID`+`StaffID` | Event staffing |
| `tblEvalQuestions` | 33 | `EvalQuestID` | Evaluation question bank |
| `tblWorkshopEvalQuestions` | 3,540 | `WorkshopEvaluations` | Evaluation responses |
| `tblWorkshopComments` | 1,371 | `WorkshopCommentID` | Free-text comments |
| `tblWorkshopPresenterComments` | 119 | `WorkshopPresenterCommentID` | Presenter comments |
| `tblWorkshopsLikedMost` | 1,457 | `LikedMostID` | Evaluation detail |
| `tblWorkshopsLikedLeast` | 775 | `LikedLeastID` | Evaluation detail |
| `tblWorkshopsPractices` | 1,075 | `WorkshopsPracticesID` | Practices-to-implement |
| `tblWorkshopDesiredTopics` | 1,875 | `WorkshopDesiredTopicsID` | Topic requests |
| `tblWorkshopPreferredTimes` | 1,914 | `WorkshopPreferredTime` | Preferred times |
| `tblWorkshopReferrals` | 1,759 | `WorkshopReferralID` | Referral sources |
| `tblWorkshopSummaryCounts` | 2,929 | `WorkshopSummaryCountsID` | Summary counts |
| `tblOtherCounts` | 114 | `OtherCountID` | Parent counts by category |
| `tblWorkshopEvalSummaries_OLD` | 2,942 | `WorkshopEvalSummaryID` | **Obsolete — do not migrate** |

### A.2 Lookup tables (`lst*`)

`lstAgencyTypes` (16) · `lstAges` (29) · `lstBackupTimes` (18) · `lstCategoryTypes` (26) · `lstCities` (194) · `lstComponents` (14) · `lstContactTypes` (3) · `lstCounties` (38) · `lstCreditSlipsCategories` (5) · `lstCreditTypes` (6) · `lstDesiredTopicCategories` (51) · `lstEquipment` (6) · `lstEvalQuestionTypes` (2) · `lstEvalTypes` (7) · `lstEventTypes` (13) · `lstFacilityTypes` (5) · `lstMailingLists` (8) · `lstNCZipCodes` (1,091) · `lstOthersList` (35) · `lstPaymentMethods` (12) · `lstPreferredTimes` (21) · `lstReferralTypes` (19) · `lstRegions` (109) · `lstSalutations` (4) · `lstSchoolYrs` (21) · `lstStates` (8) · `lstStreetTypes` (211) · `lstSummaryCountTypes` (7)

### A.3 Staging / scratch (not migrated)

`stblAttendDetails1-Reg` (2,187) · `stblParticipantEmails` (1,128) · `stblParticipantRegions` (5,853) · `stblPublicRegistrations` (2,292) · `stblRegistrationAttendances` (34,040) · `aTempGroup` (9) · `Paste Errors` (4) · `Switchboard Items` (54) · `lnkEmailsToRemove` (linked Excel)

### A.4 Query categories

| Prefix | Count | Treatment |
| --- | --- | --- |
| `qry*` | 76 | Read-only → SQL views + API endpoints |
| `sqry*` | 14 | Sub-select helpers → CTEs inside views |
| `upd*` | 17 | Action → admin utility jobs with audit |
| `apd*` | 23 | Append → admin utility jobs |
| `del*` | 3 | Delete → admin utility jobs |
| `mak*` | 3 | Make-table → replaced by views |
| `aMak*`, `aUpd*` | 4 | Temp operations → eliminated |
| `OLD_*`, `temp*` | 2 | Obsolete → dropped |
| `Find duplicates*` | 2 | → dedupe tool |

### A.5 Forms (48)

Top-level (9): `frmAgencies` · `frmParticipants` · `frmWorkshops` · `frmWorkshopNames` · `frmWorkshopsCurrent` · `frmPresentersAndStaff` · `frmPayments` · `frmCreditSlips` · `frmTrainingRequests` · `frmCommunityEvents` · `frmESchoolsEntry`

Dialogs (3): `dlgAddDF` · `dlgAddRegCurrent` · `dlgCreateEmailList` · `dlgReportsDateRange` · `dlgObservationsDateRange` · `dlgFolderForms` · `dlgRemoveDupParticipants`

Subforms (36): all `sfrm*` — become tabs or embedded grids on their parent detail screen.

Navigation (1): `Switchboard` — replaced by the React shell.

### A.6 Reports (112)

See §8.1 for the family breakdown. Full list captured in `docs/discovery/`.

---

## Appendix B — Discovery artifacts

All raw extraction was performed against `database/TrainingDatabase.accdb` on 2026-11-19 and is reproducible with the scripts in `db/extract/`. Captured artifacts:

| Artifact | Contents |
| --- | --- |
| `access-inventory.txt` | Every table, column, type, size, index, relationship, and full SQL for all 150 queries |
| `access-vba.txt` | Form/report record sources, control counts, module presence |
| `access-formvba.txt` | All form code-behind (12 lines total across 3 forms) |
| `wcpss-main.css` | District theme stylesheet (reference for tokens) |

### B.1 Notable schema quirks to preserve or fix

| Quirk | Decision |
| --- | --- |
| `tblWorkshopEvalQuestions.WorkshopEvaluations` is the PK but is named like a FK | Rename to `WorkshopEvaluationID` |
| `tblPayments.CheckNumber` / `ReceiptNumber` are `INT` | Keep `INT`; confirm no alphanumeric receipts exist |
| `tblWorkshops.Room` is `SMALLINT` | Keep; it is a room number, not a name |
| `tblWorkshops.SessionHrs` is `FLOAT` | Keep `FLOAT`; CEU maths depends on it |
| `tblWorkshops.Virtual` / `In-Person` are `INT` but semantically boolean | Convert to `BIT`; confirm no values other than 0/1 |
| `tblTrainingRequests.NumParticpants` (typo, `NVARCHAR(255)`) | Rename to `ParticipantCount`; keep as text until values are reviewed |
| `lstEvalTypes` PK is `WorkshopTypeID` | Rename to `EvalTypeID` |
| `lstSummaryCountTypes` PK is `CountyTypeID` | Rename to `SummaryCountTypeID` |
| `lstNCZipCodes` has no PK and a space in the column name | Add `ZipCode` PK |
| Several tables have no PK (`aTempGroup`, `Paste Errors`, `stbl*`) | Not migrated |

---

*End of plan.*
