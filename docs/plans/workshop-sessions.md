# Workshop Sessions — Multiple Sessions per Workshop, Each with Its Own Capacity

**From:** One workshop = one date/time and one workshop-wide `MaxEnrollment`
**To:** A workshop with N sessions (e.g. 10–11, 11–12, 12–1 on the same day), each recorded with its own time window and its own seat count
**Prepared:** 2026-11-23
**Status:** **Implemented** (2026-11-23) — scope decided: descriptive sessions (§1.1). See §16 for what shipped.

**Related:** [Access migration plan](./access-migration.md) · [Public registration](../features/public-registration.md) · [Notifications](../features/notifications.md)

---

## 1. Executive summary

The database **already has a session table** — `core.WorkshopSession` — and the app already has a Sessions tab. What it does **not** have is the two things that make sessions useful:

| Missing piece | Today | Needed |
| --- | --- | --- |
| **Time window per session** | `WorkshopSession.SessionDate` only. Times live on `Workshop.StartTime`/`EndTime` | `StartTime` / `EndTime` on the session |
| **Capacity per session** | `Workshop.MaxEnrollment` only, workshop-wide | `MaxEnrollment` on the session, with a workshop fallback |

The existing session table is **not** a blank slate. It is populated by the ETL from the Access table `tblWorkshopSessions`, and it already carries:

- `StaffID` — the presenter for that session (the Sessions tab writes this)
- `BackUpTimeID` → `ref.BackupTime` — a legacy lookup that looks like exactly this feature: a list of times attached to a session
- `RegAttend` / `ESchoolAttend` — attendance counts imported from Access
- `core.SessionParticipant` — per-session attendance, keyed `(ParticipantID, WorkshopSessionID)`

**Recommendation: extend the existing table rather than introduce a parallel one.** A second "session" concept next to `WorkshopSession` would duplicate the presenter, attendance and ETL surface, and the attendance checklist already assumes one session = one roster.

**Effort estimate: ~1 week** of engineering for Phases 1–3 (schema, API, staff UI), plus 1–2 days for Phase 4 (polish) and half a day of data verification.

### 1.1 Scope decision — sessions are descriptive, not bookable

**Decided 2026-11-23: descriptive.** Staff record each session's time window and seat count on the workshop. Registrants continue to register for the **workshop**, exactly as they do today. Nobody picks a session.

What that removes from the work:

| Dropped | Why |
| --- | --- |
| `Registration.WorkshopSessionID` | No one is assigned to a session |
| Registration-time capacity enforcement | Capacity is informational, not a gate |
| The locked-transaction double-booking fix | Nothing is booked, so nothing can be double-booked |
| Public session picker | The public form is unchanged |
| Per-session capacity alerts | Nothing is consumed, so there is no threshold to cross |
| Session columns/filters on the Registrants tab | No session assignment exists |
| A `FormTemplateVersionID` on the session | Forms are pinned to the registration link, which is already per-workshop (§8.1) |

What that leaves:

- Two new nullable columns on `core.WorkshopSession` (`StartTime`, `EndTime`) and two for capacity (`MaxEnrollment`, `MinEnrollment`).
- A reworked Sessions tab where staff enter times and seat counts, with a repeat helper for the "three sessions an hour apart" case.
- A derived view so the tab can show the workshop's registration count next to each session without trusting a stored total.
- Reports that show session times.

**The plan below is written for descriptive sessions only.** Anything that would be needed to make sessions bookable later is called out in §11 as a deliberate, separable follow-up.

---

## 2. What exists today

### 2.1 Schema

```sql
core.Workshop
    StartDate, EndDate, StartTime, EndTime   -- the workshop's own window
    MaxEnrollment, MinEnrollment             -- workshop-wide capacity
    SessionCount, SessionHours, SessionCeus  -- credit math, workshop-level
    NotifyPercentFull, NotifyFiredAt         -- capacity alert (migration 005)

core.WorkshopSession
    WorkshopSessionID  INT PK (not IDENTITY — legacy keys preserved)
    WorkshopID         INT FK
    StaffID            INT                   -- presenter for this session
    BackUpTimeID       INT FK ref.BackupTime -- legacy time lookup
    SessionDate        DATETIME2(0)
    RegAttend          INT                   -- imported from Access
    ESchoolAttend      INT                   -- imported from Access

core.SessionParticipant                      -- attendance, per session
    ParticipantID, WorkshopSessionID  PK
    IsLate

core.Registration
    WorkshopID         INT FK                -- workshop-level only
```

`core.WorkshopSession` has **no time columns and no capacity column**. `Workshop.StartTime`/`EndTime` are the only times in the model, and they describe the whole workshop.

### 2.2 API

| Endpoint | Behaviour |
| --- | --- |
| `GET /api/workshops/:id/sessions` | Lists sessions with date, presenter, `RegAttend` |
| `POST /api/workshops/:id/sessions` | Body `{ sessionDate, staffId? }` — **date and presenter only** |
| `PATCH /api/workshops/:id/sessions/:sessionId` | Date and presenter only |
| `DELETE /api/workshops/:id/sessions/:sessionId` | Refuses if `SessionParticipant` rows exist |
| `GET /api/workshops/:id/sessions/:sessionId/attendance` | Checklist of **all workshop registrants**, marked per session |
| `PUT /api/workshops/:id/sessions/:sessionId/attendance/:participantId` | Marks `IsLate` / attended |

The new-session insert takes its ID from `MAX(WorkshopSessionID) + 1` because the column is not `IDENTITY`. Any new write path must do the same.

### 2.3 Capacity and the public link

Capacity is computed in exactly one place, `seatsRemaining()` in `apps/api/src/routes/public.ts`, against `Workshop.MaxEnrollment` and `WorkshopRegistrationLink.WebSeatCap`. **This is unchanged by this plan** — the public link keeps working off the workshop-wide number, because registrants still book the workshop.

### 2.4 Staff UI

- `WorkshopSessions.tsx` — the Sessions tab. Add/delete a session with a date and an optional presenter. Shows `RegAttend`.
- `WorkshopDrawer.tsx` — the workshop form. `StartTime`, `EndTime`, `MaxEnrollment` are single fields on the workshop.
- `WorkshopAttendance.tsx` — attendance checklist for one session.

### 2.5 ETL

`db/etl/transform.sql` copies `tblWorkshopSessions` verbatim into `core.WorkshopSession`, including `BackUpTimeID`. `ref.BackupTime` is loaded from `lstBackupTimes`. **We do not yet know whether legacy sessions actually used distinct backup times per session** — that is the first thing to check (§5.1).

---

## 3. Target model

### 3.1 Decisions baked into the model

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Extend `core.WorkshopSession`; no new table | Presenter, attendance, ETL and the checklist already key on it |
| 2 | Times live on the session | A workshop's times are the union of its session times; storing them twice drifts |
| 3 | Capacity lives on the session, with a workshop fallback | Backwards compatible: existing workshops keep working with one "session" that inherits `MaxEnrollment` |
| 4 | `Workshop.MaxEnrollment` stays, and becomes the **default** a new session inherits | Avoids a migration that has to invent numbers |
| 5 | Session capacity is **informational** | Registrants book the workshop; nothing is enforced against a session |
| 6 | No `Registration.WorkshopSessionID` | Descriptive sessions have no per-session roster |

### 3.2 DDL

New migration `db/migrations/012-workshop-sessions.sql`, guarded and re-runnable per the [migrations README](../../db/migrations/README.md):

```sql
IF COL_LENGTH('core.WorkshopSession', 'StartTime') IS NULL
    ALTER TABLE core.WorkshopSession ADD StartTime TIME(0) NULL;

IF COL_LENGTH('core.WorkshopSession', 'EndTime') IS NULL
    ALTER TABLE core.WorkshopSession ADD EndTime TIME(0) NULL;

IF COL_LENGTH('core.WorkshopSession', 'MaxEnrollment') IS NULL
    ALTER TABLE core.WorkshopSession ADD MaxEnrollment INT NULL;

IF COL_LENGTH('core.WorkshopSession', 'MinEnrollment') IS NULL
    ALTER TABLE core.WorkshopSession ADD MinEnrollment INT NULL;

IF COL_LENGTH('core.WorkshopSession', 'Notes') IS NULL
    ALTER TABLE core.WorkshopSession ADD Notes NVARCHAR(400) NULL;
```

No FK, no index, no constraint on `core.Registration`. The only index worth adding is on the session's own date, to support the Sessions tab's ordering:

```sql
IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_WorkshopSession_Workshop_Date'
                  AND object_id = OBJECT_ID('core.WorkshopSession'))
    CREATE INDEX IX_WorkshopSession_Workshop_Date
        ON core.WorkshopSession(WorkshopID, SessionDate, StartTime);
```

**Constraint to consider, not add yet:** `UNIQUE (WorkshopID, SessionDate, StartTime)` would stop two sessions colliding. It cannot be added until legacy rows have times (§5.2), and it would reject a legitimate back-to-back pair only if the times are equal, which is what we want. Add it in a follow-up migration once times are populated.

### 3.3 `db/schema.sql` must be updated in the same change

The migration README requires a from-scratch build to produce the same result. Add the new columns to the `CREATE TABLE core.WorkshopSession` block in `db/schema.sql`, then run `db/etl/compare-schema.ps1` and confirm **NO DRIFT**.

### 3.4 Capacity resolution

One helper, used by the Sessions tab API and the reports:

```ts
/**
 * Effective capacity for a session.
 *
 * A session with its own MaxEnrollment uses it. A session without one
 * inherits the workshop's, so a workshop that never adopted per-session
 * capacity behaves exactly as it does today.
 */
function sessionCapacity(sessionMax: number | null, workshopMax: number | null): number | null {
  return sessionMax ?? workshopMax;
}
```

This is **display-only**. It does not gate registration.

### 3.5 Derived view — `core.vw_WorkshopSessionCounts`

Mirrors the existing `core.vw_WorkshopCounts` pattern (stored totals are not trusted). With descriptive sessions there is no per-session roster, so the view reports the **workshop's** registration count alongside each session — enough for staff to see "this workshop has 14 registrations across three sessions of 8/8/10" without implying any of them are assigned.

```sql
CREATE VIEW core.vw_WorkshopSessionCounts AS
SELECT s.WorkshopSessionID,
       s.WorkshopID,
       (SELECT COUNT(*) FROM core.Registration r
         WHERE r.WorkshopID = s.WorkshopID AND r.IsCancelled = 0) AS WorkshopRegistered
  FROM core.WorkshopSession s;
```

`RegAttend` and `ESchoolAttend` stay as **imported historical values** and are not repurposed.

---

## 4. API changes

All changes are on the authenticated workshop routes. **Nothing under `/api/public/*` changes.**

### 4.1 Session endpoints

`GET /api/workshops/:id/sessions` gains:

```jsonc
{
  "data": [
    {
      "WorkshopSessionID": 412,
      "SessionDate": "2026-12-04",
      "StartTime": "10:00",
      "EndTime": "11:00",
      "StaffID": 17,
      "PresenterName": "Dana Whitfield",
      "MaxEnrollment": 8,
      "MinEnrollment": null,
      "Notes": null,
      // Effective capacity after the workshop fallback, so the UI never
      // has to re-implement the rule.
      "EffectiveCapacity": 8,
      // True when EffectiveCapacity came from the workshop, not the session.
      "CapacityInherited": false,
      "WorkshopRegistered": 14,
      "RegAttend": 5,
      "ESchoolAttend": null
    }
  ]
}
```

`POST` and `PATCH` accept the new fields:

```ts
const sessionWriteSchema = z.object({
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  staffId: z.number().int().positive().nullable().optional(),
  maxEnrollment: z.number().int().nonnegative().nullable().optional(),
  minEnrollment: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(400).nullable().optional(),
});
```

Validation rules, enforced server-side and mirrored in the form:

1. `endTime` must be after `startTime` when both are present.
2. `minEnrollment` must not exceed `maxEnrollment` when both are present.
3. `sessionDate` must fall within the workshop's `StartDate`–`EndDate` when those are set. Warn rather than block if the workshop has no dates.

There is **no rule tying session capacity to the workshop's registration count** — sessions are descriptive, so a workshop with 14 registrations may legitimately have three sessions of 8 seats each. The Sessions tab shows both numbers side by side and lets staff judge.

### 4.2 Bulk create — the repeat helper

The request describes typing three sessions an hour apart on the same day. That should be one action, not three forms:

```
POST /api/workshops/:id/sessions/bulk
{
  "sessionDate": "2026-12-04",
  "startTime": "10:00",
  "count": 3,
  "durationMinutes": 60,
  "maxEnrollment": 8,
  "staffId": 17
}
```

Server behaviour:

- Creates `count` sessions starting at `startTime`, each `durationMinutes` long, back to back.
- `count` is capped at 12 — beyond that it is almost certainly a mistake.
- Each row is a **normal, independent session**. The helper is a pre-fill, not a template: after creation every row can be edited or deleted on its own.
- All rows are inserted in one transaction so a partial failure leaves nothing behind.
- IDs come from `MAX(WorkshopSessionID) + 1` incrementing per row, matching the existing insert.
- Returns `{ created: [ { workshopSessionId, startTime, endTime }, ... ] }`.

`PATCH` still edits one session at a time. There is deliberately no bulk edit: changing a time on three sessions is three clicks, and a bulk edit that silently rewrites capacity across a day is a footgun.

### 4.3 Attendance and delete

Unchanged. The delete guard (`SessionParticipant` rows exist) still applies, and the Sessions tab keeps its existing tooltip.

---

## 5. Data: what happens to the rows already there

This is the part most likely to be underestimated. There is no database access from this machine right now, so §5.1 and §5.2 are the **first tasks** of Phase 0, not assumptions.

### 5.1 Duplicate and undated sessions

Run these on **test** first:

```sql
-- Two sessions on the same workshop, same date, no time to tell them apart
SELECT WorkshopID, SessionDate, COUNT(*) AS n
  FROM core.WorkshopSession
 GROUP BY WorkshopID, SessionDate
HAVING COUNT(*) > 1;

-- Sessions with no date at all
SELECT COUNT(*) AS undated FROM core.WorkshopSession WHERE SessionDate IS NULL;

-- What the legacy time lookup actually holds
SELECT TOP 50 * FROM ref.BackupTime ORDER BY BackupTimeID;
```

The `HAVING COUNT(*) > 1` result is the list of workshops where the new `StartTime` is genuinely needed to tell sessions apart. It is also the review queue for §5.2.

### 5.2 Populating times on legacy sessions

Three candidate sources, in order of preference:

| Source | What it gives | Caveat |
| --- | --- | --- |
| `ref.BackupTime` via `BackUpTimeID` | A time per session, already imported | Unknown whether it is a *start* time, an *end* time, or a duration — check `lstBackupTimes` contents first |
| `Workshop.StartTime` / `EndTime` | The workshop's window | Only correct for single-session workshops; wrong for multi-session ones |
| `Workshop.TimesText` | Free text from Access, e.g. "10:00 - 11:00, 11:00 - 12:00" | Needs parsing; good enough for a manual review queue |

**Proposed approach:** backfill `StartTime` from `BackupTime` where it parses, fall back to `Workshop.StartTime` when the workshop has exactly one session, and leave the rest `NULL`. Then produce a **review report** of sessions with no time so staff can fill them in from the Sessions tab. Do not invent times.

Sessions with `NULL` times are still valid — they are just "date only", which is what they are today. Capacity is left `NULL` on every legacy row, so all of them inherit the workshop's `MaxEnrollment` and nothing changes for existing workshops.

---

## 6. Capacity semantics

With descriptive sessions there is exactly one enforced number and one informational number:

| Number | Scope | Enforced? | Used for |
| --- | --- | --- | --- |
| `Workshop.MaxEnrollment` | Whole workshop | **Yes** — by the public link and the capacity alert | Whether the workshop is full |
| `WorkshopSession.MaxEnrollment` | One session | **No** | Staff planning: "morning 8, afternoon 10" |

Consequences worth stating plainly:

- **The public link is untouched.** `seatsRemaining()` keeps comparing `Workshop.MaxEnrollment` against the workshop's registrations. A workshop with three sessions of 8 seats still shows the workshop's own capacity.
- **The capacity alert is untouched.** `checkWorkshopCapacity` keeps working off `Workshop.MaxEnrollment` and `NotifyPercentFull`. No per-session flag is added.
- **Session capacity never blocks a registration.** If staff set 8 seats on a session and 14 people register for the workshop, nothing errors. The Sessions tab shows the mismatch so staff can act.
- **Cancellations need no special handling.** Nothing is consumed per session.

If the business later wants session capacity to *gate* registration, that is the bookable variant in §11 — a separate change, not a tweak to this one.

---

## 7. Staff UI

### 7.1 Sessions tab (`WorkshopSessions.tsx`)

Rework the tab from a date + presenter list into a small editable table:

| Date | Start | End | Presenter | Capacity | Workshop regs | Actions |
| --- | --- | --- | --- | --- | --- | --- |
| Fri, Dec 4 | 10:00 | 11:00 | Dana Whitfield | 8 | 14 | Edit · Delete |
| Fri, Dec 4 | 11:00 | 12:00 | Dana Whitfield | 8 | 14 | Edit · Delete |
| Fri, Dec 4 | 12:00 | 13:00 | — | 10 (from workshop) | 14 | Edit · Delete |

- **Capacity** shows the session's own value, or `N (from workshop)` in muted text when it inherits — driven by the `CapacityInherited` flag so the UI does not re-derive the rule.
- **Workshop regs** is the workshop-wide count from `vw_WorkshopSessionCounts`, repeated per row. It is deliberately labelled "Workshop regs", not "Registered", so nobody reads it as a per-session roster.
- **Add session** gains start/end time and capacity fields.
- **Add several** opens the repeat helper (§4.2): date, start time, number of sessions, duration, capacity, presenter. It previews the resulting rows (10:00–11:00, 11:00–12:00, 12:00–13:00) before creating them. This is the feature the request describes, and typing three rows by hand is the thing staff will complain about.
- A session row with no time renders `—` and sorts first, so incomplete rows are easy to find.
- The existing "Delete is blocked when attendance exists" tooltip is kept.

### 7.2 Workshop form (`WorkshopDrawer.tsx`)

- `StartTime` / `EndTime` are relabelled **"Default start time" / "Default end time"**, with help text: *"Used for new sessions and for workshops with no sessions. A workshop with sessions shows the range of its sessions."*
- `MaxEnrollment` is relabelled **"Default capacity"**, with the same idea: sessions inherit it unless they set their own.
- No field is removed. Existing workshops keep working untouched.

### 7.3 Attendance (`WorkshopAttendance.tsx`)

No change. The checklist already lists every workshop registrant per session, which is exactly right for descriptive sessions.

### 7.4 Registrants tab (`WorkshopRegistrants.tsx`)

No change. There is no session assignment to show.

---

## 8. Public registration

**No change.** `PublicRegisterPage.tsx` keeps rendering the workshop's `Date` and `Time`, and posts a workshop-level registration. The public surface must not learn about sessions in this change — that is the whole point of choosing descriptive.

One optional polish, Phase 4: when a workshop has sessions, the public page could show the session times as a read-only list under the workshop's own time. This is cosmetic and can be skipped.

**One URL per workshop — not one per session.** Staff create the workshop, add its sessions in the Sessions tab, and share the same single `/register/:slug` link they share today. Sessions do not generate URLs. A per-session link is possible (§8.1) but is an exception for a session that needs a different form or its own web seat cap, not the normal workflow.

If you need to know which session a registrant intends to attend, add a form question — a `select` labelled "Which session will you attend?" with the session times as options. One URL, the answer lands in `core.FormAnswer`, and it shows on the Registrants tab with no schema change. Otherwise sessions stay purely descriptive and attendance is recorded per session at the door via the existing checklist.

### 8.1 Forms are pinned to the link, not the session

A session does **not** get its own form ID. Forms are already bound one level above the session, and that binding is what decides which questions the public page renders:

```
core.WorkshopRegistrationLink          -- one row per shareable link
    WorkshopID             -> the workshop
    Slug                   -> /register/:slug
    FormTemplateVersionID  -> core.FormTemplateVersion  (migration 008)
                              NULL = the built-in form
```

`getVersionForLink(linkId)` (`apps/api/src/services/forms.ts`) reads `FormTemplateVersionID` off the link, and `GET /api/public/registration-links/:slug` returns it as `form`. The page renders those questions, or falls back to the built-in form when it is `null`. A version is immutable once published, so a link shared yesterday keeps asking yesterday's questions.

Because a link belongs to a **workshop**, and a session belongs to the same workshop, every session on that workshop shares the link's form. That is the right default for descriptive sessions: the registrant is booking the workshop, so the questions asked of them should not vary by which time they happen to attend.

**If a session ever needs different questions**, the change is a form binding on the link, not a new concept:

| Want | Change | Cost |
| --- | --- | --- |
| Different questions per session | One link per session, each with its own `FormTemplateVersionID` | No schema change — `WorkshopRegistrationLink` already allows many links per workshop |
| Same form, different wording per session | Not supported by templates; use a session-specific `Notes` field or a separate template version | A new template version per session |

`WorkshopRegistrationLink` has no uniqueness constraint on `WorkshopID` (only `Slug` is unique), so multiple links per workshop already work. This is the escape hatch: **a session that needs its own form gets its own link**, and the session stays descriptive in the database.

### 8.2 How the system decides what to show

The public page renders from exactly three inputs, in this order:

| Step | Source | Decides |
| --- | --- | --- |
| 1 | URL slug → `WorkshopRegistrationLink` | Which workshop, and which form version (`FormTemplateVersionID`) |
| 2 | `core.Workshop` + `WorkshopName` + `Agency` | Title, code, date, time, room, cost, credit, CEUs |
| 3 | `seatsRemaining()` on the workshop | Open / full / closed state |

Sessions are **not** an input to any of those. They are shown, if at all, as read-only detail in step 2 — a list of times under the workshop's own time. Nothing about the form, the validation or the submit payload changes.

This is deliberate: it means the session feature can ship without touching the public surface, and a bug in session data cannot break registration.

### 8.3 Worked example — one workshop, three sessions, one URL

Slugs are **random 16-character tokens**, not derived from the workshop or the session:

```ts
// apps/api/src/routes/registration-link.ts
function newSlug(): string {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}
```

So a session's URL cannot be computed from a workshop's URL — it has to be a **separate link row**. The route shape is fixed at `/register/:slug` (`main.tsx` matches `^\/register\/([A-Za-z0-9_-]+)\/?$`), so there is no query parameter to add either.

Take workshop `1042` — *"Supporting Early Literacy, Grades K–2"* — with three descriptive sessions on Friday, 4 December 2026 (10:00–11:00, 11:00–12:00, 12:00–13:00).

**Default: one link for the whole workshop.** All three sessions share it, and the page shows the workshop's own time. No per-session URL exists, because nothing is booked per session. **This is the normal case — staff share one link per workshop, exactly as they do today.**

| Link | URL | Form | Sessions shown |
| --- | --- | --- | --- |
| Whole workshop | `https://register.projectenlightenment.org/register/Xk3pQ9mZrT2vB7nL` | Built-in form | Optional read-only list of all three times |

**Exception, not the default:** if a session needs its own form or its own seat cap, add a link for *that session only*. Most workshops will never need this.

| Link | URL | Form | Notes |
| --- | --- | --- | --- |
| Morning (10:00–11:00) | `https://register.projectenlightenment.org/register/aB7dE2fG9hJ4kL6m` | *Early Literacy — Parent* | Own `WebSeatCap` |
| Midday (11:00–12:00) | `https://register.projectenlightenment.org/register/nP5qR8sT3uV1wX9y` | *Early Literacy — Parent* | Own `WebSeatCap` |
| Afternoon (12:00–13:00) | `https://register.projectenlightenment.org/register/zC4vB6nM2xQ8wE5r` | *Early Literacy — Educator* | Own `WebSeatCap` |

```sql
-- Three links on the same workshop. Slug is the only unique column,
-- so this is already valid today — no schema change.
SELECT RegistrationLinkID, WorkshopID, Slug, WebSeatCap, FormTemplateVersionID, IsActive
  FROM core.WorkshopRegistrationLink
 WHERE WorkshopID = 1042;
```

The workshop's normal link still exists alongside these; the per-session links are additional, not replacements.

**Important caveat:** a per-session link is still a **workshop-level** link. It changes which form is asked and how many web seats are sold, but it does **not** record which session the registrant chose — `core.Registration` has no session column in this scope (§1.1). The link is a way to *target* an audience, not to *assign* a session.

If you need the registration to record the session, that is the bookable variant (§11), which adds `Registration.WorkshopSessionID` and a picker. Until then, the honest way to distinguish a morning registrant from an afternoon one is a **question on the form** — e.g. a `select` question "Which session will you attend?" with the three times as options. The answer lands in `core.FormAnswer` and shows on the Registrants tab, with no schema change.

---

## 9. Reports, certificates and credit

These are workshop-level today and must not silently break.

| Area | Today | Change |
| --- | --- | --- |
| Roster report | One row per registration | No change |
| Attendance report | Per session already | Add Start/End time columns |
| Hours / CEUs | `Workshop.SessionHours`, `SessionCeus` | **Unchanged.** Credit is awarded per workshop. Do not sum session hours — that would triple the credit for a workshop with three one-hour sessions |
| Certificate | Workshop-level | Unchanged |
| Dashboard counts | Workshop-level | Unchanged |

**Explicit non-goal:** `SessionHours` and `SessionCeus` stay workshop-level. If the business later wants "one hour = one CEU per session", that is a separate decision with its own plan.

---

## 10. Decisions and open questions

### 10.1 Settled

| # | Question | Decision |
| --- | --- | --- |
| 1 | Are sessions bookable or descriptive? | **Descriptive** (2026-11-23) |
| 2 | Does a session inherit `Workshop.MaxEnrollment` when it has none? | Yes — the only option that keeps existing workshops behaving identically |
| 3 | Is session capacity enforced? | No — informational only |
| 4 | Does `Registration` gain a session reference? | No |
| 5 | Does the public link change? | No |
| 6 | Should `WebSeatCap` be split across sessions? | No — it stays a workshop-level online cap |
| 7 | Does each session get its own form ID? | No — the form is pinned to the registration link, which is per-workshop (§8.1). A session needing its own form gets its own link |

### 10.2 Still open

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Do legacy `BackUpTime` values hold a usable start time? | Check in Phase 0; backfill only what parses |
| 2 | Should `BackUpTimeID` be dropped once `StartTime` is populated? | Not in this change. Leave the legacy column in place; drop it in a later cleanup once nothing reads it |
| 3 | Should the public page list session times? | Optional Phase 4 polish; skip unless asked |
| 4 | Do any sessions need a different form from the rest of their workshop? | Default no. If yes, create a second registration link for that session — no schema change (§8.1) |

---

## 11. Deliberate follow-up: making sessions bookable

If the business later wants registrants to pick a session, everything needed is additive and does not require reworking this change:

1. `Registration.WorkshopSessionID` (nullable) + FK + index.
2. A capacity check on the registration insert, inside a locked transaction (`UPDLOCK, HOLDLOCK` on the session row) so two people cannot take the last seat.
3. A `sessions` array on `GET /api/public/registration-links/:slug`, with `state = 'full'` only when every session is full.
4. A radio-group session picker on the public form.
5. Per-session capacity alerts, with a `NotifyFiredAt` column on the session.

None of that is in scope here, and none of it is blocked by the schema in §3.2 — the columns are additive.

---

## 12. Phasing

| Phase | Work | Effort | Depends on |
| --- | --- | --- | --- |
| **0. Verify** | Run §5.1 queries on test; inspect `ref.BackupTime` contents; confirm whether legacy sessions have distinct times | 0.5 day | DB access |
| **1. Schema** | Migration 012, `schema.sql` update, `vw_WorkshopSessionCounts`, index, `compare-schema.ps1` NO DRIFT | 0.5 day | 0 |
| **2. API** | Session CRUD with times/capacity, capacity resolution helper, bulk-create endpoint | 1–2 days | 1 |
| **3. Staff UI** | Sessions tab rework, repeat helper with preview, workshop form relabels | 2 days | 2 |
| **4. Polish** | Attendance report time columns, legacy time backfill + review queue, optional public session-times list | 1–2 days | 1, 3 |

**Total: ~1 week** for phases 1–3, ~1.5 weeks including polish.

### Testing

The repo has Vitest in `apps/api/test`. Add:

- `capacity.test.ts` — `sessionCapacity` fallback matrix (null/null, value/null, null/value, value/value).
- `sessions.test.ts` — POST/PATCH validation: end before start, min > max, date outside workshop range.
- `sessions-bulk.test.ts` — 3 × 60-minute sessions from 10:00 produce 10:00–11:00, 11:00–12:00, 12:00–13:00; `count` above 12 is rejected; a failure mid-insert leaves no rows.

---

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Legacy sessions have no usable times | High | Low | Times are nullable; the review report surfaces them; nothing breaks |
| Staff expect session capacity to block registrations | Medium | Medium | Help text on the Capacity field: *"For planning. Registrations are taken against the workshop's capacity."* |
| Staff read "Workshop regs" per session as a per-session roster | Medium | Low | Column is labelled "Workshop regs" and repeated, not split |
| Someone assumes `SessionHours` is per session | Medium | High | Documented as workshop-level in §9; field relabelled "Total hours" if needed |
| Duplicate sessions from repeated use of the repeat helper | Medium | Low | The helper previews rows before creating; duplicate date+start rows are visible in the table and deletable |

---

## 14. What this does not change

- `core.Registration` — no new column.
- `core.Workshop.StartTime` / `EndTime` / `MaxEnrollment` — kept, reinterpreted as defaults.
- `core.SessionParticipant` — unchanged; attendance stays per session.
- The public registration link, its capacity math and its state machine.
- `WorkshopRegistrationLink.FormTemplateVersionID` — forms stay pinned to the link, not the session (§8.1).
- Workshop-level `NotifyPercentFull` / `NotifyFiredAt`.
- Certificates, CEU math and the dashboard.
- `BackUpTimeID` — left in place, unused by new code.

---

## 15. Immediate next steps

1. **Get DB access** and run §5.1 — it decides whether the backfill in §5.2 is nearly free or a manual review.
2. On sign-off, write `db/migrations/012-workshop-sessions.sql` and update `db/schema.sql` in the same change.
3. Build the API (§4) and the Sessions tab (§7.1) together — the repeat helper is the part staff will judge the feature on.

---

## 16. What shipped (2026-11-23)

Phases 1–3 are implemented and verified. Phase 0 (the §5.1 data checks) and Phase 4 (polish) remain.

| Area | File | What changed |
| --- | --- | --- |
| Migration | `db/migrations/012-workshop-sessions.sql` | Adds `StartTime`, `EndTime`, `MaxEnrollment`, `MinEnrollment`, `Notes`; index `IX_WorkshopSession_Workshop_Date`; view `core.vw_WorkshopSessionCounts`. Guarded and re-runnable |
| Schema | `db/schema.sql` | Same columns, index and view in the `CREATE TABLE core.WorkshopSession` block, so a from-scratch build matches |
| Rules | `apps/api/src/services/sessions.ts` | `sessionCapacity`, `validateSession`, `planBulkSessions`, `minutesOf` / `timeOf`, `MAX_BULK_SESSIONS`. No database access, so it is unit-testable |
| API | `apps/api/src/routes/workshops.ts` | `GET` returns times, capacity, `EffectiveCapacity`, `CapacityInherited`, `WorkshopRegistered`. `POST`/`PATCH` accept the new fields; `PATCH` validates against the merged stored state. New `POST /:id/sessions/bulk` in one transaction |
| Types | `packages/shared/src/index.ts` | `WorkshopSessionRow` extended; new `WorkshopSessionWrite`, `WorkshopSessionBulkWrite`, `WorkshopSessionBulkResult` |
| Web client | `apps/web/src/api.ts` | `addSession` takes the full write shape; new `addSessionsBulk` |
| Sessions tab | `apps/web/src/components/WorkshopSessions.tsx` | Times, capacity with "(from workshop)", workshop regs, attended; "Add session" and "Add several" with a live preview of the rows to be created; incomplete rows sort first |
| Workshop form | `apps/web/src/components/WorkshopDrawer.tsx` | "Default start time" / "Default end time" / "Default capacity" with help text |
| Styles | `apps/web/src/styles/ui-roster.css` | `.field-help` for the explanatory line under the time fields |
| Tests | `apps/api/test/sessions.test.ts` | 18 unit tests: capacity fallback matrix, time parsing, cross-field validation, bulk planning and its cap |

**Verified:** `npm run typecheck` across all three workspaces; `npm test` (34 tests, against the live test database); `npm run build --workspace=@pe/web`; migration applied to the test database with all columns, index and view confirmed; end-to-end checks that bulk create produces 10:00–11:00 / 11:00–12:00 / 12:00–13:00, that a session with no capacity inherits the workshop's, that end-before-start is rejected on both `POST` and `PATCH`, and that `count > 12` is rejected.

**Still open:** the §5.1 data checks and the §5.2 time backfill (Phase 0 and Phase 4), and the form-question-vs-door-checklist decision for capturing intended session (§8).

### 16.1 Follow-up fixes (2026-11-23)

Two gaps found while checking workshop **TDB2717**, whose only session was 13:00–14:00 on a workshop listed as 08:45–11:15:

- **Time window was unchecked.** `checkSessionDateInWorkshop` validated the date but not the time, so a session could sit entirely outside the workshop's own hours. `sessionTimeWarning` now compares the session against a single-day workshop's `StartTime`/`EndTime` and returns a message. It is a **warning, not a rejection** — a workshop's times are often just the first session's, and staff may legitimately add an afternoon session without widening them. `POST`, `POST /bulk` and `PATCH` all return `{ warning }`, and the Sessions tab shows it in a dismissible `.alert-warn`.
- **Blank presenter rendered as `" "`.** `CONCAT(FirstName, ' ', LastName)` produced a single space for a presenter with no name parts. Now `NULLIF(LTRIM(RTRIM(...)), '')`, so the tab shows `—` as intended.

`PATCH` now returns `200 { warning }` instead of `204`, since the warning needs a body.

### 16.2 Presenter removed, session question added (2026-11-23)

**Presenter removed from sessions.** A workshop almost always has the same presenter for every session, so asking for it per session was noise. The Presenter field is gone from the Add-session form, the Sessions table and the API write path; `StaffID` stays on the table for legacy rows but is no longer written. The attendance checklist's session picker now shows the time instead of a presenter name.

**`session` form field type.** A form can now ask which session the registrant will attend, with the options resolved from the workshop's own Sessions tab:

- Migration `013-form-session-type.sql` widens `CK_FormQuestion_FieldType` to allow `session`, following the `agency` pattern in 009. `db/schema.sql` updated to match.
- `GET /api/public/registration-links/:slug` returns a `sessions` array — but only when the pinned form actually contains a `session` question, so links that do not ask for one are unaffected.
- The label (`"10:00 AM – 11:00 AM"`) is stored as the answer text, not the session id, so the answer stays readable after a session is edited or deleted. Sessions with no time are skipped — they would all read the same.
- The designer refuses a `session` field with its own options, since the choices come from the workshop.

This is the §8 option A: the answer lands in `core.FormAnswer` and shows on the Registrants tab, with no change to what the registration itself records.
