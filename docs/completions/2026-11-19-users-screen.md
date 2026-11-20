# Completion — Users Screen

**Date:** 2026-11-19
**Status:** ✅ Complete and verified end-to-end
**Route:** `http://localhost:5180/admin/users` · API: `/api/users`

---

## 1. What was built

The first fully functional CRUD screen. Everything else in the app is still a placeholder; this one is real.

| Artifact | Purpose |
| --- | --- |
| [`apps/web/src/pages/UsersPage.tsx`](../../apps/web/src/pages/UsersPage.tsx) | List, search, filter, create, edit, deactivate, reactivate |
| [`apps/web/src/styles/ui.css`](../../apps/web/src/styles/ui.css) | Shared toolbar, drawer, dialog, role pills — reusable by every future screen |
| `api.users.*` in [`apps/web/src/api.ts`](../../apps/web/src/api.ts) | Typed client methods |
| [`apps/api/src/routes/users.ts`](../../apps/api/src/routes/users.ts) | Built in the previous step, now consumed |

---

## 2. Features

### List

| Feature | Detail |
| --- | --- |
| Columns | Name (with avatar + "You" tag), Email, Role, Status, Last sign-in, Actions |
| Search | Debounced 250 ms, matches name or email |
| Filter | By role |
| Count | "N users", updates with filters |
| Empty states | Distinct messages for "no users" vs "no matches" |
| Loading | Skeleton rows |

### Create / edit

A right-hand drawer (full-screen on phones) with:

- Full name, Email, Password, Role
- **Zod validation** with per-field errors
- **Role descriptions** shown under the picker so the choice is informed
- On edit, password is optional — "leave blank to keep current"
- Duplicate email → 409 → "A user with that email already exists"

### Deactivate / reactivate

- Confirmation dialog explaining that records are kept and it's reversible
- **Soft delete only** — `IsActive = 0`, never a row delete, so audit history survives
- Reactivate is a single click, no confirmation

---

## 3. Safety guards

| Guard | Where | Behaviour |
| --- | --- | --- |
| Cannot deactivate yourself | UI | Button disabled, tooltip explains why |
| Cannot deactivate yourself | API | 409 `You cannot deactivate your own account` |
| Cannot change your own role | UI | Role picker disabled when editing yourself |
| Admin-only access | UI | Admin nav group hidden for non-admins |
| Admin-only access | Route | Direct navigation to `/admin/users` shows "Not available" |
| Admin-only access | API | 403 `Insufficient permissions` |

The API guard is the one that matters — the UI checks are convenience only.

---

## 4. Verification

All tested in a real browser against the live database.

| Test | Result |
| --- | --- |
| List renders | ✅ 1 user |
| Create user | ✅ Drawer opens, saves, list updates to 2 |
| Edit user role (Editor → Manager) | ✅ Role pill updates |
| Deactivate | ✅ Confirmation dialog → status Inactive, button becomes Reactivate |
| Reactivate | ✅ Status returns to Active |
| Search "editor" | ✅ 1 match |
| Search "zzzz" | ✅ Empty state shown |
| Role filter | ✅ |
| "You" tag on own row | ✅ |
| Deactivate button disabled on self | ✅ |
| Sign in as Manager | ✅ Admin group hidden (3 groups, not 4) |
| Manager navigates to `/admin/users` | ✅ "Not available" |
| Manager calls `GET /api/users` | ✅ **403** |
| Test user cleanup | ✅ Deleted from DB |

---

## 5. Not built

- **Pagination.** The list loads all users — fine for a handful of staff, but it should paginate before the count grows. The API already supports `page`/`pageSize` on other resources; `/api/users` currently returns everything.
- **Password reset flow.** An admin can set a password, but there is no self-service "forgot password".
- **Audit trail.** `audit.ChangeLog` exists but user changes aren't written to it yet.
- **Tests.** Verified manually; no automated coverage.

---

## 6. Notes for the next screen

The `ui.css` file now holds reusable pieces — `.toolbar`, `.drawer`, `.dialog`, `.role-pill`, `.row-actions`, `.data-table` extras. The next CRUD screen should reuse them rather than adding new styles.

The pattern established here:

1. `api.<resource>.list/create/update/delete` in `api.ts`
2. TanStack Query with `invalidateQueries` after mutations
3. Zod schema per form, per-field errors
4. Drawer for create/edit, dialog for destructive actions
5. Soft delete where history matters

**Suggested next:** the Workshops list — the API already supports pagination, search, six filters, and four sort columns, so the screen is mostly rendering.
