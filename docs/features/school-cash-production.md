# School Cash matching — production readiness

The School Cash Online upload is live in production. This page records what had to be true
for it to work, and what staff should expect.

Design and matching rules: [school-cash-matching.md](../plans/school-cash-matching.md).
The automated SFTP pipeline is a separate, later step — see
[schoolcash-integration.md](../plans/schoolcash-integration.md).

---

## 1. Where the tables live

Staging data is in **`core`**, not `staging`:

| Table | Purpose |
| --- | --- |
| `core.ScoImport` | One row per uploaded file |
| `core.ScoRow` | One row per CSV line, with the match decision |
| `core.ScoItem` | One row per distinct item name, resolved to a workshop |

This is deliberate. The application login has `ALTER` on `core` but **no rights at all on
`staging` in production** — it cannot create tables there. Putting the tables in `core` let
the feature ship without waiting on a database administrator. Migration `016` records the
reasoning.

> Two orphan tables, `staging.ScoImport` and `staging.ScoRow`, were left over from early
> development and existed only in the test database. Migration `021` drops them. Do not
> recreate them — nothing reads them.

## 2. Schema prerequisites

All present in both databases as of migration `021`:

| Object | Origin |
| --- | --- |
| `core.ScoImport`, `core.ScoRow`, `core.ScoItem` | 016 |
| `core.ScoRow.RowIdentity`, `ScoItemID` | 016 |
| `core.ScoImport.WorkshopsResolvedAt` | 017 |
| `core.Payment.Source`, `ExternalReceipt`, `ExternalPaymentId`, `FeeAmount` | 016 |
| `UX_Payment_External` (unique, filtered) | 016 |

`compare-schema.ps1` reports `NO DRIFT` across all 943 objects.

## 3. The payment method is created on first apply

The upload does **not** create a payment method. `ref.PaymentMethod` has no
"School Cash Online" row until the first import is applied, at which point
`schoolCashMethodId()` inserts it.

That means an upload can be staged and reviewed before the method exists — resolving
workshops and matching rows does not touch `ref.PaymentMethod`. If the first apply fails with
a permission error on `ref`, that is the cause.

## 4. Applying is the only step that writes money

| Step | Writes to |
| --- | --- |
| Upload | `core.ScoImport`, `core.ScoRow`, `core.ScoItem` |
| Resolve an item | `core.ScoItem` |
| Match a row | `core.ScoRow` |
| **Apply** | `core.Payment`, `core.Registration`, and possibly `core.Participant` |

Everything before Apply is reversible. Apply is not — it creates payments, and
`UX_Payment_External` makes re-applying the same file a no-op rather than a duplicate.

## 5. Discard deletes the upload

`POST /api/school-cash/imports/:id/discard` **deletes** the import and its staged rows. It is
not a soft "mark as discarded" — the `Discarded` value in the `Status` check constraint is
never used by this route.

It refuses with `409 already_applied` if any row from the upload has produced a payment, so an
applied import cannot be removed this way. The guard is the payment count, not the status.

If an audit trail of discarded uploads is wanted, this needs to change to an update rather
than a delete. Nothing currently depends on the row surviving.

## 6. Verified against production

Before hand-over, the full path was exercised against the production database using the
`test/fixtures/sco-items.csv` fixture (whose purchasers are all `@example.invalid`, so they
cannot collide with real records):

| Check | Result |
| --- | --- |
| Upload 39 rows | 201, 34 distinct items |
| Items auto-resolved to workshops | 24 of 34 |
| Rows staged for review | 39 |
| Workshop picker | 2,585 workshops returned |
| Discard | 204, import and rows removed |
| Payments afterwards | 6,034 — unchanged |
| Test participants created | 0 |

The import was discarded afterwards, so production holds no School Cash data.

## 7. Known gap

Matching is driven by **purchaser email**, which the plan (§4) describes as a materially
weaker key than a student identifier — the export carries no usable student id. Rows that do
not match land in review rather than being guessed at, which is the intended behaviour, but
expect a meaningful review queue on real files.
