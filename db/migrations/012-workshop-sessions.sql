-- =====================================================================
--  012 - Workshop sessions: time window and capacity per session
--
--  A workshop can have several sessions on the same day (e.g. 10-11,
--  11-12, 12-1), each with its own time window and its own seat count.
--  core.WorkshopSession already exists and already carries the presenter
--  and the attendance rows, so this extends it rather than introducing a
--  second session concept.
--
--  Sessions are DESCRIPTIVE: staff record the times and seat counts, but
--  registrants still register for the workshop. Nothing here changes
--  core.Registration, the public link, or the capacity alert. See
--  docs/plans/workshop-sessions.md.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF COL_LENGTH('core.WorkshopSession', 'StartTime') IS NULL
    ALTER TABLE core.WorkshopSession ADD StartTime TIME(0) NULL;
ELSE
    PRINT 'core.WorkshopSession.StartTime already exists';

IF COL_LENGTH('core.WorkshopSession', 'EndTime') IS NULL
    ALTER TABLE core.WorkshopSession ADD EndTime TIME(0) NULL;
ELSE
    PRINT 'core.WorkshopSession.EndTime already exists';

-- NULL means "inherit core.Workshop.MaxEnrollment", so every legacy row
-- keeps behaving exactly as it does today.
IF COL_LENGTH('core.WorkshopSession', 'MaxEnrollment') IS NULL
    ALTER TABLE core.WorkshopSession ADD MaxEnrollment INT NULL;
ELSE
    PRINT 'core.WorkshopSession.MaxEnrollment already exists';

IF COL_LENGTH('core.WorkshopSession', 'MinEnrollment') IS NULL
    ALTER TABLE core.WorkshopSession ADD MinEnrollment INT NULL;
ELSE
    PRINT 'core.WorkshopSession.MinEnrollment already exists';

IF COL_LENGTH('core.WorkshopSession', 'Notes') IS NULL
    ALTER TABLE core.WorkshopSession ADD Notes NVARCHAR(400) NULL;
ELSE
    PRINT 'core.WorkshopSession.Notes already exists';
GO

-- Supports the Sessions tab's ordering and the "incomplete rows first" sort.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_WorkshopSession_Workshop_Date'
       AND object_id = OBJECT_ID('core.WorkshopSession')
)
    CREATE INDEX IX_WorkshopSession_Workshop_Date
        ON core.WorkshopSession(WorkshopID, SessionDate, StartTime);
GO

-- Workshop-level registration count alongside each session. There is no
-- per-session roster (sessions are descriptive), so this deliberately
-- reports the workshop's number rather than implying an assignment.
IF OBJECT_ID('core.vw_WorkshopSessionCounts', 'V') IS NULL
    EXEC('
CREATE VIEW core.vw_WorkshopSessionCounts AS
SELECT s.WorkshopSessionID,
       s.WorkshopID,
       (SELECT COUNT(*) FROM core.Registration r
         WHERE r.WorkshopID = s.WorkshopID AND r.IsCancelled = 0) AS WorkshopRegistered
  FROM core.WorkshopSession s;');
ELSE
    PRINT 'core.vw_WorkshopSessionCounts already exists';
GO
