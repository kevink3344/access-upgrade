# Completion — Full Menu & REST API Endpoints

**Date:** 2026-11-19
**Status:** ✅ Complete
**Services:** API `http://localhost:3001` · Web `http://localhost:5180` · Swagger `http://localhost:3001/swagger`

---

## 1. Full navigation menu

The sidebar now mirrors the Access switchboard (plan §7.1) so staff recognise where things live. **19 destinations in 4 groups.**

| Group | Items |
| --- | --- |
| **Overview** | Dashboard |
| **Data** | Workshops · Workshop catalog · Participants · Agencies · Presenters & staff · Registrations · Payments & receipts · Credit slips · Training requests · Community events · eSchools reconciliation |
| **Reports** | Folder builder · Workshop approval · Reports hub · Mailing lists |
| **Administration** | Users · Utilities · Admin *(SUPER_ADMIN / ADMIN only)* |

**Mobile** keeps a 5-item tab bar — Home, Workshops, People, Register, Reports — because 19 items in a tab bar is unusable.

Each item has its own icon (14 new inline SVGs, no icon-font dependency). Admin items are role-gated, so a `VIEWER` never sees them.

---

## 2. REST API — 20 documented endpoints

All endpoints are documented in OpenAPI 3.0.3 and visible in Swagger UI.

### Users (admin)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/users` | Filter by `q`, `role`, `isActive` |
| `GET` | `/api/users/:id` | |
| `POST` | `/api/users` | 409 on duplicate email |
| `PATCH` | `/api/users/:id` | Partial update; password re-hashed |
| `DELETE` | `/api/users/:id` | **Soft delete** — sets `IsActive = 0` |

**Safety guard:** an admin cannot deactivate their own account (409).

### Workshops

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/workshops` | Paginated; `q`, `schoolYear`, `category`, `status`, `sort`, `dir` |
| `GET` | `/api/workshops/:id` | Full record + joined names |
| `GET` | `/api/workshops/:id/sessions` | |
| `GET` | `/api/workshops/:id/registrations` | Roster |

### Participants

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/participants` | Paginated; `q`, `agencyId`, `sort`, `dir` |
| `GET` | `/api/participants/:id` | |
| `GET` | `/api/participants/:id/registrations` | |

### Agencies

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/agencies` | Paginated; `q`, `includeOutOfBusiness` |
| `GET` | `/api/agencies/:id` | |
| `GET` | `/api/agencies/:id/board-members` | |

### Registrations

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/registrations` | Paginated; `q`, `workshopId`, `participantId`, `source`, `status` |
| `GET` | `/api/registrations/:id` | |

### Lookups — one endpoint, 27 tables

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/lookups` | Lists available keys |
| `GET` | `/api/lookups/:name` | e.g. `payment-methods`, `school-years` |

Adding a lookup means adding one line to a whitelist — no new route, no new SQL. Table and column names come from that whitelist, never from user input, so there is no injection surface.

---

## 3. Conventions applied

| Convention | Implementation |
| --- | --- |
| Validation | Zod, per endpoint, 422 with `{ path, message }[]` |
| Pagination | `page`, `pageSize` (max 200) → `{ data, page, pageSize, total }` |
| Sorting | Whitelisted columns only — never raw user input |
| Auth | `requireAuth` on every route; `requireRole` on admin routes |
| Errors | `{ error, message, details? }` |

---

## 4. Verification

| Check | Result |
| --- | --- |
| API typecheck | ✅ clean |
| Web typecheck | ✅ clean |
| OpenAPI paths | ✅ 20, across 8 tags |
| OpenAPI schemas | ✅ 7 named schemas |
| `/api/users` | ✅ 1 row |
| `/api/lookups` | ✅ 27 keys |
| `/api/lookups/payment-methods` | ✅ 12 rows |
| `/api/workshops` | ✅ 2,599 total |
| `?q=Sensory` | ✅ 16 matches |
| `?status=open` | ✅ 789 |
| `?status=closed` | ✅ 1,524 |
| `?status=cancelled` | ✅ 286 |
| `?schoolYear=21` | ✅ 91 |
| `?sort=name` / `?sort=registered` | ✅ |
| `/api/participants` | ✅ 14,403 total |
| `/api/participants?q=smith` | ✅ 138 |
| `/api/agencies` | ✅ 809 |
| `/api/registrations` | ✅ 41,341 total |
| Menu groups | ✅ 4 groups, 19 items |
| All sidebar links clickable | ✅ 19/19 reachable |
| Role gating | ✅ Admin group hidden from non-admins |

---

## 5. Bugs found and fixed

**SQL join order.** The workshops list appended `LEFT JOIN`s *after* the `WHERE` clause, producing `Incorrect syntax near the keyword 'LEFT'` whenever a filter was applied. Unfiltered requests worked, which is why it was easy to miss. Joins now precede `WHERE`.

**Sidebar links overlapped and swallowed clicks.** With 19 items the nav exceeded the viewport, and flex shrinking caused sections to overlap — `elementFromPoint` returned a different link than the one being clicked. Fixed with `flex-shrink: 0` on sections so the sidebar scrolls properly.

**`mssql` type mismatch.** `sql.Int` / `sql.Bit` are factories, not `ISqlType` instances. Introduced a shared `SqlParam` type in `db.ts` rather than casting at every call site.

---

## 6. Not done

- **Screens are still placeholders.** The API is ready; the UI for each resource is next.
- **No POST/PATCH/DELETE for workshops, participants, agencies, registrations.** Read endpoints only — writes come with the screens that need them.
- **No tests.** No unit or integration coverage yet.
- **Refresh token rotation** not implemented.

---

## 7. Suggested next steps

1. **Users screen** — the API is complete; this is a small form + table and unlocks real staff accounts.
2. **Workshops list** — 2,599 rows with the filters already built into the API.
3. **Workshop detail** — tabs for sessions, presenters, registrations (all three endpoints exist).
