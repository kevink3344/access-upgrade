# Feature — Public Workshop Registration

**Status:** Draft for review
**Related:** [Migration plan §7](../plans/access-migration.md) · [Responsive & mobile](./responsive-mobile.md)
**Prepared:** 2026-11-19

---

## 1. Purpose

Staff create workshops in the internal app. Today, participants register through eSchools or by phone/mail, and staff type the results in by hand. This feature adds a **shareable link per workshop** so participants register themselves online.

This is the first **automated** registration source. Every existing registration path is manual, so this form must not assume any reconciliation infrastructure exists — it creates one.

### 1.1 Scope

| In scope | Out of scope |
| --- | --- |
| Per-workshop public link | Payment processing (**handled by another vendor**) |
| Self-service registration form | Participant accounts / login |
| Seat-capacity enforcement | Replacing eSchools |
| Confirmation email | Waitlist automation (recorded, not auto-promoted) |
| Staff-side visibility of web registrations | Public workshop catalog browsing |
| Active/inactive toggles | Certificate delivery (separate feature) |

### 1.2 Decisions already made

| # | Decision | Source |
| --- | --- | --- |
| 1 | Payment is handled by another vendor — this app records intent only | Stakeholder |
| 2 | Anyone holding the link may register | Stakeholder |
| 3 | eSchools remains in use; this does not replace it | Stakeholder |
| 4 | Hosted in Azure; public domain available | Stakeholder |
| 5 | WCAG 2.1 AA is the accessibility target | Stakeholder |

---

## 2. The two-audience split

The app already has an internal staff surface. This feature adds a second, public surface. They must not share a route tree or an API surface.

```
/                          Staff app        Entra ID / WakeID SSO
  /workshops
  /participants
  /reports

/register/:slug            Public form      No auth
  /register/:slug/confirm
  /register/:slug/done
```

**Rules**

- Public routes live in their own layout — no staff navigation, no staff chrome.
- Public API lives under `/api/public/*` and **cannot** reach internal endpoints, even with a valid session.
- The public bundle must not ship staff code. Route-level code splitting is mandatory, not an optimisation.
- The public surface is the only thing exposed to the internet. The staff app stays behind SSO.

---

## 3. Data model

### 3.1 New table — `core.WorkshopRegistrationLink`

One row per shareable link. A workshop may have several (e.g. re-issued after revoking a leaked one).

```sql
CREATE TABLE core.WorkshopRegistrationLink (
    RegistrationLinkID  INT IDENTITY(1,1) PRIMARY KEY,
    WorkshopID          INT            NOT NULL REFERENCES core.Workshop(WorkshopID),
    Slug                NVARCHAR(24)   NOT NULL,   -- opaque, URL-safe, non-sequential
    IsActive            BIT            NOT NULL DEFAULT 0,
    WebSeatCap          INT            NULL,       -- NULL = no separate web cap
    OpensAt             DATETIME2(0)   NULL,
    ClosesAt            DATETIME2(0)   NULL,
    RevokedAt           DATETIME2(0)   NULL,
    RevokedBy           NVARCHAR(100)  NULL,
    CreatedBy           NVARCHAR(100)  NOT NULL,
    CreatedAt           DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_RegistrationLink_Slug UNIQUE (Slug)
);
CREATE INDEX IX_RegistrationLink_Workshop ON core.WorkshopRegistrationLink(WorkshopID);
```

**Why an opaque slug, not `WorkshopID`:** the link is the access control. A sequential ID (or a guessable pattern) lets anyone enumerate every open workshop. A 16-character URL-safe random slug is unguessable and individually revocable.

**Why `WebSeatCap` is separate from `MaxEnrollment`:** see §5.2.

### 3.2 Additions to existing tables

```sql
-- core.Registration: record provenance
ALTER TABLE core.Registration
    ADD Source             NVARCHAR(20) NOT NULL DEFAULT 'Manual',  -- Manual | Web | ESchools
        RegistrationLinkID INT          NULL REFERENCES core.WorkshopRegistrationLink(RegistrationLinkID),
        ConfirmationSentAt DATETIME2(0) NULL,
        ConfirmationToken  UNIQUEIDENTIFIER NULL;

-- core.Participant: role-specific answers from the branching form
ALTER TABLE core.Participant
    ADD ChildrenAges        NVARCHAR(255) NULL,  -- Parent/caregiver: ages of children
        SecondCaregiverInfo NVARCHAR(MAX) NULL;  -- Parent/caregiver: second caregiver details
```

Educator answers reuse existing columns: school name → `AgencyID` (via the agency picker), class ages → `GradeLevel`, which the legacy data already uses for class ages such as `NC Pre K` and `3-4 year olds`. Only the two parent/caregiver answers needed new columns.

`Source` is the important one. It answers "where did this registration come from?" without joining to the link table, and it lets staff filter the workshop roster by source.

### 3.3 Submission audit

Every public submission is logged before any business logic runs, so abuse is visible even when the submission is rejected.

```sql
CREATE TABLE audit.PublicSubmission (
    PublicSubmissionID BIGINT IDENTITY(1,1) PRIMARY KEY,
    RegistrationLinkID INT            NULL,
    SubmittedAt        DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),
    IpHash             VARBINARY(32)  NULL,   -- salted hash, not the raw IP
    UserAgent          NVARCHAR(400)  NULL,
    Outcome            NVARCHAR(30)   NOT NULL, -- Accepted | Rejected | Duplicate | RateLimited | Honeypot
    Reason             NVARCHAR(200)  NULL,
    PayloadHash        VARBINARY(32)  NULL
);
```

Raw IPs are hashed with a rotating salt — enough to rate-limit and spot patterns, without retaining personal data longer than necessary.

---

## 4. Staff-side experience

### 4.1 Opening registration

On the workshop detail screen, a **Registration link** panel:

| Control | Behaviour |
| --- | --- |
| **Registration open** toggle | Master switch. Default **off**. |
| **Web seat cap** | Optional. Defaults to `MaxEnrollment` minus the current combined count. |
| **Opens / closes** | Optional schedule. Blank = whenever the toggle says so. |
| **Copy link** | Copies the full URL. Disabled while inactive. |
| **Revoke and reissue** | Kills the current slug, issues a new one. Existing registrations are unaffected. |

Both toggles default to **inactive**. A workshop is never publicly registerable the moment it is created — staff open it deliberately.

### 4.2 Two toggles, not one

| Toggle | Level | Effect |
| --- | --- | --- |
| `Workshop.IsRegistrationOpen` | Workshop | Closes registration for the workshop. The link shows **"Registration is closed"** — not a 404. |
| `RegistrationLink.IsActive` | Link | Revokes one specific link. The link shows **"This link is no longer valid"** — a different, honest message. |

They are separate because the reasons differ. Closing a workshop is a business decision; revoking a link is usually a distribution mistake (posted to the wrong audience, shared too broadly).

### 4.3 Seeing web registrations

The workshop roster gains a **Source** column and a filter. Staff can see at a glance:

- how many seats came from the web vs. eSchools vs. manual entry,
- which registrations are unconfirmed (email not yet clicked),
- which are flagged as possible duplicates.

---

## 5. Seat capacity

### 5.1 The problem

Registrations arrive from three places, and only one is automated:

```
eSchools   ──┐
Web form   ──┼──> seat count ──> "12 of 20 filled"
Manual     ──┘
```

eSchools has no API and its numbers are typed in by hand. So the combined count is **always slightly stale**, and a naive "reject when full" check will either over-book or under-book.

### 5.2 Recommended approach — a separate web cap

Start with a **separate web-registration cap** (`WebSeatCap`) rather than enforcing `MaxEnrollment` across all sources.

| Approach | Pros | Cons |
| --- | --- | --- |
| **Separate web cap** (recommended) | Predictable; independent of eSchools sync latency; staff control it explicitly | Under-uses total capacity unless staff tune it |
| Enforce combined `MaxEnrollment` | Uses full capacity | Over-books whenever eSchools numbers lag; depends on staff data entry timing |
| No cap, over-book and resolve | Simplest | Bad participant experience; support calls |

Start with the separate cap. If staff find it too restrictive, the combined check can be added later as an opt-in per workshop — the data model already supports it.

### 5.3 Displaying availability

The form shows a **coarse** availability signal, not an exact count:

- `20 or more places remaining` — when plenty
- `Fewer than 10 places remaining` — when getting tight
- `Registration is full` — when the cap is reached

Exact counts invite gaming and make staleness visible. Coarse bands stay useful even when the number is a few minutes old.

---

## 6. The form

### 6.1 Flow

```
Link opened
  │
  ├─ link invalid / revoked ──> "This link is no longer valid"        (terminal)
  ├─ registration closed    ──> "Registration is closed"              (terminal)
  ├─ not yet open           ──> "Registration opens on <date>"        (terminal)
  │
  └─ open
       │
       ├─ Workshop summary (read-only: title, dates, times, location, cost, credit)
       │
       ├─ Step 1 — Who is registering?
       │     Returning participant? Enter email → match → pre-fill
       │     New participant?      Enter details
       │
       ├─ Step 2 — Attendees
       │     One or more people (directors often register several teachers)
       │
       ├─ Step 3 — Review and submit
       │
       └─ Confirmation screen + email
```

Three steps, not one long form. On a phone a single long form is the most common cause of abandonment.

### 6.2 Fields

**The form branches on registrant role.** The first question is "I am registering as" — *Educator* or *Parent/caregiver* — and the follow-up questions differ. This mirrors the Microsoft Forms the programme uses today and keeps each audience from reading questions meant for the other.

Common to both roles:

| Field | Required | Notes |
| --- | --- | --- |
| Registrant role | Yes | `Educator` or `Parent/caregiver` — drives the branch |
| First name | Yes | |
| Last name | Yes | |
| Email | Yes | The identity key for matching and confirmation |
| Phone | No | `type="tel"`, `inputmode="tel"` |
| Notes | No | "Anything we should know?" |

**Educator** adds:

| Field | Required | Notes |
| --- | --- | --- |
| Name of school or childcare centre | No | **Searchable picker over `core.Agency`** → `AgencyID` |
| How old are the students in your class? | No | Free text → `Participant.GradeLevel` |

**Parent/caregiver** adds:

| Field | Required | Notes |
| --- | --- | --- |
| What are the ages of your children? | No | Free text → `Participant.ChildrenAges` |
| Additional information for a second parent/caregiver? | No | Free text → `Participant.SecondCaregiverInfo` |

**Agency must be a picker, not a text box.** Free-text agencies are how the 811-row `tblAgencies` table accumulated near-duplicates. Offer type-ahead search with "can't find your school?" falling back to a request that staff resolve — do not silently create a new agency row from a public form.

**Role answers are only written for the role that was asked.** A crafted request carrying the other branch's fields has them dropped server-side, so one record can never hold both audiences' answers.

**Blank never erases.** On a repeat submission the role answers are written with `COALESCE(@value, existing)`, so leaving an optional question empty keeps whatever the participant answered previously.

**No payment fields.** No card number, no CVV, no bank details. The vendor handles payment; this form records *which* method the participant intends to use.

### 6.3 Multiple attendees

A single submission may register several people. Model this as repeatable attendee rows sharing one contact/payment block:

- The submitting person is the **contact** (name, email, phone, agency, payment).
- Each attendee is a **participant** row.
- If the contact is also attending, they are attendee #1.

This matches how directors actually register teachers, and it avoids five separate submissions from one person.

### 6.4 Participant matching

Given the 962 duplicate-email groups already in the data, matching needs care.

**Match order:**

1. Exact email (case-insensitive, trimmed) → single match → pre-fill and reuse `ParticipantID`.
2. Exact email → **multiple** matches → do **not** auto-select. Show the candidates (name + agency) and let the person pick, with "none of these" as an option.
3. No match → create a new participant.

**Never auto-merge.** This is consistent with the existing rule in the migration plan (§11, open question 3). Matching selects an existing record; it does not combine records.

### 6.5 Duplicate registration

Someone registering twice for the same workshop is common — they forget, or a colleague registers them too.

- Same email + same workshop + not cancelled → **update** the existing registration rather than creating a second one.
- Response is identical to a fresh success ("You're registered"), so the form does not leak whether an address is already registered.
- Log the event as `Outcome = 'Duplicate'` in `audit.PublicSubmission`.

---

## 7. Abuse protection

The link is the only barrier, so it will be found by bots.

| Control | Implementation |
| --- | --- |
| Rate limit per IP | 10 submissions / hour, hashed IP |
| Rate limit per email | 5 submissions / hour |
| Rate limit per link | 200 submissions / hour — protects against a link going viral |
| Honeypot field | Hidden input; any value → reject, log as `Honeypot` |
| Timing check | Form submitted in under 3 seconds → reject |
| Email confirmation | Registration is **provisional** until the confirmation link is clicked |
| No CAPTCHA by default | CAPTCHAs are an accessibility problem. Add one only if the above proves insufficient. |

**Provisional registrations** count toward the web cap for 48 hours, then release if unconfirmed. This prevents both seat-hoarding and the case where a typo'd email silently consumes a seat forever.

---

## 8. Confirmation email

Sent immediately on submission, containing:

- Workshop title, dates, times, location
- Attendee names
- Cost and payment instructions (vendor's instructions, not ours)
- A confirmation link (`ConfirmationToken`)
- A "this wasn't me" link that cancels the registration

The confirmation link is what moves the registration from provisional to confirmed, and sets `ConfirmationSentAt`.

---

## 9. API contract

```
GET    /api/public/registration-links/:slug
       → { workshop: { title, dates, times, location, cost, credit },
           availability: 'plenty' | 'limited' | 'full',
           state: 'open' | 'closed' | 'not-yet-open' | 'revoked',
           agencies: [...] }        # for the picker, cached 5 min

POST   /api/public/registration-links/:slug/match
       body: { email }
       → { matches: [ { participantId, firstName, lastName, agencyName } ] }

POST   /api/public/registration-links/:slug/registrations
       body: { contact: {...}, attendees: [...], paymentMethod, poNumber?, notes?,
               honeypot, elapsedMs }
       → { registrationIds: [...], confirmationRequired: true }

GET    /api/public/registrations/:token/confirm
       → 302 to /register/:slug/done

POST   /api/public/registrations/:token/cancel
       → { cancelled: true }
```

**Response shapes are deliberately minimal.** The public endpoints never return internal IDs beyond what the flow needs, never return other participants' data, and never reveal whether an email exists elsewhere in the system.

---

## 10. Accessibility (WCAG 2.1 AA)

This form is public and belongs to a school district, so AA is a requirement, not a target.

| Requirement | Implementation |
| --- | --- |
| Labels | Every input has a visible `<label>`. Placeholders are not labels. |
| Errors | Announced via `role="alert"`; error text is programmatically associated with the field. |
| Focus | Visible focus ring using `--secondary-color`; focus moves to the first error on submit. |
| Contrast | `#165788` on white is 7.4:1. Never white text on `#fed100` or `#BED600`. |
| Keyboard | Full flow completable without a mouse. |
| Touch targets | ≥ 44×44 px. |
| Zoom | Usable at 200% and at 320 px viewport width. |
| Motion | No essential animation; respect `prefers-reduced-motion`. |
| Time limits | None. Provisional registrations expire, but the form itself never times out. |

---

## 11. Open questions

| # | Question | Blocks |
| --- | --- | --- |
| 1 | What payment methods should the form offer, given the vendor handles payment? | Form fields |
| 2 | Should staff be notified by email when a web registration arrives? | Notifications |
| 3 | Can participants cancel their own registration from the confirmation email? | §8 |
| 4 | What is the approved public domain / subdomain? | Deployment |
| 5 | Do web registrations need to appear in eSchools at all, or is eSchools a separate pool entirely? | Reporting |
| 6 | Who owns resolving "can't find my school" requests? | §6.2 |

---

## 12. Delivery

| Phase | Work |
| --- | --- |
| 0 | Confirm public domain and hosting split (internet-facing form vs. internal staff app) |
| 2 | Schema (`WorkshopRegistrationLink`, `Registration.Source`, `audit.PublicSubmission`); staff-side link panel |
| 2 | Public API: link resolution, matching, submission, confirmation |
| 3 | Public form UI — mobile-first, WCAG AA, tested on a low-end Android device |
| 4 | Confirmation emails, provisional expiry job, duplicate flagging in the staff roster |

**Exit criteria:** a real workshop is opened for web registration, a participant registers on a phone, receives the confirmation email, and staff see the registration on the workshop roster with `Source = 'Web'`.
