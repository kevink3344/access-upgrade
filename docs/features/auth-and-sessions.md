# Authentication and sessions

Two tokens, two lifetimes, one rule: **an expired access token is not a sign-out.**

| Token | Where it lives | Lifetime | Purpose |
| --- | --- | --- | --- |
| Access token (JWT) | `sessionStorage`, or `localStorage` with "remember me" | `JWT_EXPIRES_IN` (8h) | Sent as `Authorization: Bearer` on every API call |
| Refresh token | httpOnly cookie `pe_refresh`, scoped to `/api/auth` | `REFRESH_TOKEN_DAYS` (7d), or the browser session | Exchanged for a new access token |

The access token is deliberately short-lived and the refresh token is the only long-lived
credential. Because the refresh cookie is httpOnly, page scripts cannot read it — an XSS bug
can steal the access token but not the ability to renew it indefinitely.

## The flow

```
login            → access token (body) + refresh cookie (Set-Cookie)
any API call     → 401 when the access token has expired
client           → POST /api/auth/refresh (cookie only)
server           → new access token + a *rotated* refresh cookie
client           → replays the original request once
```

The client side lives in [`apps/web/src/api.ts`](../../apps/web/src/api.ts). A single
`refreshInFlight` promise is shared, so ten concurrent 401s cause one refresh rather than
ten — which matters, because the second refresh would present an already-revoked token and
kill the session.

Session restore on page load ([`auth.tsx`](../../apps/web/src/auth.tsx)) follows the same
rule: try `/me`, and only if that fails try the refresh cookie, and only if *that* fails
clear the token.

## Rotation and reuse detection

Every refresh revokes the presented token and issues a new one. `core.RefreshToken.ReplacedByHash`
records which token replaced it (migration `020`), so each session forms a chain.

| Situation | Server response |
| --- | --- |
| Valid live token | 200, rotated |
| No cookie | 401 `no_refresh_token` |
| Unknown or expired | 401 `invalid_refresh_token`, cookie cleared |
| **Already-rotated token presented again** | 401 `refresh_token_reused` — **every live token for that user is revoked** |
| Account deactivated | 401 `account_inactive`, chain revoked |

The last row is the point of the design. A refresh token that has already been used can only
be presented again by someone replaying a copy — the real user's browser has moved on. Rather
than guess which holder is legitimate, the whole chain is revoked and both parties are asked
to sign in again. Losing a session is cheap; a stolen cookie that renews forever is not.

Rotation is a compare-and-swap (`UPDATE ... WHERE RevokedAt IS NULL`), so two requests racing
with the same token produce exactly one rotation and one reuse rejection.

## Sign-out

`POST /api/auth/logout` revokes the token server-side before clearing the cookie. Clearing a
cookie only stops the browser sending it; it does not stop a copy of its value being replayed.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | — | 32+ chars. Also salts the IP hashes in the audit tables. |
| `JWT_EXPIRES_IN` | `8h` | Access token. Shorten if you want tighter revocation windows. |
| `REFRESH_TOKEN_DAYS` | `7` | Refresh token when "remember me" is ticked. |

Rotating `JWT_SECRET` invalidates every access token immediately; users are bounced to the
login screen once and then carry on. It is the fastest way to force a global sign-out.

## Tests

[`apps/api/test/auth-refresh.test.ts`](../../apps/api/test/auth-refresh.test.ts) covers the
no-cookie, unknown-token, rotation, replay-revokes-chain and logout-revokes cases. They run
against the test database and clean up their own tokens.
