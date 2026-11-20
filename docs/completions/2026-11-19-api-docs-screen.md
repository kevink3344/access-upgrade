# Completion — API Documentation Screen (Swagger UI)

**Date:** 2026-11-19
**Status:** ✅ Complete and verified
**Route:** `http://localhost:5180/admin/api-docs`

---

## 1. What was built

Swagger UI embedded **inside the app**, under Administration, behind login.

| Artifact | Purpose |
| --- | --- |
| [`apps/web/src/pages/ApiDocsPage.tsx`](../../apps/web/src/pages/ApiDocsPage.tsx) | Loads Swagger UI, fetches the spec, pre-fills the bearer token |
| [`apps/web/vite.config.ts`](../../apps/web/vite.config.ts) | Proxies `/openapi.json` to the API |
| [`apps/web/src/styles/dashboard.css`](../../apps/web/src/styles/dashboard.css) | `.swagger-host` rules so it sits inside the shell |

---

## 2. How it differs from the raw Swagger

The API already served `/swagger` on port 3001, but that is:

- on a different origin (needs the API port open)
- unauthenticated
- outside the app chrome

The embedded version fixes all three:

| | Raw `/swagger` | Embedded `/admin/api-docs` |
| --- | --- | --- |
| Reachable from the app | ❌ separate port | ✅ same origin |
| Behind login | ❌ | ✅ admin-only |
| Bearer token | paste manually | **pre-filled from the session** |
| Navigation | none | app sidebar and header |

The raw URL is still linked from the page for anyone who wants it.

---

## 3. Implementation notes

**Loaded from CDN, not bundled.** `swagger-ui-dist` is ~1.4 MB and is only needed by administrators, so it would roughly triple the main bundle for a screen most users never open. It loads on demand from unpkg, with a loading skeleton while it fetches.

**Token injection.** A `requestInterceptor` adds the current bearer token to every "Try it out" request if no `Authorization` header is already set. Staff can call endpoints without copying a JWT out of dev tools.

**Spec fetched at runtime.** `/openapi.json` is proxied by Vite in development. In production the API would serve the app and the spec from the same origin, so the path works unchanged.

**Topbar suppressed.** Swagger ships its own header bar; the app shell already provides navigation, so it is hidden and the rest of Swagger's chrome is softened to match the WCPDS tokens.

---

## 4. Verification

| Check | Result |
| --- | --- |
| Page renders | ✅ |
| Swagger UI mounts | ✅ `.swagger-ui` present |
| Tag groups | ✅ 8 — Auth, Dashboard, Users, Workshops, Participants, Agencies, Registrations, Lookups |
| Operations listed | ✅ 29 |
| Spec loads through proxy | ✅ |
| Authorize button present | ✅ |
| Token injected on requests | ✅ `GET /api/dashboard` → 200 with live counts |
| Swagger topbar hidden | ✅ |
| Admin nav item present | ✅ "API documentation" between Users and Utilities |
| Non-admin blocked | ✅ route guard in `main.tsx` |

---

## 5. Current API surface

23 documented paths across 8 tags:

| Tag | Endpoints |
| --- | --- |
| Auth | login, me, logout |
| Dashboard | summary |
| Users | list, get, create, patch, delete |
| Workshops | list, get, sessions, registrations, lookup-names, create, patch, delete |
| Participants | list, get, registrations |
| Agencies | list, get, board-members |
| Registrations | list, get, lookup-participants, lookup-workshops, create, patch, delete |
| Lookups | list keys, get by name (27 tables) |

---

## 6. Not done

- **Write endpoints for participants, agencies, payments, credit slips, training requests, community events.** Read-only today.
- **CDN dependency.** If unpkg is blocked on the district network the page shows an error. Bundling `swagger-ui-react` would remove that dependency at the cost of bundle size — worth revisiting if the network blocks it.
- **Production CSP.** `helmet` has CSP disabled on the API because Swagger needs inline styles; when the app is served from one origin this needs a considered policy rather than `false`.

---

## 7. Suggested next steps

1. **Participants screen** — the last high-traffic list, API already done.
2. **Remaining write endpoints** — participants, agencies, payments — so the API is genuinely complete.
3. **Attendance grid** — the phone-first screen from plan §4.1.
