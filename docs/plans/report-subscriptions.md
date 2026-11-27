# Scheduled Report Subscriptions — Email a Report on a Chosen Day

**From:** A staff member opens the Reports hub and runs a report when they remember to
**To:** They subscribe to a report once, and the system emails it to them on a day they choose (Fridays by default)
**Prepared:** 2026-11-26
**Status:** **Planned** — not implemented.

**Related:** [Reports hub](../features/reports.md) · [Notifications](../features/notifications.md) · [Webhooks](../features/webhooks.md) · [Deployment](../features/deployment.md)

---

## 1. Executive summary

Reports are already a code-defined registry (`REPORT_BY_KEY` in
`apps/api/src/services/reports.ts`), each with `key`, `title`, `parameters`, `columns` and a
`run(params)` that returns rows. The PDF path already exists too: `GET /api/reports/:key/pdf`
runs the report, renders HTML with `renderReportHtml`, and converts it with `renderPdf`.

So the report half is done. What is missing is three things:

| Missing piece | Today | Needed |
| --- | --- | --- |
| **A subscription record** | Nothing | Who wants which report, with which parameters, on which day |
| **A scheduler** | The API has no timer except a rate-limit sweep | Something that fires once a day and sends what is due |
| **A way to email a PDF** | `sendAdminEmail` sends text through a webhook | Attachments, or a link the recipient can click |

**Recommendation: email a secure link to the report, not the PDF as an attachment.** See §5 —
it sidesteps the webhook's payload shape, keeps mail small, and means the recipient's access is
re-checked at the moment they open it.

**Effort estimate: ~3 days** for the core (schema, scheduler, send, UI), plus half a day for
delivery history and a re-send button.

---

## 2. How reports work today

```ts
export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  group: ReportGroup;
  parameters: ReportParameter[];   // school-year | date | category | workshop
  columns: ReportColumn[];
  run: (params: ReportParams) => Promise<ReportRow[]>;
}
```

Two facts drive the design:

1. **Reports are code, not rows.** A subscription stores a `reportKey` string, not a foreign
   key. If a report is renamed or removed, subscriptions to it must be handled gracefully
   (§7.3) rather than becoming orphans.
2. **Parameters are typed and report-specific.** `schoolYearId` is required on most reports;
   `from`/`to` are relative to when the report runs. A subscription must store the *parameter
   values*, and must decide what "this school year" means on the Friday it fires.

---

## 3. Schema (migration 032)

```sql
CREATE TABLE core.ReportSubscription (
    ReportSubscriptionID INT IDENTITY(1,1) NOT NULL
        CONSTRAINT PK_ReportSubscription PRIMARY KEY,
    UserID          INT           NOT NULL
        CONSTRAINT FK_ReportSubscription_User REFERENCES core.AppUser(UserID),
    ReportKey       NVARCHAR(60)  NOT NULL,
    -- The parameters the report was subscribed with, as JSON. Stored rather
    -- than normalised: every report has its own parameter set, and a column
    -- per parameter would be mostly NULL.
    ParamsJson      NVARCHAR(MAX) NULL,
    -- 0 = Sunday .. 6 = Saturday, matching JavaScript's getDay().
    DayOfWeek       TINYINT       NOT NULL
        CONSTRAINT DF_ReportSubscription_Day DEFAULT 5
        CONSTRAINT CK_ReportSubscription_Day CHECK (DayOfWeek BETWEEN 0 AND 6),
    -- Local time the digest goes out. A single value for the workspace, so
    -- "Friday" means the same thing to everybody.
    SendHour        TINYINT       NOT NULL
        CONSTRAINT DF_ReportSubscription_Hour DEFAULT 7
        CONSTRAINT CK_ReportSubscription_Hour CHECK (SendHour BETWEEN 0 AND 23),
    IsActive        BIT           NOT NULL
        CONSTRAINT DF_ReportSubscription_Active DEFAULT 1,
    -- The last day it actually fired, so a restart cannot double-send.
    LastSentOn      DATE          NULL,
    CreatedAt       DATETIME2(0)  NOT NULL
        CONSTRAINT DF_ReportSubscription_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy       NVARCHAR(200) NULL,
    CONSTRAINT UQ_ReportSubscription UNIQUE (UserID, ReportKey, ParamsJson)
);
```

Notes:

- **One row per (user, report, parameters).** Subscribing twice to the same report with the
  same filters updates the day rather than creating a second email.
- **`ParamsJson` in the unique key** is deliberate: "Attendance for 2025-26" and "Attendance for
  2026-27" are different subscriptions, and both are legitimate.
- `LastSentOn` is the idempotency guard (§6.2). It is a `DATE`, not a timestamp, because the
  question is "did this fire today", not "when exactly".
- Guarded and re-runnable, like every migration in `db/migrations`. Apply to **both** databases.

A second, small table records what was sent — see §8. It is optional for the first cut and can
land in the same migration.

---

## 4. API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/reports/subscriptions` | any signed-in user | **My** subscriptions |
| `POST /api/reports/subscriptions` | any signed-in user | Subscribe to a report |
| `PATCH /api/reports/subscriptions/:id` | owner | Change the day, hour, or active flag |
| `DELETE /api/reports/subscriptions/:id` | owner | Unsubscribe |
| `POST /api/reports/subscriptions/:id/send-now` | owner | Send it once, immediately — the test button |

**Ownership matters.** These are personal subscriptions: a user may only see and change their
own rows. The route must filter by `req.user.userId` rather than trusting the id in the path,
or one staff member could unsubscribe another.

**Mount order matters.** `reportsRouter.get('/:key')` is registered at `reports.ts` line 173,
so a request for `/api/reports/subscriptions` would match it first and return "No such report".
The subscription routes must be registered **above** `/:key` — the same trap the existing
`/charts/:key` route avoids by being declared earlier.

`send-now` is the feature that makes the whole thing trustworthy. Without it, a staff member
has to wait until Friday to find out whether they configured it correctly — and if they got it
wrong, they have silently missed a week.

---

## 5. How the email is built

### 5.1 Recommended: a link, not an attachment

`sendAdminEmail` posts a flat JSON payload to a Power Automate flow:

```json
{ "notify_type": "admin", "email_to": "...", "email_subject": "...", "email_body": "...", "app_link": "..." }
```

There is no attachment field, and the flow is not in this repo. Adding one means changing the
flow as well as the app, and a PDF attachment would also need base64 encoding inside a JSON
body — which is fragile for anything but a small report.

**So the email carries a link to the report instead.** The body says what the report is and what
parameters it used, and `app_link` points at the report already run:

```
/api/reports/attendance-summary?schoolYearId=3&from=2026-11-20&to=2026-11-26
```

Benefits:

- No change to the Power Automate flow.
- The recipient's access is re-checked when they open it, so a revoked account cannot read a
  report from an old email.
- The link lands on the live, filterable table rather than a frozen PDF — usually what staff
  actually want.

**If a PDF attachment turns out to be required**, that is a separate decision: it needs a
`notify_type: report` flow with an attachment field, and the app would base64 the PDF into the
payload. Worth confirming with whoever owns the flow before building it.

### 5.2 The email body

Plain text, matching the existing notifications:

```
Your weekly report: Attendance summary

School year 2025-26 · 20 Nov – 26 Nov 2026
412 registrations, 388 attended.

Open the report: https://<app>/reports/attendance-summary?...
```

The one-line summary is generated from the rows (count, and the first numeric column) so the
email is useful even if the link is never clicked.

---

## 6. The scheduler

### 6.1 Where it runs

The API already runs one timer (`setInterval` in `routes/public.ts`, `.unref()`ed). The
scheduler follows the same shape: a `setInterval` started at boot, checking every 15 minutes
whether anything is due.

**Why not cron or a separate worker:** the app is a single App Service without a job host, and
adding one is a deployment change. A 15-minute poll inside the existing process is enough for a
weekly digest and needs no new infrastructure.

**Caveat to state plainly:** if the App Service is scaled to more than one instance, every
instance would run the scheduler and send duplicates. The `LastSentOn` guard (§6.2) makes that
safe *for the same day*, but the correct fix is either a single-instance setting or a
`sp_getapplock` around the send. **Recommendation: take an app lock** — it costs one query and
removes the constraint on scaling.

### 6.2 Idempotency

For each due subscription:

1. `LastSentOn = today` → skip. This is what makes a restart, a redeploy, or a second instance
   harmless.
2. Otherwise send, then set `LastSentOn = today` **after** the send succeeds.

Order matters: marking first and failing would lose the week silently; marking after and
crashing mid-send would resend, which is the lesser evil for a report.

### 6.3 What "this week" means

Date parameters (`from`/`to`) are relative. A subscription stores them as **tokens**, not dates:

| Stored | Resolved on the day it fires |
| --- | --- |
| `{"range":"last-7-days"}` | `from` = today − 7, `to` = yesterday |
| `{"range":"last-week"}` | `from`/`to` = the previous Monday–Sunday |
| `{"range":"this-school-year"}` | resolved from `ref.SchoolYear` at send time |

Storing a literal `from`/`to` would mean the "weekly" report silently repeats the same week
forever — the single most likely way this feature would fail in practice.

---

## 7. Edge cases worth deciding now

### 7.1 A user is deactivated
Skip their subscriptions. Do not delete them — reactivating the account should restore the
subscription, not require setting it up again.

### 7.2 The report returns no rows
Still send, with "No data for this period" in the body. Silence is indistinguishable from a
broken scheduler, and staff would not know to check.

### 7.3 The report key no longer exists
A report removed from the registry leaves a subscription pointing at nothing. The scheduler
skips it and writes one notification to the owner: "Your subscription to *X* was turned off
because that report is no longer available." Do not silently skip — the user chose this.

### 7.4 The send fails
Record the failure and retry once at the next poll interval. After a second failure, leave
`LastSentOn` unset so the next scheduled day tries again, and surface the failure on the
subscription row in the UI. A staff member who never receives their Friday report should be able
to see why.

### 7.5 Time zones
`SendHour` is in the workspace's local time. The app already assumes `America/New_York` for the
calendar feed, so use the same constant rather than introducing a second notion of local time.

---

## 8. Delivery history (optional, second cut)

A `core.ReportSubscriptionSend` table — subscription id, sent at, row count, outcome, error —
gives the UI a "Last sent" line and makes §7.4 visible. Worth including in the first migration
even if the UI only reads it later; backfilling history is impossible.

---

## 9. UI

In the Reports hub, on each report's row: a **Subscribe** action opening a small dialog.

```
Subscribe to "Attendance summary"

  Send on     [ Friday ▾ ]
  Time        [ 7:00 AM ▾ ]
  School year [ 2025-26 ▾ ]     ← the report's own parameters
  Range       [ Last 7 days ▾ ]

  [ Send me one now ]   [ Subscribe ]
```

The parameter controls are generated from `ReportDefinition.parameters`, so a new report gets
subscription support with no UI work — the same way the report runner already builds its form.

A **My subscriptions** list (either on the hub or under Settings) shows each one with its day,
last-sent date, and an unsubscribe toggle.

---

## 10. Tests

| Test | Asserts |
| --- | --- |
| Scheduler fires on the right day | A Friday subscription runs on Friday, not Thursday |
| Already sent today | A second poll the same day sends nothing |
| `last-7-days` resolves at send time | Two runs a week apart produce different `from`/`to` |
| Deactivated user | No email; row left intact |
| Unknown report key | Skipped, owner notified, no crash |
| Send failure | `LastSentOn` not set; retried next poll |
| Ownership | User A cannot read or delete user B's subscription |
| No rows | Still sends, body says "No data" |

---

## 11. Out of scope

- Sending a report to someone who is not an app user (a distribution list). The recipient is an
  `AppUser`, so access is always checkable.
- Excel/CSV attachments. The link covers the need; a CSV export is a separate feature.
- Per-subscription recipients or CC lists.
- Subscribing to Visual Reports charts.
- A user-facing "schedule" for anything other than reports.

---

## 13. What changed when this was built

Recorded so the plan and the code do not disagree.

| Planned | Built | Why |
| --- | --- | --- |
| `UNIQUE (UserID, ReportKey, ParamsJson)` | Unique index over a persisted `ParamsHash` | `NVARCHAR(MAX)` cannot be an index key in SQL Server |
| `RowCount` column | `RowsInReport` | `RowCount` is a reserved word in T-SQL |
| Email to the subscriber | Email to the admin list | `sendAdminEmail` fixes `email_to` to the admin list; a per-recipient send needs a `notify_type: report` flow (see roadmap item 1) |
| `{"range":"last-7-days"}` | `from`/`to` both set to the token | The report runner takes two dates; one token resolves to both |
| `sp_getapplock` "recommended" | Implemented | It costs one query and removes the single-instance constraint |

Still open from §12: the default hour (7:00 AM is built) and whether every role may subscribe
(currently yes — subscriptions are personal and read-only).

1. **Link or PDF attachment?** §5.1 recommends a link, because the webhook has no attachment
   field. If the flow can be extended, an attachment becomes viable — but it is a second
   decision, not a small one.
2. **Who can subscribe?** Any signed-in user, or only managers and above? Subscriptions are
   personal and read-only, so any role seems safe — but a viewer could receive data they cannot
   otherwise open, which the link would then refuse. Worth confirming the intent.
3. **Default day.** Fridays at 7:00 AM is assumed. Confirm the hour.
