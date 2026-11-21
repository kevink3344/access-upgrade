# Notifications

In-app alerts for staff. A bell in the topbar shows an unread count; the
`/notifications` page is the full history with filtering and archiving.

## Data model

Two tables, both added in migration `005`:

| Table | Purpose |
| --- | --- |
| `core.Notification` | The event itself: `Kind`, `Title`, `Body`, `LinkPath`, `WorkshopID`, `CreatedAt`. One row per event, shared by all recipients. |
| `core.NotificationRecipient` | Per-user state: `ReadAt`, `DismissedAt`. One row per recipient. |

Read and archive state is **per user**. One admin reading a capacity alert does
not clear it for the other admins — each person works through their own list.

`DismissedAt` is the archive flag. It is reused rather than adding a column:
archiving is exactly "hide this from my list but keep it", which is what the
column already meant.

## Views

`GET /api/notifications?view=` takes three values:

| View | Filter | Shown in |
| --- | --- | --- |
| `all` (default) | `DismissedAt IS NULL` | All tab, bell popover |
| `unread` | `DismissedAt IS NULL AND ReadAt IS NULL` | Unread tab |
| `archived` | `DismissedAt IS NOT NULL` | Archive tab |

The response carries `total` (rows in this view, for paging), `unread` (for the
badge) and `archived` (for the tab count) so the page needs one request.

Archiving also sets `ReadAt` — an archived row must never keep the badge lit.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/notifications` | List, with `limit`, `offset`, `view` |
| `POST` | `/api/notifications/read-all` | Mark every visible row read |
| `POST` | `/api/notifications/archive-all` | Archive every non-archived row |
| `POST` | `/api/notifications/{id}/read` | Mark one read |
| `POST` | `/api/notifications/{id}/archive` | Archive one |
| `POST` | `/api/notifications/{id}/unarchive` | Restore one |

The two `-all` routes are declared **before** `/:id/...` so Express does not
match them as an `id`.

## Capacity alerts

`checkWorkshopCapacity(workshopId)` in `apps/api/src/services/notifications.ts`
runs after any registration change — manual or public — and fires once per
threshold crossing:

- Threshold lives on `core.Workshop.NotifyPercentFull` (default 80, `NULL` = off).
- `NotifyFiredAt` records that the alert fired. Without it a 40-seat workshop
  would alert on every registration past 80%.
- When the count drops back below the threshold (a cancellation), `NotifyFiredAt`
  is cleared so a later refill can alert again.

Recipients are active `SUPER_ADMIN` and `ADMIN` users only.

Staff set the threshold on a workshop's **Notifications** tab.

## Not yet wired

- **Email.** `createNotification` is the single choke point; hooking email in
  there will not require changing any call site. Blocked on Microsoft Graph
  credentials — see [email-setup.md](./email-setup.md).
- **Webhooks.** Nothing calls `core.Webhook` automatically yet.
