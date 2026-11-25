# Id allocation on legacy-keyed tables

Most tables in `core` use `IDENTITY` and the database hands out ids. A handful do not, because
the Access migration preserved the legacy primary keys verbatim:

| Table | Id column |
| --- | --- |
| `core.Participant` | `ParticipantID` |
| `core.Registration` | `RegistrationID` |
| `core.Workshop` | `WorkshopID` |
| `core.WorkshopName` | `WorkshopNameID` |
| `core.WorkshopSession` | `WorkshopSessionID` |
| `core.WorkshopPresenter` | `WorkshopPresenterID` |
| `core.Agency` | `AgencyID` |
| `core.PresenterStaff` | `PresenterStaffID` |
| `core.CreditSlip` | `CreditSlipID` |
| `core.TrainingRequest` | `TrainingRequestID` |
| `core.TrainingRequestContact` | `TrainingRequestContactID` |
| `core.Payment` | `PaymentID` |
| `ref.PaymentMethod` | `PaymentMethodID` |
| `core.FormTemplate` and friends | `FormTemplateID`, … |

## The rule

**Allocate the id inside the INSERT. Never `SELECT MAX(...) + 1` and then insert.**

```sql
INSERT INTO core.Agency (AgencyID, AgencyName, CreatedAt)
OUTPUT INSERTED.AgencyID
SELECT ISNULL(MAX(AgencyID), 0) + 1, @name, SYSUTCDATETIME()
  FROM core.Agency WITH (UPDLOCK, HOLDLOCK)
```

The read and the write are one statement. `UPDLOCK` takes the update lock on the row the
aggregate reads; `HOLDLOCK` holds it until the insert commits. A second caller waits, then
sees the new maximum.

Verified against the test database: two overlapping transactions produced `2484` and `2485`.
The racy form produced a primary-key violation (`500`) under the same test —
[`apps/api/test/concurrent-ids.test.ts`](../../apps/api/test/concurrent-ids.test.ts) asserts it.

## Why not `IDENTITY`?

SQL Server cannot add `IDENTITY` to an existing column — `ALTER COLUMN` rejects the keyword.
The alternatives are a table rebuild (new table, copy, drop, rename, recreate every foreign
key) or leaving the keys alone. The rebuild would have to drop and restore the FKs of
`Registration`, `SessionParticipant`, `CreditSlip` and the rest inside one transaction, for a
problem the application solves in one line. See
[migration 019](../migrations/019-atomic-id-allocation.sql) for the recorded decision.

New tables should use `IDENTITY`. This page only applies to the legacy-keyed set above.

## Multi-row inserts

For a batch that needs several ids, do not read a maximum once and increment in a loop. Either
insert row by row with the pattern above, or wrap the batch in a transaction that takes the
lock first. The School Cash apply job inserts payments one at a time for this reason.
