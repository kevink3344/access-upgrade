# Completion — Application Scaffold: Login & Dashboard

**Date:** 2026-11-19
**Status:** ✅ Complete and running
**Services:** API `http://localhost:3001` · Web `http://localhost:5180` · Swagger `http://localhost:3001/swagger`

---

## 1. What was built

| Layer | Stack | Location |
| --- | --- | --- |
| Frontend | React 19 + Vite 6 + TanStack Query + Zod | [`apps/web`](../../apps/web) |
| Backend | Node 24 + Express 4 + TypeScript | [`apps/api`](../../apps/api) |
| Shared | Types + WCPSS design tokens | [`packages/shared`](../../packages/shared) |
| Auth schema | `core.AppUser`, `core.RefreshToken`, `audit.LoginAttempt` | [`db/auth.sql`](../../db/auth.sql) |

Monorepo with npm workspaces. `npm install` at the root installs everything.

---

## 2. Login screen

Split-panel layout matching the plan's design language: gradient brand panel on the left with live database counts, form on the right.

**Behaviour**

| Feature | Implementation |
| --- | --- |
| Validation | Zod, client-side, before the request |
| Errors | Announced via `role="alert"`, field-level and form-level |
| Lockout | 10 failed attempts per email in 15 minutes → HTTP 423 |
| Attempt logging | Every attempt to `audit.LoginAttempt` with a hashed IP |
| Token storage | Access token in `sessionStorage` (cleared on tab close); refresh token in an `httpOnly` cookie |
| Session restore | `/api/auth/me` on reload |

**Deliberate choices**

- The error message is identical whether the email or password was wrong — no account enumeration.
- The refresh cookie is `sameSite: strict`, `httpOnly`, scoped to `/api/auth`.
- Passwords are bcrypt cost 12.

---

## 3. Dashboard

Real data from the migrated Azure SQL database — no mocks.

| Section | Content |
| --- | --- |
| School year | Current SY (2026-27) resolved from `ref.SchoolYear` |
| Stat cards | Workshops this year, registrations this year, revenue, unpaid |
| Upcoming workshops | Next 6 by start date, with capacity bars and status pills |
| Recent activity | Latest 8 registrations, with relative timestamps |

**Live figures verified:** 2,599 workshops · 14,403 participants · 41,341 registrations · 812 agencies · 91 workshops and 481 registrations in SY 2026-27.

---

## 4. API

Express, documented with OpenAPI 3.0.3 via `swagger-jsdoc`.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/login` | Sign in, returns JWT |
| `GET /api/auth/me` | Current user |
| `POST /api/auth/logout` | Clear refresh cookie |
| `GET /api/dashboard` | Landing-page summary |
| `GET /health`, `/health/ready` | Ops probes (ready pings SQL) |
| `GET /openapi.json` | The spec |
| `GET /swagger` | Swagger UI |

**Security verified**

| Test | Result |
| --- | --- |
| No token | 401 ✅ |
| Malformed token | 401 ✅ |
| Wrong password | 401 ✅ |
| Deactivated user | 401 (re-read on every request) ✅ |

---

## 5. Super-admin seeding

`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_USERNAME` + `SUPER_ADMIN_PASSWORD` are read from env on boot. The seeder is **idempotent and non-destructive**: if the email already exists it is left untouched, so a password changed in the UI is never reset by a restart.

Seeded account: `admin@projectenlightenment.local` (role `SUPER_ADMIN`, `IsSeeded = 1`).

Both variable names are accepted — `database/.env.example` uses `SUPER_ADMIN_USERNAME`, the API template uses `SUPER_ADMIN_EMAIL`.

---

## 6. Responsive

| Width | Layout |
| --- | --- |
| ≥ 1024px | Sidebar + content, two-column dashboard |
| < 1024px | Sidebar hidden, bottom tab bar |
| < 640px | Stat cards stack; tables become labelled cards |

Verified at 1440×900 and 390×844: **no horizontal scroll at 390px**, tab bar shows, sidebar hides, table rows stack with `data-label` prefixes.

---

## 7. Issues found and fixed

**Port 5173 was occupied by another project.** The first Vite instance silently failed to bind; every request was served by `school-forms-v1` on the same port, which is why the API proxy returned a 401 with an empty body. Moved to **port 5180** with `strictPort: true` so this fails loudly next time.

**`@pe/shared/tokens.css` did not resolve.** The string alias was replaced with an array of aliases using absolute paths.

**`mssql` had no type declarations.** Added `@types/mssql`.

---

## 8. Verification

| Check | Result |
| --- | --- |
| API typecheck | ✅ clean |
| Web typecheck | ✅ clean |
| Login end-to-end in browser | ✅ |
| Dashboard renders real data | ✅ |
| Navigation to placeholder routes | ✅ |
| Sign out returns to login | ✅ |
| Swagger UI serves | ✅ HTTP 200 |
| OpenAPI spec | ✅ 4 paths, bearerAuth scheme |
| Desktop layout | ✅ |
| Mobile layout (390px) | ✅ no horizontal scroll |

---

## 9. Credentials — action required

`database/.env.example` now holds **both** the SQL admin password and the super-admin password.

**The super-admin password is `900003` — six numeric characters.** That is roughly 1 million combinations, which is weak for the account that can create and manage every other user. Recommend replacing it with a 20+ character passphrase before this goes anywhere real.

**The SQL password should still be rotated.** It has appeared in plaintext in the file, in this transcript, and in shell history. `.gitignore` blocks the commit path only.

---

## 10. Not done

- **No CRUD yet** — as scoped. `/workshops`, `/participants`, `/agencies`, `/reports`, `/admin` are placeholder screens.
- **User management UI** — the `core.AppUser` table and roles exist; the Admin screen to add users is next.
- **Refresh token rotation** — tokens are issued and stored; the refresh endpoint is not built.
- **Rate limiting** — lockout is per-email; per-IP throttling is not implemented.
- **Tests** — no unit or E2E tests yet.

---

## 11. Suggested next steps

1. **Users admin CRUD** — add/edit/deactivate users, assign roles. This is what makes the super-admin useful.
2. **Workshops list + detail** — the highest-traffic screen (2,599 rows), with the dense Access-style entry the plan calls for.
3. **Rotate the two credentials** before the repository is published.
