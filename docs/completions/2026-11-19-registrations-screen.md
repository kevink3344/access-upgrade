# Completion — Dashboard Links & Registrations Screen

**Date:** 2026-11-19
**Status:** ✅ Complete and verified end-to-end

---

## 1. Dashboard is now clickable

| Element | Links to |
| --- | --- |
| **Workshops this year** card | `/workshops` |
| **Registrations this year** card | `/registrations` |
| **Revenue this year** card | `/payments` |
| **Unpaid registrations** card | `/registrations?status=active` |
| Upcoming workshop titles | `/workshops?edit=<id>` — opens that workshop |
| Sidebar nav | unchanged |

Cards lift slightly and colour their value on hover; focus gets a visible outline. The `?edit=` deep link is handled by the Workshops page, which opens the drawer and then strips the query so closing it doesn't reopen.

---

## 2. Registrations — full CRUD

| Method | Path | Roles |
| --- | --- | --- |
| `GET` | `/api/registrations` | any |
| `GET` | `/api/registrations/:id` | any |
| `GET` | `/api/registrations/lookup-participants` | any |
| `GET` | `/api/registrations/lookup-workshops` | any |
| **`POST`** | `/api/registrations` | Admin, Manager, Editor |
| **`PATCH`** | `/api/registrations/:id` | Admin, Manager, Editor |
| **`DELETE`** | `/api/registrations/:id` | Admin, Manager |

**23 documented paths** total.

### Guards

| Rule | Response |
| --- | --- |
| Participant must exist | **422** with `participantId` detail |
| Workshop must exist (when supplied) | **422** with `workshopId` detail |
| One active registration per participant per workshop | **409** |
| `Source` cannot be set by the client | Always `Manual` on create |

That last one matters: `Source` distinguishes manual entry from the future public form. Letting a client set it would make the provenance field meaningless.

---

## 3. Screen

### List

| Feature | Detail |
| --- | --- |
| Pagination | 25 per page — **1,654 pages** for 41,341 registrations |
| Search | Participant name, email, or workshop title |
| Status filter | All / Active / **Unpaid** / Attended / Cancelled |
| Source filter | Manual / Web / eSchools |
| Columns | Participant (+ email), Workshop (+ code), Date, Registered, Paid, Status, Source, Actions |

Status pills distinguish **Unpaid** (amber) from Registered, Attended, and Cancelled — the unpaid ones are what staff chase.

### Drawer

**Type-ahead pickers** for participant and workshop rather than dropdowns. With 14,403 participants and 2,599 workshops a `<select>` is unusable; typing two characters searches server-side and returns the top 20.

Grouped into: Who and what · Payment · Status · Notes. Cancel is a soft delete with a confirmation explaining that history is preserved.

---

## 4. Verification

| Test | Result |
| --- | --- |
| List renders | ✅ 25 rows, 41,341 total, "Page 1 of 1,654" |
| Unpaid filter | ✅ 18,743 |
| Cancelled filter | ✅ 1,858 |
| Search "Heurter" | ✅ 1 match |
| Type-ahead participants ("smith") | ✅ 20 live results |
| Type-ahead workshops ("Sensory") | ✅ 16 results |
| Create via drawer | ✅ Saved, `Source=Manual` |
| Duplicate guard | ✅ 409 |
| Patch (amount, attended) | ✅ |
| Cancel (soft delete) | ✅ `IsCancelled=1`, row retained |
| Registration date defaults to today | ✅ |
| Test data cleanup | ✅ back to 41,341 |

---

## 5. Bugs found and fixed

**`RegistrationID` is not an IDENTITY column.** Same root cause as `WorkshopID` — created as plain `INT` to preserve legacy Access IDs. `POST` failed with *"Cannot insert the value NULL into column 'RegistrationID'"*. Fixed with `MAX(RegistrationID) + 1`.

**Route ordering, again.** The lookup routes were appended after `/:id`, so `/lookup-participants` matched as an ID. Moved before the parameterised route — the same mistake I made on workshops, so worth a lint rule.

**Empty date overrode the server default.** The drawer always sent `registrationDate`, so leaving it blank wrote `NULL` instead of letting the server default to today. Now dates are only sent when the user sets one.

**Underlines removed** from clickable titles, as requested.

---

## 6. Not built

- **Attendance marking.** The `attended` flag is editable per registration, but there is no per-session attendance grid (screen 10 in the plan).
- **Payment records.** Registrations reference a `PaymentID`; creating the payment itself is not wired up.
- **Bulk registration.** Adding a whole workshop's roster at once.
- **Receipt PDF.** `POST /api/payments/:id/receipt` is planned, not built.
- **Tests.** Manual verification only.

---

## 7. Suggested next steps

1. **Participants list** — the last of the three high-traffic screens, and the API is already done.
2. **Attendance grid** — per-session checklist, optimised for phone (plan §4.1). This is the screen staff use standing up in a room.
3. **Payments screen** — so `PaymentID` on a registration can actually be set.
