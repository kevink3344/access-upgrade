-- =====================================================================
--  027 - Notification switches
--
--  The Notifications settings screen now has an on/off toggle per
--  notification type and per delivery channel. Those switches have to be
--  remembered somewhere, and they are a workspace-wide decision rather than
--  a per-user preference: turning off "School Cash matching completed" means
--  nobody gets it, not that one administrator opts out.
--
--  One row per switch, keyed by a stable name:
--
--    kind:<notification-kind>   e.g. kind:school-cash-applied
--    channel:<channel>          e.g. channel:email
--
--  A missing row means "on". That is deliberate: a new notification type
--  added in code starts enabled without needing a matching INSERT, and a
--  failed settings read can never silently silence alerts.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF OBJECT_ID('core.NotificationSetting', 'U') IS NULL
BEGIN
    CREATE TABLE core.NotificationSetting (
        SettingKey  NVARCHAR(80)  NOT NULL CONSTRAINT PK_NotificationSetting PRIMARY KEY,
        IsEnabled   BIT           NOT NULL,
        UpdatedAt   DATETIME2(0)  NOT NULL
            CONSTRAINT DF_NotificationSetting_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBy   NVARCHAR(200) NULL
    );
    PRINT 'core.NotificationSetting created';
END
ELSE
BEGIN
    PRINT 'core.NotificationSetting already exists';
END
GO
