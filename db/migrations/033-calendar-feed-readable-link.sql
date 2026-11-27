-- =====================================================================
--  033 - Keep the calendar feed link readable
--
--  Migration 031 stored only a SHA-256 hash of the subscription token, so
--  the URL was shown once, in the session that issued it. That turned out
--  to be the wrong trade-off for this particular secret: the link is
--  pasted into a calendar app once and then needed again whenever someone
--  sets up a second device or a colleague asks for it, and a hash cannot
--  be read back. Staff ended up issuing a new link — and breaking every
--  existing subscriber — just to see the URL again.
--
--  The token is now also stored encrypted (AES-256-GCM, keyed from
--  JWT_SECRET) so the settings screen can show the current link. The hash
--  stays and remains the only thing the public feed checks, so the
--  endpoint's behaviour does not change.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('core.NotificationSetting', 'SecretEncrypted') IS NULL
    ALTER TABLE core.NotificationSetting ADD SecretEncrypted NVARCHAR(400) NULL;
ELSE
    PRINT 'core.NotificationSetting.SecretEncrypted already exists';
GO
