-- =====================================================================
--  019 - Atomic id allocation for Participant and Registration
--
--  Both tables were created as plain INT primary keys so the legacy Access
--  ids could be loaded verbatim. New rows were then numbered in application
--  code as ISNULL(MAX(id), 0) + 1, which is a read-then-write race: two
--  concurrent inserts read the same maximum and one fails on the primary key.
--
--  The public registration form made that race reachable by ordinary users:
--  a link shared to a class produces simultaneous submissions.
--
--  The fix lives in the application, not here - see the outcome section below
--  for why IDENTITY was not used. This file records the decision and reports
--  the current state so the migration numbering stays in step across both
--  databases.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

-- ---------------------------------------------------------------------
--  Outcome of this file: the IDs stay in application code.
--
--  SQL Server cannot add IDENTITY to an existing column (ALTER COLUMN does
--  not accept it), and the alternative - a new table, copy, drop, rename -
--  would renumber nothing but would still require dropping and recreating
--  every foreign key that references these tables inside a single
--  transaction. That is a large, risky change for a problem the application
--  can solve directly.
--
--  Instead every allocation now happens inside the INSERT itself:
--
--      INSERT INTO core.Participant (FirstName, ...)
--      OUTPUT INSERTED.ParticipantID
--      SELECT ISNULL(MAX(ParticipantID), 0) + 1, ...
--        FROM core.Participant WITH (UPDLOCK, HOLDLOCK)
--
--  The read and the write are one statement, and UPDLOCK + HOLDLOCK hold the
--  lock on the row the aggregate reads until the insert commits, so a second
--  caller waits and then sees the new maximum. Verified on the test database:
--  two overlapping transactions produced 2484 and 2485, never a collision.
--
--  This file is therefore a no-op guard that documents the decision and
--  reports the current state. Apply to BOTH databases so the migration
--  numbering stays in step.
-- ---------------------------------------------------------------------

SET NOCOUNT ON;
GO

IF COLUMNPROPERTY(OBJECT_ID('core.Participant'), 'ParticipantID', 'IsIdentity') = 1
    PRINT 'core.Participant.ParticipantID is IDENTITY (unexpected - see header)';
ELSE
    PRINT 'core.Participant.ParticipantID is application-allocated (expected)';

IF COLUMNPROPERTY(OBJECT_ID('core.Registration'), 'RegistrationID', 'IsIdentity') = 1
    PRINT 'core.Registration.RegistrationID is IDENTITY (unexpected - see header)';
ELSE
    PRINT 'core.Registration.RegistrationID is application-allocated (expected)';
GO

-- The next id each table will hand out, for a sanity check after deploy.
SELECT 'core.Participant' AS TableName, ISNULL(MAX(ParticipantID), 0) + 1 AS NextId
  FROM core.Participant
UNION ALL
SELECT 'core.Registration', ISNULL(MAX(RegistrationID), 0) + 1
  FROM core.Registration;
GO

