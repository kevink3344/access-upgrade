# Completion — Public Registration Links

**Date:** 2026-11-20
**Status:** ✅ Complete and verified end-to-end
**Spec:** [docs/features/public-registration.md](../features/public-registration.md)

---

## 1. What was built

A shareable link per workshop so participants can register online, exactly as the feature spec describes.

| Artifact | Purpose |
| --- | --- |
| [`db/public-registration.sql`](../../db/public-registration.sql) | Link table, workshop switch, submission audit |
| [`apps/api/src/routes/registration-link.ts`](../../apps/api/src/routes/registration-link.ts) | Staff-side link management |
| [`apps/api/src/routes/public.ts`](../../apps/api/src/routes/public.ts) | Public, unauthenticated endpoints |
| [`apps/web/src/components/RegistrationLinkPanel.tsx`](../../apps/web/src/components/RegistrationLinkPanel.tsx) | Staff panel inside the workshop drawer |
| [`apps/web/src/pages/PublicRegisterPage.tsx`](../../apps/web/src/pages/PublicRegisterPage.tsx) | Standalone public form |

**30 documented paths** across 10 tags.

---

## 2. The URL

```
http://localhost:5180/register/l-1_rtmza8D9oJQk
```

**Opaque 16-character slug**, as specified — not the workshop code. This was the right call: `WorkshopCode` is **not** unique (8 codes are reused, 4 of them within the same school year), 13 workshops have no code at all, and codes are staff-typed and editable. A code-based URL would collide and break whenever a typo was corrected.

The slug is unguessable, individually revocable, and survives any workshop edit.

---

## 3. Two independent switches

| Switch | Level | Public message |
| --- | --- | --- |
| `Workshop.IsRegistrationOpen` | Workshop | **"Registration is closed"** |
| `RegistrationLink.IsActive` | Link | **"This link is no longer valid"** |

They are separate because the reasons differ — closing a workshop is a business decision, revoking a link is usually a distribution mistake. **Both default to off**; a workshop is never publicly registerable by accident.

Verified both states return distinct messages.

---

## 4. Public form

Standalone surface — no sidebar, no header, no staff chrome. Verified: `.sidebar` and `.topbar` absent from the DOM.

| Feature | Detail |
| --- | --- |
| Workshop summary | Title, code, date, time, location, cost, credit |
| Availability | Coarse bands only — "20 or more places remaining", "Fewer than 10", "Registration is full" |
| Fields | First/last name, email, phone, agency (type-ahead), position, grade level, notes |
| Payment | **None** — "Payment is arranged separately" |
| Mobile | 16px inputs (prevents iOS zoom), 48px targets, single column |
| Terminal states | Revoked / closed / not-yet-open / full each get their own message |

**Agency is a searchable picker**, not free text — the public form cannot create an agency, which is how the legacy table accumulated near-duplicates.

---

## 5. Abuse protection

| Control | Implementation | Verified |
| --- | --- | --- |
| Rate limit per IP | 10 submissions/hour | ✅ |
| Rate limit per email | 5 submissions/hour | ✅ |
| Rate limit per link | 200 submissions/hour | ✅ |
| Honeypot | Hidden field, off-screen at `x: -9999` | ✅ rejected 422 |
| Timing check | Under 3 seconds → reject | ✅ rejected 422 |
| No CAPTCHA | Deliberate — accessibility | — |

Every submission is logged to `audit.PublicSubmission` **before** business logic runs, so rejected attempts are visible. Verified all five outcomes recorded: `Accepted`, `Duplicate`, `Honeypot`, `Rejected:too-fast`, `Rejected:validation`.

---

## 6. Behaviour details

**Participant matching.** Exact email (case-insensitive) → reuse that participant. No match → create one. **Never auto-merges**, consistent with the existing rule.

**Duplicate registration.** Same email + same workshop + not cancelled → the existing registration is updated, not duplicated. The response is **identical** to a fresh success, so the form cannot be used to discover whether an address is registered.

**Provenance.** Every web registration carries `Source = 'Web'` and the `RegistrationLinkID` that created it.

---

## 7. Verification

| Test | Result |
| --- | --- |
| Create link | ✅ slug issued, starts inactive |
| Inactive link → public | ✅ "This link is no longer valid" |
| Activate + open workshop | ✅ state `open`, availability `limited` |
| Submit registration | ✅ participant + registration created |
| Duplicate submit | ✅ same registration ID returned |
| Honeypot | ✅ 422 |
| Too fast | ✅ 422 |
| Validation failure | ✅ 422 |
| Unknown slug | ✅ 404 |
| Workshop closed (link active) | ✅ "Registration is closed" — distinct from revoked |
| Staff panel | ✅ link, 1 web registration, cap, toggle |
| No staff chrome on public page | ✅ |
| Test data cleanup | ✅ back to 14,403 / 41,341 |

---

## 8. Not built

- **Confirmation email.** A token is generated and stored on the registration, but no email is sent — there is no SMTP configuration yet.
- **Confirmation link endpoint.** `GET /api/public/registrations/:token/confirm` is specified but not implemented.
- **Provisional expiry job.** Spec says unconfirmed registrations release their seat after 48 hours; nothing does this yet.
- **Multiple attendees.** The spec allows a director to register several teachers in one submission; the form registers one person.
- **Opens/closes schedule.** The API accepts `opensAt`/`closesAt` and the resolver honours them, but the staff panel has no date pickers for them.
- **Rate limiting is in-memory.** Correct for one instance; needs Redis or a gateway rule before running more than one.

---

## 9. Suggested next steps

1. **Confirmation email** — the token exists; it needs an SMTP provider and a template. Without it, "check your email" is currently untrue.
2. **Payments screen** — web registrations carry no payment, so staff need the payment record to reconcile.
3. **Attendance grid** — the phone-first screen from plan §4.1.
