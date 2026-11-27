-- =====================================================================
--  036 - Login screen theme
--
--  The login screen's left-hand panel was a fixed WCPSS blue. Admins can
--  now pick a different look in Settings > Administration; the choice is
--  workspace-wide and applies to everyone, including people who have not
--  signed in.
--
--  Stored in core.NotificationSetting beside the other workspace settings,
--  so no new table is needed. `SettingValue` holds the theme name; the
--  switch column is unused for this key but is NOT NULL, so it is written
--  as 1.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('core.NotificationSetting', 'SettingValue') IS NULL
    ALTER TABLE core.NotificationSetting ADD SettingValue NVARCHAR(200) NULL;
ELSE
    PRINT 'core.NotificationSetting.SettingValue already exists';
GO
