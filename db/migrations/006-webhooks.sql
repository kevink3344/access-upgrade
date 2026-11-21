-- =====================================================================
--  006 - Webhooks
--
--  A staff-managed registry of outbound webhooks. Each row is one
--  endpoint with its own title, description, URL, payload schema and
--  active flag.
--
--  The JSON Schema is stored as text and validated on save. It describes
--  the payload the app will POST, so the schema and the sender cannot
--  drift apart silently.
--
--  core.WebhookDelivery records every attempt, so a failing endpoint is
--  visible rather than silently dropping events.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF OBJECT_ID('core.Webhook', 'U') IS NULL
BEGIN
    CREATE TABLE core.Webhook (
        WebhookID    INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_Webhook PRIMARY KEY,
        Title        NVARCHAR(200)  NOT NULL,
        Description  NVARCHAR(1000) NULL,
        Url          NVARCHAR(2000) NOT NULL,
        -- JSON Schema (draft 2020-12) describing the POST body.
        JsonSchema   NVARCHAR(MAX)  NULL,
        IsActive     BIT            NOT NULL
            CONSTRAINT DF_Webhook_IsActive DEFAULT 1,
        -- Optional shared secret, sent as X-Webhook-Secret so the receiver
        -- can verify the call came from us.
        Secret       NVARCHAR(200)  NULL,
        CreatedBy    NVARCHAR(200)  NULL,
        CreatedAt    DATETIME2(0)   NOT NULL
            CONSTRAINT DF_Webhook_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBy    NVARCHAR(200)  NULL,
        UpdatedAt    DATETIME2(0)   NOT NULL
            CONSTRAINT DF_Webhook_UpdatedAt DEFAULT SYSUTCDATETIME()
    );
    PRINT 'Created core.Webhook';
END
ELSE PRINT 'core.Webhook already exists';
GO

IF OBJECT_ID('core.WebhookDelivery', 'U') IS NULL
BEGIN
    CREATE TABLE core.WebhookDelivery (
        WebhookDeliveryID INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_WebhookDelivery PRIMARY KEY,
        WebhookID     INT           NOT NULL
            CONSTRAINT FK_WebhookDelivery_Webhook
            REFERENCES core.Webhook (WebhookID) ON DELETE CASCADE,
        -- What triggered it, e.g. 'test' or 'workshop-capacity'.
        EventKind     NVARCHAR(40)  NOT NULL,
        Payload       NVARCHAR(MAX) NULL,
        StatusCode    INT           NULL,
        Succeeded     BIT           NOT NULL,
        Error         NVARCHAR(1000) NULL,
        DurationMs    INT           NULL,
        AttemptedAt   DATETIME2(0)  NOT NULL
            CONSTRAINT DF_WebhookDelivery_AttemptedAt DEFAULT SYSUTCDATETIME()
    );
    CREATE INDEX IX_WebhookDelivery_Webhook
        ON core.WebhookDelivery (WebhookID, AttemptedAt DESC);
    PRINT 'Created core.WebhookDelivery';
END
ELSE PRINT 'core.WebhookDelivery already exists';
GO

-- Payload format. Slack incoming webhooks reject arbitrary JSON: they need a
-- top-level `text` or `blocks` field, so the schema cannot describe them.
IF COL_LENGTH('core.Webhook', 'PayloadFormat') IS NULL
BEGIN
    ALTER TABLE core.Webhook
        ADD PayloadFormat NVARCHAR(20) NOT NULL
            CONSTRAINT DF_Webhook_PayloadFormat DEFAULT 'json';
    PRINT 'Added core.Webhook.PayloadFormat';
END
ELSE PRINT 'core.Webhook.PayloadFormat already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_Webhook_PayloadFormat'
       AND parent_object_id = OBJECT_ID('core.Webhook')
)
BEGIN
    ALTER TABLE core.Webhook
        ADD CONSTRAINT CK_Webhook_PayloadFormat
        CHECK (PayloadFormat IN ('json', 'slack'));
    PRINT 'Added CK_Webhook_PayloadFormat';
END
ELSE PRINT 'CK_Webhook_PayloadFormat already exists';
GO

SELECT
    (SELECT COUNT(*) FROM sys.tables WHERE name IN ('Webhook','WebhookDelivery')) AS TablesCreated,
    (SELECT COUNT(*) FROM sys.columns
      WHERE name = 'PayloadFormat' AND object_id = OBJECT_ID('core.Webhook')) AS PayloadFormatCol;
GO
