# Completion — Workshops Screen & Full CRUD

**Date:** 2026-11-19
**Status:** ✅ Complete and verified end-to-end
**Route:** `http://localhost:5180/workshops` · API: `/api/workshops`

---

## 1. What was built

The highest-traffic screen in the app, with complete create/read/update/delete.

| Artifact | Purpose |
| --- | --- |
| [`apps/web/src/pages/WorkshopsPage.tsx`](../../apps/web/src/pages/WorkshopsPage.tsx) | Paginated list, search, filters, sortable columns |
| [`apps/web/src/components/WorkshopDrawer.tsx`](../../apps/web/src/components/WorkshopDrawer.tsx) | Create/edit form in a grouped drawer |
| [`apps/api/src/routes/workshops.ts`](../../apps/api/src/routes/workshops.ts) | `POST`, `PATCH`, `DELETE`, `lookup-names` added |
| [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts) | `WorkshopRow`, `WorkshopDetail`, `WorkshopWrite` types |

---

## 2. API — full CRUD

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/workshops` | any | Paginated; `q`, `schoolYear`, `category`, `status`, `sort`, `dir` |
| `GET` | `/api/workshops/:id` | any | Full record + joined names |
| `GET` | `/api/workshops/lookup-names` | any | Catalog titles for pickers |
| `GET` | `/api/workshops/:id/sessions` | any | |
| `GET` | `/api/workshops/:id/registrations` | any | |
| **`POST`** | `/api/workshops` | SUPER_ADMIN, ADMIN, MANAGER, EDITOR | 201 + new ID |
| **`PATCH`** | `/api/workshops/:id` | same | Partial update |
| **`DELETE`** | `/api/workshops/:id` | SUPER_ADMIN, ADMIN | 204, or 409 if dependent records |

**21 documented paths** total in Swagger.

### Delete guards

Deleting a workshop is refused when it would destroy history:

| Condition | Response |
| --- | --- |
| Has registrations or sessions | **409** — *"This workshop has 3 registration(s) and 1 session(s). Cancel it instead of deleting, so the history is preserved."* |
| Is the "Legacy workshop" placeholder (ID 0) | **409** — 78 legacy registrations depend on it |

Verified both.

---

## 3. Screen

### List

| Feature | Detail |
| --- | --- |
| Pagination | 25 per page, 104 pages for 2,599 workshops |
| Search | Debounced 250 ms on title or code |
| Filters | Status (open/closed/cancelled/all), school year |
| Sorting | Title, Code, Date, Capacity — click to toggle direction |
| Capacity | Inline bar with colour thresholds (80% amber, 100% red) |
| Status pills | Open / Closed / Cancelled / Full |
| Empty states | Distinct for "no matches" vs "none yet" |

### Create / edit drawer

Grouped into five fieldsets rather than one 30-field wall:

| Section | Fields |
| --- | --- |
| **Details** | Workshop name (catalog picker), Code, School year, Category |
| **Schedule** | Start/End date, Start/End time |
| **Enrollment** | Maximum, Minimum, Room |
| **Credit & cost** | Cost, Credit type, Sessions, Hours, CEUs |
| **Status** | 7 checkboxes (closed, cancelled, brochure, folder, label, contracted, staff dev) |
| **Notes** | Workshop notes, Special notes |

Validation includes a cross-field rule: **end date cannot precede start date**.

---

## 4. Verification

Tested in a real browser against the live database.

| Test | Result |
| --- | --- |
| List renders | ✅ 25 rows, 2,599 total, "Page 1 of 104" |
| Search "Sensory" | ✅ 16 matches |
| Status filter (open / cancelled) | ✅ |
| Sort by title | ✅ Order changes, indicator shows ▲ |
| Pagination | ✅ Page 2 loads |
| **Create** via drawer | ✅ UINEW1 appears, count → 2,600 |
| **Edit** — loaded values | ✅ Code, dates, times, max, notes all correct |
| **Edit** — save change | ✅ Max 30 → 45 persisted |
| **Delete** with confirm dialog | ✅ Removed, count → 2,599 |
| Delete guard — has registrations | ✅ 409 with counts |
| Delete guard — legacy placeholder | ✅ 409 |
| Validation — bad date | ✅ 422 `Use YYYY-MM-DD` |
| Test data cleanup | ✅ 0 test workshops remain |

---

## 5. Bugs found and fixed

**`WorkshopID` is not an IDENTITY column.** It was created as a plain `INT` so the legacy Access IDs could be loaded verbatim — which means new rows need an explicit ID. `POST` failed with *"Cannot insert the value NULL into column 'WorkshopID'"*. Fixed by taking `MAX(WorkshopID) + 1` inside the insert.

**Route ordering.** `/api/workshops/lookup-names` was registered *after* `/:id`, so Express matched `lookup-names` as an ID and returned 400. Moved before the parameterised route.

**SQL TIME columns serialise as full dates.** `StartTime` arrives as `1970-01-01T09:00:00.000Z`, so `slice(0, 5)` produced `"1970-"` — an invalid value that the browser rejected, leaving the time fields blank on edit. Fixed with a regex that extracts the time portion.

---

## 6. Not built

- **Workshop detail page.** Editing happens in a drawer; there is no full-page detail view with tabs for sessions, presenters, and evaluations. The API endpoints for those exist.
- **Bulk actions.** No multi-select or bulk status change.
- **`EvalTypeID`, `ComponentID`** are accepted by the API but not exposed in the form — they are rarely changed and add noise.
- **Optimistic updates.** Mutations invalidate and refetch; the list briefly reloads.
- **Tests.** Manual verification only.

---

## 7. Notes for the next screen

`ui.css` gained `.fieldset`, `.field-row`, `.checkbox-grid`, `.th-sort`, `.pager`, and `.drawer-wide` — reuse these.

The pattern now proven twice:

1. Zod schema in the API route, mirrored by a form schema in the drawer
2. `COLUMN_MAP` + `paramType()` for safe dynamic SQL — no string concatenation of user input
3. `invalidateQueries` after mutation
4. Delete guarded by dependency check, with the counts in the error message

**Suggested next:** Participants list — same shape, and the API is already paginated with search and agency filter.
