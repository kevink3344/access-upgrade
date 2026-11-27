# Per-Form Header Image — A Staff-Uploaded Banner Stored in SQL Server

**From:** Every public form shows the same Project Enlightenment lockup, and the only way to see a form as the public sees it is to open its live link
**To:** A form can carry its own header image (a single combined banner made by staff) and falls back to the standard lockup when it has none; staff can open a read-only preview of the public page from the form editor at any time, including before the form is published
**Prepared:** 2026-11-26
**Revised:** 2026-11-27 — preview added (§10)
**Status:** **Planned** — not implemented. Two design points settled (§1.1); one still open (§7).

**Related:** [Form designer](./form-designer.md) · [Form template](./form-template.md) · [Form types and storage](./form-types-and-storage.md) · [Public registration](../features/public-registration.md)

**Contents:** §1 summary · §2 current behaviour · §3 schema · §4 API · §5 public page ·
§6 admin UI · §7 open decision · §8 tests · §9 out of scope · **§10 preview** · §11 preview tests

---

## 1. Executive summary

Staff want a form to open with their own banner instead of the standard lockup. The sample
supplied is **one combined image** — the Project Enlightenment logo, the form title and three
photographs are all baked into a single file. That matters: there is no compositing, cropping
or layering to do. The page renders one `<img>`.

The plumbing already exists. `core.CertificateAsset` stores images in SQL Server as
`VARBINARY(MAX)`, and `apps/api/src/routes/certificates.ts` already has the whole upload path:

| Already built | Where |
| --- | --- |
| Content-type allowlist (PNG, JPEG, SVG, WebP) | `decodeImage` |
| 2 MB ceiling, enforced in code and by a table CHECK | `MAX_UPLOAD_BYTES`, `CK_CertificateAsset_Size` |
| SHA-256 de-duplication | `storeAsset` |
| Streaming GET with the right `Content-Type` | `GET /api/certificates/templates/:id/logo` |

**Recommendation: generalise that table rather than build a second image store.** One upload
path, one size limit, one set of checks — and two forms sharing a banner store the bytes once.

**Effort estimate: ~1.5 days** — about a day for the header image, half a day for the preview
(§10), which shares the public page's rendering and so is cheap once the page exists.

### 1.1 Decisions taken

| Question | Decision | Why |
| --- | --- | --- |
| Is the sample one image or several? | **One combined image** | Confirmed by the requester. No compositing. |
| Replace the lockup, or sit above it? | **Replace** | The image already contains the logo and the title. Showing the lockup as well would print the logo twice. |

### 1.2 Decision still open

**Does the image attach to the form template, or to each version?** See §7. This changes the
schema, so it is the one thing to settle before coding.

### 1.3 The second request — preview the public page

Staff also want to **see a form as the public sees it, from the form editor**, rather than
opening the live link (which they may not have, which may be closed, and which always shows the
*published* version, never the draft they are editing). Planned in §10. It is the same page —
`PublicRegisterPage` — rendered read-only in a new tab, so the header image added here is
visible in the preview the moment it is uploaded.

---

## 2. Current behaviour

`PublicRegisterPage.tsx` renders `<PublicBrand>` at the top of every public card — the form,
the "full" screen, the confirmation and the terminal states:

```tsx
function PublicBrand({ subtitle = 'Workshop Registration' }: { subtitle?: string }) {
  return (
    <div className="public-brand">
      <img className="public-mark" src="/images/sunburst-logo.png" alt="" aria-hidden="true"
           width={52} height={46} />
      <span className="public-brand-text">
        <b>Project Enlightenment</b>
        <small>{subtitle}</small>
      </span>
    </div>
  );
}
```

It is a static asset served from `apps/web/public/images/`, not from the database. Nothing
about the form reaches it, so every form looks identical today.

---

## 3. Schema (migration 032)

```sql
-- Widen the kind check to admit the new kind.
ALTER TABLE core.CertificateAsset DROP CONSTRAINT CK_CertificateAsset_Kind;
ALTER TABLE core.CertificateAsset ADD CONSTRAINT CK_CertificateAsset_Kind
    CHECK (AssetKind IN ('template-logo', 'participant-image', 'form-header'));

-- One optional header per form, plus the alt text it must carry.
ALTER TABLE core.FormTemplate ADD HeaderAssetID INT NULL
    CONSTRAINT FK_FormTemplate_HeaderAsset
    REFERENCES core.CertificateAsset(CertificateAssetID);
ALTER TABLE core.FormTemplate ADD HeaderAltText NVARCHAR(200) NULL;
```

Notes:

- **Additive only.** A nullable column and a widened CHECK. The previously deployed code keeps
  working against the new schema during the gap between migration and deploy.
- **Alt text is required alongside the image**, mirroring `CK_CertificateOverride_Image` from
  migration 003. A public banner with no alt text is the same accessibility defect.
- Guarded and re-runnable, like every migration in `db/migrations`.
- Apply to **both** databases: `apply-migration.ps1 -Env test`, then `-Env prod`.

---

## 4. API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/forms/:id/header` | admin / manager | Upload or replace the header. Reuses `decodeImage` + `storeAsset`. |
| `DELETE /api/forms/:id/header` | admin / manager | Revert to the default lockup. |
| `GET /api/public/forms/:id/header` | **none** | The image bytes, for the public page. |

### 4.1 The public GET needs care

This is the only new unauthenticated route, so it is the one worth getting right.

1. **Only serve when a live link uses that form.** Otherwise the endpoint is an open image host
   enumerable by form id. Resolve it the way `resolveSlug` does — join through
   `core.WorkshopRegistrationLink` and require the link to be active and not revoked.
2. **`Cache-Control: public, max-age=3600`.** Bytes are immutable per asset id, so a long cache
   is safe and keeps the public page fast.
3. **Exclude SVG.** An SVG served from your own origin can carry script. That is tolerable for
   authenticated staff on certificates; it is not tolerable on a public page. Accept PNG, JPEG
   and WebP only.

### 4.2 Payload change

`GET /api/public/registration-links/:slug` gains one field beside `form` and `workshop`:

```json
{ "headerImageUrl": "/api/public/forms/12/header" | null }
```

Null when the form has no header, so the client falls back without a second request.

---

## 5. Public page

`PublicBrand` becomes conditional. **No image renders today's markup exactly** — same elements,
same classes — so existing links are untouched.

With an image, a single `<figure class="public-header">` replaces the brand block:

```css
.public-header { margin: -24px -24px 18px; }        /* full-bleed to the card edges */
.public-header img { display: block; width: 100%; height: auto; max-height: 260px;
                     object-fit: contain; }
```

Two deliberate choices:

- **`height: auto` with a `max-height` cap, not a fixed box.** The sample is about 4:1, but the
  aspect ratio is the staff member's, not ours. A fixed box with `object-fit: cover` would crop
  a differently-shaped upload — potentially cutting off the logo. Letting the image set its own
  height means a tall upload shrinks rather than loses content.
- **`object-fit: contain`**, so the whole banner is always visible even when the cap bites.

On a phone the card padding drops to 16px, so the negative margin needs a matching override in
the existing `@media (max-width: 640px)` block.

### 5.1 Accessibility

The sample's "Training Requests" heading is inside the pixels, so a screen reader gets nothing
from it. Two mitigations:

- The alt text is **required** on upload.
- The card's own `<h1>` already carries the form title. Staff should keep it meaningful rather
  than relying on the banner to say what the form is.

---

## 6. Admin UI

A **Header image** panel in the form editor (`FormEditorPage.tsx`): current preview, Upload,
Remove, and the alt-text field. Reuse the certificate designer's upload control so the two
behave identically — same size limit, same error messages.

---

## 7. Open decision — template or version?

| | Template-level (recommended) | Version-level |
| --- | --- | --- |
| Survives a new version | Yes | No — re-upload on every edit |
| A published version keeps its banner | No — banner changes for everyone | Yes |
| Schema | `FormTemplate.HeaderAssetID` | `FormTemplateVersion.HeaderAssetID` |

**Recommendation: template-level.** A banner is branding, not content. Pinning it per version
would mean re-uploading it every time someone fixes a typo in a question — and a form that
silently lost its banner on publish would look broken.

---

## 8. Tests (header image)

| Test | Asserts |
| --- | --- |
| Upload with no header | Public payload has `headerImageUrl: null`; page renders the original lockup |
| Upload PNG | Public GET returns 200, `image/png`, correct bytes |
| Upload SVG | Rejected with 422 |
| Upload over 2 MB | Rejected with 422 |
| Public GET, form with no live link | 404 — the endpoint is not an open image host |
| Public GET, link revoked | 404 |
| Delete header | Falls back to the lockup; asset row is left for any other form using it |

---

## 9. Out of scope

- Multiple images per form, galleries, or carousels.
- Cropping or resizing in the browser. Staff supply the image at the size they want; the CSS
  caps it.
- Per-workshop (rather than per-form) banners.
- Moving the existing static `sunburst-logo.png` into the database. It stays a static asset;
  only an *override* is stored.

---

## 10. Preview the public page from the form editor

**From:** the only way to see a form as the public sees it is to open its live link — which
shows the *published* version, needs the link to exist and be open, and cannot show a draft.
**To:** a **Preview** button in the form editor opens the real public page, read-only, for the
version being edited.

### 10.1 Decision — a real page, not a mock

The preview renders the **same `PublicRegisterPage`** the public uses, in a new tab. A separate
preview component would drift: the first time a question type is restyled, the preview would
lie. Rendering the real page means the preview is correct by construction — including the
header image from §5, the page steps, branching, and the built-in name/agency block.

The trade-off is that the page must be told *not to submit* and *not to trust the link state*.
Both are handled below.

### 10.2 Route

| | |
| --- | --- |
| URL | `/admin/forms/:id/preview` (`?version=<id>` optional) |
| Auth | `requireAuth` + `requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER')` — the same `EDIT_ROLES` as the editor |
| Version | `?version=` when the editor is showing an older version; otherwise the newest version, **published or draft** |
| Data | The same shape `GET /api/public/registration-links/:slug` returns, so one client type serves both |

`/admin/forms/:id/preview` is a staff route with its own branch in `main.tsx`, placed beside
the editor route. The public `/register/:slug` check is unaffected — different prefix — and the
`formEditorMatch` regex only matches digits, so it cannot swallow the new path.

The preview is a staff route, but it does **not** render inside the staff app shell — it renders
the public page, full screen, with a slim preview bar on top:

```
┌──────────────────────────────────────────────────────────────┐
│ Preview · v4 (draft) · not the live form   [Back to editor]  │
├──────────────────────────────────────────────────────────────┤
│                  (the public page, unchanged)                │
└──────────────────────────────────────────────────────────────┘
```

The bar is `position: sticky; top: 0` and uses the staff app's colours, so nobody mistakes a
preview for the live page. It is not part of `PublicChrome` — it wraps it.

### 10.3 API

One new authenticated endpoint, in `routes/forms.ts` beside the other version routes:

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/forms/:id/preview` | admin / manager | The public page's payload for a version |

- `?version=<id>` selects the version; omit for the newest. A version belonging to a *different*
  template is a 404, not a fallback — otherwise a crafted id previews someone else's draft.
- The payload is the `PublicLinkState` shape with:
  - `state: 'open'` — always. A preview must show the form, not "Registration is closed"; the
    preview bar says it is not live.
  - `seatsRemaining: null` — a preview is not a roster.
  - `form` — the chosen version, **published or not**.
  - `workshop` — all nulls for a standalone form (a training request has no workshop).
- `headerImageUrl` follows §4.2. Because the preview is authenticated, it may point at the
  authenticated `GET /api/forms/:id/header` instead of the public one — see §10.4.

### 10.4 Header image in preview

The public GET in §4.1 only serves a form that has a live link. A draft being previewed has no
live link, so the public route would 404 and the banner would silently vanish from the preview —
exactly the bug the preview exists to catch.

So add a **second, authenticated** GET:

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/forms/:id/header` | any signed-in staff role | The image bytes, for the preview |

It is the same handler as the public route with the live-link check dropped, because the caller
is already authenticated. The preview payload's `headerImageUrl` points here; the public
payload's points at `/api/public/forms/:id/header`.

### 10.5 Client

`PublicRegisterPage` gains one prop:

```tsx
export function PublicRegisterPage({ slug, preview }: { slug?: string; preview?: PreviewData })
```

- `preview` set → the query is skipped and `preview` is used as `data`. `slug` is unused.
- The preview bar lives in a small `FormPreviewPage` wrapper that fetches
  `GET /api/forms/:id/preview` and renders `<FormPreviewBar />` above
  `<PublicRegisterPage preview={…} />`. Nothing about the public page's own markup changes.
- `readOnly` (derived from `preview`) → both submit handlers return early, and the final
  submit button renders as `disabled` with `title="Preview only — nothing is submitted"`.
  **Next stays enabled** — paging through a multi-page form is part of what staff are checking.
  The honeypot field is not rendered.
- **All the interactive parts stay live**: typing, choosing a role, the agency picker, page
  steps, and branching. Staff need to *drive* the form to see the conditional questions, so
  only the final submit is inert. The agency picker's lookup is the public one, which needs no
  session.
- The preview bar renders above `<PublicChrome>`, so the document title and layout of the real
  page are unchanged.

### 10.6 Entry point

A **Preview** button in the form editor's header (`FormTemplateEditor.tsx`), beside Save draft
and Publish, for every role that can open the editor:

```tsx
<a
  className="btn btn-ghost"
  href={`/admin/forms/${formTemplateId}/preview${
    currentVersionId !== null ? `?version=${currentVersionId}` : ''
  }`}
  target="_blank"
  rel="noopener"
>
  Preview
</a>
```

- **A new tab**, so the editor keeps its unsaved state. A same-tab navigation would discard
  edits and lose the staff member's place.
- **It previews what the editor is showing** — the newest version, or the older one selected
  from the version list — so "what I see is what I preview" holds.
- **Unsaved edits are not previewed.** The preview reads the saved version; the editor header
  already says "Unsaved changes". Saving a draft first is one click and keeps the two in step.
  (Previewing unsaved state would mean posting the whole draft to a render endpoint — a much
  larger change for little gain; noted in §10.8.)
- Also offered from the forms list (`FormsPage.tsx`) as a row action, since that is where staff
  start.

### 10.7 Accessibility and safety

- The preview bar is the first focusable element and reads "Preview — this is not the live
  form" to a screen reader, so a keyboard user is never confused about which page they are on.
  The wrapper also sets the tab title to `Preview · <form name>`, so a preview tab is
  identifiable in a crowded tab strip.
- `Cache-Control: no-store` on `/api/forms/:id/preview` and the authenticated header GET — a
  draft is not cacheable content.
- The authenticated header GET is rate-limited like the public one, so a signed-in account
  cannot use it to pull images in a loop.
- The preview never writes: no `core.PublicSubmission` audit row, no rate-limit bucket
  consumed, no participant created.

### 10.8 Out of scope for the preview

- Previewing **unsaved** editor state (see §10.6).
- A side-by-side editor/preview split pane. A new tab is simpler, survives a refresh, and
  works on a phone.
- Previewing a *workshop* registration form's public page from the workshop drawer. That page
  needs a workshop, not just a version; it can reuse this endpoint later by passing a
  `workshopId`, but it is not part of this change.
- A **preview link** on the public link panel (`FormLinkPanel.tsx`). That panel already shows
  the live URL and Copy; the editor's Preview button covers the "show me the page" need without
  a second way to reach the same screen.
- Shareable preview links for people without a staff account.

---

## 11. Tests (preview)

| Test | Asserts |
| --- | --- |
| Preview a draft | 200; payload `form` is the draft version; `state` is `open` |
| Preview with `?version=` of another template | 404 |
| Preview as a viewer | 403 |
| Authenticated header GET, form with no live link | 200 with the image — the draft preview shows its banner |
| Public header GET, same form | 404 — the public route stays gated |
| Preview page | Submit is disabled; Next, typing and branching still work |
| Preview page | No `POST` is issued when the disabled submit is clicked |

