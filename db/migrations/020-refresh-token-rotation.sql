-- =====================================================================
--  020 - Refresh token rotation
--
--  Login already issued a refresh token into an httpOnly cookie, but nothing
--  ever consumed it: there was no /api/auth/refresh endpoint, so an expired
--  access token dropped the user at the login screen mid-task.
--
--  Rotation needs one extra column. When a refresh token is exchanged it is
--  revoked and a new one is issued; ReplacedByHash records which token
--  replaced it. That makes a chain per session, so presenting an already-used
--  token can be traced forward and the whole chain revoked - the standard
--  reuse-detection response to a stolen token.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
-- Filtered indexes require these; sqlcmd defaults QUOTED_IDENTIFIER off.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;
GO

IF COL_LENGTH('core.RefreshToken', 'ReplacedByHash') IS NULL
BEGIN
    ALTER TABLE core.RefreshToken ADD ReplacedByHash VARBINARY(32) NULL;
    PRINT 'core.RefreshToken.ReplacedByHash added';
END
ELSE
    PRINT 'core.RefreshToken.ReplacedByHash already exists';
GO

-- Finding the live tokens for a user is the hot path on every refresh.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RefreshToken_Live' AND object_id = OBJECT_ID('core.RefreshToken'))
BEGIN
    CREATE INDEX IX_RefreshToken_Live
        ON core.RefreshToken (UserID, ExpiresAt)
        INCLUDE (RevokedAt)
        WHERE RevokedAt IS NULL;
    PRINT 'IX_RefreshToken_Live created';
END
ELSE
    PRINT 'IX_RefreshToken_Live already exists';
GO
