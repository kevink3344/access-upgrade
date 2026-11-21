-- =====================================================================
--  005 - Notifications
--
--  Adds an in-app notification system and the per-workshop capacity
--  threshold that feeds it.
--
--    core.Notification              one row per event, shared by all
--                                   recipients
--    core.NotificationRecipient     per-user read state, so each admin's
--                                   bell is independent
--    core.Workshop.NotifyPercentFull  the threshold, NULL = off
--    core.Workshop.NotifyFiredAt      when the threshold last fired, so it
--                                   alerts once rather than on every
--                                   registration past the line
--
--  Email is not wired up yet (blocked on Microsoft Graph credentials), so
--  this is in-app only.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------
   core.Notification - the event itself
   --------------------------------------------------------------------- */
IF OBJECT_ID('core.Notification', 'U') IS NULL
BEGIN
    CREATE TABLE core.Notification (
        NotificationID  INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_Notification PRIMARY KEY,
        -- 'workshop-capacity' today; kept open for future kinds.
        Kind            NVARCHAR(40)  NOT NULL,
        Title           NVARCHAR(200) NOT NULL,
        Body            NVARCHAR(1000) NULL,
        -- Deep link the bell uses to open the thing being notified about.
        LinkPath        NVARCHAR(400) NULL,
        -- The workshop this relates to, when there is one.
        WorkshopID      INT           NULL
            CONSTRAINT FK_Notification_Workshop
            REFERENCES core.Workshop (WorkshopID),
        CreatedAt       DATETIME2(0)  NOT NULL
            CONSTRAINT DF_Notification_CreatedAt DEFAULT SYSUTCDATETIME()
    );
    PRINT 'Created core.Notification';
END
ELSE PRINT 'core.Notification already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_Notification_CreatedAt'
       AND object_id = OBJECT_ID('core.Notification')
)
BEGIN
    CREATE INDEX IX_Notification_CreatedAt
        ON core.Notification (CreatedAt DESC);
    PRINT 'Created IX_Notification_CreatedAt';
END
GO

/* ---------------------------------------------------------------------
   core.NotificationRecipient - per-user read state
   --------------------------------------------------------------------- */
IF OBJECT_ID('core.NotificationRecipient', 'U') IS NULL
BEGIN
    CREATE TABLE core.NotificationRecipient (
        NotificationRecipientID INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_NotificationRecipient PRIMARY KEY,
        NotificationID  INT           NOT NULL
            CONSTRAINT FK_NotificationRecipient_Notification
            REFERENCES core.Notification (NotificationID) ON DELETE CASCADE,
        UserID          INT           NOT NULL
            CONSTRAINT FK_NotificationRecipient_User
            REFERENCES core.AppUser (UserID),
        ReadAt          DATETIME2(0)  NULL,
        DismissedAt     DATETIME2(0)  NULL,
        CONSTRAINT UQ_NotificationRecipient UNIQUE (NotificationID, UserID)
    );
    PRINT 'Created core.NotificationRecipient';
END
ELSE PRINT 'core.NotificationRecipient already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_NotificationRecipient_User'
       AND object_id = OBJECT_ID('core.NotificationRecipient')
)
BEGIN
    CREATE INDEX IX_NotificationRecipient_User
        ON core.NotificationRecipient (UserID, ReadAt);
    PRINT 'Created IX_NotificationRecipient_User';
END
GO

/* ---------------------------------------------------------------------
   core.Workshop - capacity notification settings
   --------------------------------------------------------------------- */
IF COL_LENGTH('core.Workshop', 'NotifyPercentFull') IS NULL
BEGIN
    ALTER TABLE core.Workshop
        ADD NotifyPercentFull INT NULL
            CONSTRAINT DF_Workshop_NotifyPercentFull DEFAULT 80;
    PRINT 'Added core.Workshop.NotifyPercentFull';
END
ELSE PRINT 'core.Workshop.NotifyPercentFull already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_Workshop_NotifyPercentFull'
       AND parent_object_id = OBJECT_ID('core.Workshop')
)
BEGIN
    ALTER TABLE core.Workshop
        ADD CONSTRAINT CK_Workshop_NotifyPercentFull
        CHECK (NotifyPercentFull IS NULL OR (NotifyPercentFull >= 1 AND NotifyPercentFull <= 100));
    PRINT 'Added CK_Workshop_NotifyPercentFull';
END
ELSE PRINT 'CK_Workshop_NotifyPercentFull already exists';
GO

-- When the threshold last fired. Cleared when the workshop drops back below
-- the threshold so a later refill can alert again.
IF COL_LENGTH('core.Workshop', 'NotifyFiredAt') IS NULL
BEGIN
    ALTER TABLE core.Workshop
        ADD NotifyFiredAt DATETIME2(0) NULL;
    PRINT 'Added core.Workshop.NotifyFiredAt';
END
ELSE PRINT 'core.Workshop.NotifyFiredAt already exists';
GO

/* ---------------------------------------------------------------------
   Verify
   --------------------------------------------------------------------- */
SELECT
    (SELECT COUNT(*) FROM sys.tables
      WHERE name IN ('Notification','NotificationRecipient')) AS TablesCreated,
    (SELECT COUNT(*) FROM sys.columns
      WHERE name IN ('NotifyPercentFull','NotifyFiredAt')
        AND object_id = OBJECT_ID('core.Workshop')) AS WorkshopColumns;
GO
