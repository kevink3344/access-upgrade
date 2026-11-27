# Per-Form Header Image — A Staff-Uploaded Banner Stored in SQL Server

**From:** Every public form shows the same Project Enlightenment lockup
**To:** A form can carry its own header image (a single combined banner made by staff), and falls back to the standard lockup when it has none
**Prepared:** 2026-11-26
**Status:** **Planned** — not implemented. Two design points settled (§1.1); one still open (§7).

**Related:** [Form designer](./form-designer.md) · [Form template](./form-template.md) · [Form types and storage](./form-types-and-storage.md) · [Public registration](../features/public-registration.md)

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

**Effort estimate: ~1 day.**

### 1.1 Decisions taken

| Question | Decision | Why |
| --- | --- | --- |
| Is the sample one image or several? | **One combined image** | Confirmed by the requester. No compositing. |
| Replace the lockup, or sit above it? | **Replace** | The image already contains the logo and the title. Showing the lockup as well would print the logo twice. |

### 1.2 Decision still open

**Does the image attach to the form template, or to each version?** See §7. This changes the
schema, so it is the one thing to settle before coding.

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

## 8. Tests

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
