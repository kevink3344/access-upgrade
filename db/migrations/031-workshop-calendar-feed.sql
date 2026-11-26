-- =====================================================================
--  031 - Workshop calendar feed (ICS)
--
--  Staff want the workshops calendar in Google Calendar (or Outlook)
--  rather than only in this app. The feed is a read-only iCalendar
--  document the app publishes at /api/calendar/workshops.ics; a calendar
--  app subscribes to that URL and refreshes it on its own schedule.
--
--  Google's fetcher cannot send a bearer token, so the URL itself carries
--  the authority: one long-lived, random token shared by the workspace.
--  Only a SHA-256 hash of it is stored, so a database read cannot be
--  replayed against the endpoint, and the plaintext is shown once, when
--  the feed is switched on or its link is regenerated.
--
--  The switch lives in core.NotificationSetting alongside the other
--  workspace-wide on/off settings. A missing row means OFF here, which is
--  the opposite of the notification default: a public feed must never
--  appear because a row failed to be written.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

-- sqlcmd does not set this by default, and a filtered index requires it.
SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('core.NotificationSetting', 'SecretHash') IS NULL
    ALTER TABLE core.NotificationSetting ADD SecretHash CHAR(64) NULL;
ELSE
    PRINT 'core.NotificationSetting.SecretHash already exists';
GO

-- The feed is looked up by hash on every request, so it needs its own index
-- rather than a scan of the settings table.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_NotificationSetting_SecretHash'
       AND object_id = OBJECT_ID('core.NotificationSetting')
)
    CREATE INDEX IX_NotificationSetting_SecretHash
        ON core.NotificationSetting(SecretHash)
        WHERE SecretHash IS NOT NULL;
GO
