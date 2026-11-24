-- =====================================================================
--  015 - AppUser: opt out of admin email notifications
--
--  Admins receive notifications two ways: the in-app bell, and an email sent
--  through a webhook. Some want the bell but not the mail, so this adds a
--  per-user switch.
--
--  Deliberately named for "admin email" generally rather than the one alert
--  that exists today: more notification types are expected, and a column
--  named after capacity alerts would need renaming for each of them.
--
--  Defaults to 1 (on) so nobody's behaviour changes until they choose to.
--  The in-app notification is unaffected either way — it is driven by the
--  workshop's own threshold, not by this column.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF COL_LENGTH('core.AppUser', 'ReceivesAdminEmail') IS NULL
    ALTER TABLE core.AppUser ADD ReceivesAdminEmail BIT NOT NULL
        CONSTRAINT DF_AppUser_ReceivesAdminEmail DEFAULT 1;
ELSE
    PRINT 'core.AppUser.ReceivesAdminEmail already exists';
GO
