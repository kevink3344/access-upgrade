# App Roadmap — What to Build Next

**From:** A working app that covers the daily workflow, with a few promises it does not yet keep
**To:** A short, prioritised list of follow-on work, each with enough detail to plan from
**Prepared:** 2026-11-27
**Status:** **Planning** — nothing here is implemented yet. Item 4 is in progress (see its own plan).

**Related:** [Report subscriptions](./report-subscriptions.md) · [Email setup](../features/email-setup.md) ·
[Notifications](../features/notifications.md) · [Public registration](../features/public-registration.md) ·
[Responsive mobile](../features/responsive-mobile.md)

---

## 1. How this list was made

These are gaps found by reading the codebase, not a generic wishlist. Three of them are places
where the app **tells a user something that is not true**, which is why they rank at the top.

| # | Item | Why it matters | Effort | Status |
| --- | --- | --- | --- | --- |
| 1 | Transactional email | The confirmation screen promises an email that is never sent | 3–4 days | Not started |
| 2 | Participant self-service | Registrants cannot cancel or check details without phoning | 3 days | Not started |
| 3 | Reminders and attendance | No reminder before a workshop; no way to mark attendance | 2–3 days | Not started |
| **4** | **Scheduled report subscriptions** | **Staff must remember to run reports** | **~3 days** | **In progress** |
| 5 | Staff quality-of-life | Global search, duplicate surfacing, undo | 2 days each | Not started |
| 6 | Operational safety | Backups, health page, audit visible in the UI | 1–2 days each | Not started |
| 7 | Accessibility and mobile sweep | Two mobile bugs surfaced in one afternoon | 2 days | Not started |

---

## 2. Item 1 — Transactional email

**The problem.** `PublicRegisterPage` shows "A confirmation email is on its way. Keep it for
your records." No email is sent. There is no mail transport in the API at all: `sendAdminEmail`
in `services/webhooks.ts` posts a flat JSON payload to a Power Automate flow, and the Microsoft
Graph plan in [email-setup.md](../features/email-setup.md) was never built.

Every family who registers online is told something untrue, and has no record of the workshop,
date, location or cost.

**What it needs**

| Piece | Detail |
| --- | --- |
| A transport | Graph `Mail.Send` with an app identity, as already documented. SMTP is not available — the WCPSS relay authenticates by source IP and rejects App Service egress. |
| A send service | `sendMail({ to, subject, text, replyTo })`, with delivery recorded so a failure is visible rather than silent |
| A confirmation template | Workshop title, code, date, time, location, cost, and the registrant's name — the facts the screen shows |
| A kill switch | A setting in `core.NotificationSetting`, so a bad template can be stopped without a deploy |
| A retry path | One retry, then a notification to admins — the same shape as webhook delivery |

**Why it is first.** It is the only item where the app makes a false promise to the public, and
items 2, 3 and 4 all need a way to send mail. Building it once unblocks three others.

**Open question.** Who owns the Entra ID app registration? The admin consent request is written
in `email-setup.md` but nobody has sent it.

---

## 3. Item 2 — Participant self-service

**The problem.** A registrant cannot cancel, correct their details, or re-check where the
workshop is. Every one of those becomes a phone call to staff.

**What it needs**

- A signed, expiring token in the confirmation email linking to `/register/manage/:token`.
- A page showing the registration and offering **Cancel** and **Update details**.
- Server-side enforcement: the token authorises exactly one registration, expires after the
  workshop, and is invalidated when the registration is cancelled or moved.
- A staff-visible note on the roster when a registrant cancelled themselves.

**Depends on** item 1 (the link travels in the email).

---

## 4. Item 3 — Reminders and attendance

**The problem.** Nothing reminds registrants before the workshop, and the roster has no way to
record who actually attended — so the CEU and certificate numbers rest on staff remembering to
mark it elsewhere.

**What it needs**

- A reminder email 3 days before the workshop, to everyone on the roster who has not cancelled.
  Same scheduler shape as item 4 (§6 of [report-subscriptions](./report-subscriptions.md)).
- An **Attended** column on the roster, with a bulk "mark all present" action.
- The certificate eligibility query already reads attendance — confirm it uses this column
  rather than the current heuristic.

---

## 5. Item 4 — Scheduled report subscriptions *(in progress)*

Full design: [report-subscriptions.md](./report-subscriptions.md).

**Summary.** A staff member subscribes to a report with parameters once; the app emails it on a
chosen weekday. This document is the implementation plan — see §13 for what changed when the
work started.

---

## 6. Item 5 — Staff quality-of-life

### 6.1 Global search

A search box in the topbar that finds a participant, workshop or registration by name, code or
email, and jumps straight to it. Today staff navigate to a screen and filter — three or four
clicks for a question they answer on the phone in ten seconds.

- One endpoint, `GET /api/search?q=`, returning typed hits with a label and a path.
- Debounced client-side, keyboard-navigable results.
- Reuses the existing per-entity queries rather than a new index.

### 6.2 Surface likely duplicates

`MergeParticipantsDrawer` exists, but nothing points staff at a likely duplicate. A "possible
duplicates" count on the Participants list — same email, or same name plus phone — would make
the existing tool discoverable.

### 6.3 Undo instead of confirm

Archive, revoke link and delete all use `window.confirm`. A short-lived undo toast is both
kinder and safer: a mis-click is recoverable, and the confirmation dialog people click through
without reading stops being the only guard.

---

## 7. Item 6 — Operational safety

| Piece | Why |
| --- | --- |
| Backups and a restore drill | I could not verify from the repo that production is backed up, or that a restore has ever been tried. A backup nobody has restored is a hope, not a backup. |
| A status page | Checks DB reachability, the PDF renderer, and the last webhook delivery. A failure should be visible before a staff member reports it. |
| Audit visible in the UI | `audit.ChangeLog` is populated, but no screen shows who changed a registration or payment. For money and certificates that is worth surfacing. |

---

## 8. Item 7 — Accessibility and mobile sweep

Two mobile bugs surfaced in one afternoon: the collapsed sidebar rail squeezed the content to
32px on a phone, and help text wrapped one word per line as a result. Both were invisible on a
desktop.

- Walk every screen at 390px, including the public form.
- Keyboard and screen-reader pass over the public registration form before a large registration
  push.
- Add the public form to the manual test recipe in `docs/features/responsive-mobile.md`.

---

## 9. Sequencing

```
Item 1 (email) ──┬──> Item 2 (self-service)
                 ├──> Item 3 (reminders)
                 └──> Item 4 (report subscriptions)  ← in progress
Item 5 (search)  — independent, can run in parallel
Item 6, 7        — independent, good "fill-in" work
```

Item 4 is being built first because it is the smallest self-contained win: the report and PDF
machinery already exists, and the only missing piece is the scheduler and the send.
