-- =====================================================================
--  035 - Scheduled report subscriptions
--
--  Staff open the Reports hub and run a report when they remember to.
--  A subscription stores which report, with which parameters, on which
--  weekday, and a daily poll emails it.
--
--  See docs/plans/report-subscriptions.md.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('core.ReportSubscription', 'U') IS NULL
BEGIN
    CREATE TABLE core.ReportSubscription (
        ReportSubscriptionID INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ReportSubscription PRIMARY KEY,
        UserID          INT           NOT NULL
            CONSTRAINT FK_ReportSubscription_User REFERENCES core.AppUser(UserID),
        ReportKey       NVARCHAR(60)  NOT NULL,
        -- The parameters the report was subscribed with. Date parameters are
        -- stored as tokens ("last-7-days"), not literal dates, so a weekly
        -- report does not repeat the same week forever.
        ParamsJson      NVARCHAR(MAX) NULL,
        -- 0 = Sunday .. 6 = Saturday, matching JavaScript's getDay().
        DayOfWeek       TINYINT       NOT NULL
            CONSTRAINT DF_ReportSubscription_Day DEFAULT 5
            CONSTRAINT CK_ReportSubscription_Day CHECK (DayOfWeek BETWEEN 0 AND 6),
        SendHour        TINYINT       NOT NULL
            CONSTRAINT DF_ReportSubscription_Hour DEFAULT 7
            CONSTRAINT CK_ReportSubscription_Hour CHECK (SendHour BETWEEN 0 AND 23),
        IsActive        BIT           NOT NULL
            CONSTRAINT DF_ReportSubscription_Active DEFAULT 1,
        -- The last day it actually fired: the idempotency guard, so a restart
        -- or a second instance cannot double-send.
        LastSentOn      DATE          NULL,
        -- Set when the report key disappears from the registry, so the owner
        -- is told rather than silently skipped.
        DisabledReason  NVARCHAR(300) NULL,
        CreatedAt       DATETIME2(0)  NOT NULL
            CONSTRAINT DF_ReportSubscription_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBy       NVARCHAR(200) NULL
    );
    PRINT 'core.ReportSubscription created';
END
ELSE
    PRINT 'core.ReportSubscription already exists';
GO

-- One row per (user, report, parameters). A UNIQUE constraint cannot include
-- NVARCHAR(MAX), so the guard is a filtered-free unique index over a hash of
-- the parameters instead: two identical subscriptions collide, two different
-- filters do not.
IF COL_LENGTH('core.ReportSubscription', 'ParamsHash') IS NULL
    ALTER TABLE core.ReportSubscription ADD ParamsHash AS
        CONVERT(CHAR(64), HASHBYTES('SHA2_256', ISNULL(ParamsJson, '')), 2) PERSISTED;
ELSE
    PRINT 'core.ReportSubscription.ParamsHash already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'UQ_ReportSubscription' AND object_id = OBJECT_ID('core.ReportSubscription')
)
    CREATE UNIQUE INDEX UQ_ReportSubscription
        ON core.ReportSubscription (UserID, ReportKey, ParamsHash);
ELSE
    PRINT 'UQ_ReportSubscription already exists';
GO

-- Delivery history. Worth recording from the first cut: backfilling it later
-- is impossible, and it is what makes a failed send visible in the UI.
IF OBJECT_ID('core.ReportSubscriptionSend', 'U') IS NULL
BEGIN
    CREATE TABLE core.ReportSubscriptionSend (
        ReportSubscriptionSendID INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ReportSubscriptionSend PRIMARY KEY,
        ReportSubscriptionID INT      NOT NULL
            CONSTRAINT FK_ReportSubscriptionSend_Subscription
            FOREIGN KEY REFERENCES core.ReportSubscription(ReportSubscriptionID) ON DELETE CASCADE,
        SentAt          DATETIME2(0)  NOT NULL
            CONSTRAINT DF_ReportSubscriptionSend_SentAt DEFAULT SYSUTCDATETIME(),
        -- Not `RowCount`: that is a reserved word in T-SQL.
        RowsInReport    INT           NULL,
        Succeeded       BIT           NOT NULL,
        Error           NVARCHAR(1000) NULL
    );
    CREATE INDEX IX_ReportSubscriptionSend_Subscription
        ON core.ReportSubscriptionSend (ReportSubscriptionID, SentAt DESC);
    PRINT 'core.ReportSubscriptionSend created';
END
ELSE
    PRINT 'core.ReportSubscriptionSend already exists';
GO
