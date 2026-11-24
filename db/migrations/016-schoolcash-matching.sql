-- =====================================================================
--  016 - School Cash matching: staging tables and payment provenance
--
--  Admins upload the daily School Cash Online Item Order Report, review what
--  matched to registrations, resolve the rest by hand, and apply the result.
--  See docs/plans/school-cash-matching.md.
--
--  Two rules shape this schema:
--
--   - The upload is staged, never applied directly. A parse bug then costs a
--     re-run, not a corrupted payment table — the same rule the Access ETL
--     follows.
--   - Every applied row is traceable to the file it came from. The unique
--     index on the vendor's receipt/payment pair is what makes re-applying a
--     file a no-op instead of a duplicate.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

-- Filtered indexes require these settings, and sqlcmd defaults
-- QUOTED_IDENTIFIER off, so they must be set explicitly.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;
GO

-- These tables live in core, not staging, despite being staging data.
--
-- The application login has ALTER on core but no rights at all on staging in
-- production (it can read and write the existing staging tables but cannot
-- create there), and granting that needs a database administrator. core is
-- the schema the app already owns, so the tables go there rather than
-- blocking the feature on a permission change. They are still staging in
-- behaviour — nothing reads them as authoritative, and applying an import is
-- what creates payments.
GO

IF OBJECT_ID('core.ScoImport', 'U') IS NULL
BEGIN
CREATE TABLE core.ScoImport (
    ScoImportID  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ScoImport PRIMARY KEY,
    FileName     NVARCHAR(260) NOT NULL,
    -- SHA-256 of the raw file. Unique, so the same file cannot be imported
    -- twice; the second attempt is refused with the first upload's details.
    FileHash     VARBINARY(32) NOT NULL,
    TotalRows     INT           NOT NULL CONSTRAINT DF_ScoImport_TotalRows DEFAULT 0,
    MatchedCount INT           NOT NULL CONSTRAINT DF_ScoImport_Matched DEFAULT 0,
    ReviewCount  INT           NOT NULL CONSTRAINT DF_ScoImport_Review  DEFAULT 0,
    IgnoredCount INT           NOT NULL CONSTRAINT DF_ScoImport_Ignored DEFAULT 0,
    AppliedCount INT           NOT NULL CONSTRAINT DF_ScoImport_Applied DEFAULT 0,
    -- Staged | Applied | Discarded
    Status       NVARCHAR(20)  NOT NULL CONSTRAINT DF_ScoImport_Status DEFAULT 'Staged',
    UploadedBy   NVARCHAR(200) NOT NULL,
    UploadedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_ScoImport_UploadedAt DEFAULT SYSUTCDATETIME(),
    AppliedBy    NVARCHAR(200) NULL,
    AppliedAt    DATETIME2(0)  NULL,
    CONSTRAINT CK_ScoImport_Status CHECK (Status IN ('Staged','Applied','Discarded'))
);
    CREATE UNIQUE INDEX UX_ScoImport_Hash ON core.ScoImport(FileHash);
    PRINT 'Created core.ScoImport';
END
ELSE PRINT 'core.ScoImport already exists';
GO

IF OBJECT_ID('core.ScoRow', 'U') IS NULL
BEGIN
CREATE TABLE core.ScoRow (
    ScoRowID      BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ScoRow PRIMARY KEY,
    ScoImportID   INT           NOT NULL
        CONSTRAINT FK_ScoRow_Import REFERENCES core.ScoImport(ScoImportID) ON DELETE CASCADE,
    RowNumber     INT           NOT NULL,
    -- Everything is text until apply, so nothing is coerced on the way in.
    PurchaserEmail NVARCHAR(255) NULL,
    PurchaserName  NVARCHAR(255) NULL,
    RecipientName  NVARCHAR(255) NULL,
    ItemId         NVARCHAR(50)  NULL,
    ItemName       NVARCHAR(255) NULL,
    PaidAmount     NVARCHAR(50)  NULL,   -- gross charge, e.g. $312.00
    ItemBalance    NVARCHAR(50)  NULL,   -- item price, e.g. $300.00
    TransactionFee NVARCHAR(50)  NULL,   -- online fee, e.g. $12.00
    PurchasedDate  NVARCHAR(50)  NULL,
    Owing          NVARCHAR(50)  NULL,
    Refunded       NVARCHAR(50)  NULL,
    -- The whole line, so a column we did not anticipate is still recoverable.
    RawJson        NVARCHAR(MAX) NULL,
    -- What the matcher decided.
    MatchedRegistrationID INT NULL,
    -- High | Low | None | Duplicate | Ignored
    MatchConfidence NVARCHAR(10) NULL,
    -- email | email+amount | manual | duplicate | none
    MatchMethod     NVARCHAR(20) NULL,
    MatchNote       NVARCHAR(255) NULL,
    IgnoreReason    NVARCHAR(255) NULL,
    AppliedPaymentID INT NULL,
    CONSTRAINT UQ_ScoRow_Import_Row UNIQUE (ScoImportID, RowNumber)
);
    CREATE INDEX IX_ScoRow_Import ON core.ScoRow(ScoImportID, MatchConfidence);
    PRINT 'Created core.ScoRow';
END
ELSE PRINT 'core.ScoRow already exists';
GO

-- Provenance on payments. Without these a payment created here is
-- indistinguishable from one typed by hand.
IF COL_LENGTH('core.Payment', 'Source') IS NULL
    ALTER TABLE core.Payment ADD Source NVARCHAR(20) NOT NULL
        CONSTRAINT DF_Payment_Source DEFAULT 'Manual';
ELSE PRINT 'core.Payment.Source already exists';
GO

IF COL_LENGTH('core.Payment', 'ExternalReceipt') IS NULL
    ALTER TABLE core.Payment ADD ExternalReceipt NVARCHAR(100) NULL;
ELSE PRINT 'core.Payment.ExternalReceipt already exists';
GO

IF COL_LENGTH('core.Payment', 'ExternalPaymentId') IS NULL
    ALTER TABLE core.Payment ADD ExternalPaymentId NVARCHAR(100) NULL;
ELSE PRINT 'core.Payment.ExternalPaymentId already exists';
GO

-- The online transaction fee, kept apart from the item price so revenue
-- reports do not overstate income and merchant reconciliation still works.
IF COL_LENGTH('core.Payment', 'FeeAmount') IS NULL
    ALTER TABLE core.Payment ADD FeeAmount DECIMAL(19,4) NULL;
ELSE PRINT 'core.Payment.FeeAmount already exists';
GO

-- Idempotency: the same vendor row can never become two payments.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'UX_Payment_External'
       AND object_id = OBJECT_ID('core.Payment')
)
    CREATE UNIQUE INDEX UX_Payment_External
        ON core.Payment(ExternalReceipt, ExternalPaymentId)
        WHERE ExternalReceipt IS NOT NULL;
GO
