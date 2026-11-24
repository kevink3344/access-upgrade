-- =====================================================================
--  017 - School Cash: resolve workshops before matching payments
--
--  Matching a payment straight to a registration was the wrong order. The
--  workshop has to be settled first: the vendor's item name and this app's
--  workshop name are different vocabularies, and guessing at the registration
--  level produced payments on the wrong workshop (and on workshops from 2011).
--
--  So an upload now has two steps:
--
--    1. Every distinct item name is resolved to a workshop — either matched
--       automatically, chosen by an admin, or created. This is a small list,
--       10-12 items in a typical file.
--    2. Only then are payments matched to registrations, and only within the
--       resolved workshop.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;
GO

-- One row per distinct item name in an upload. Resolving here rather than per
-- row means an admin answers "which workshop is this?" once, not 40 times.
IF OBJECT_ID('core.ScoItem', 'U') IS NULL
BEGIN
CREATE TABLE core.ScoItem (
    ScoItemID     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ScoItem PRIMARY KEY,
    ScoImportID   INT           NOT NULL
        CONSTRAINT FK_ScoItem_Import REFERENCES core.ScoImport(ScoImportID) ON DELETE CASCADE,
    -- The vendor's item name with the trailing session date stripped.
    ItemName      NVARCHAR(255) NOT NULL,
    -- How many rows in the file share this item. ("RowCount" is a T-SQL
    -- keyword, so the column cannot be called that.)
    TotalRows     INT           NOT NULL CONSTRAINT DF_ScoItem_Rows DEFAULT 0,
    -- The item price, for display. All rows for one item share it in practice.
    ItemBalance   NVARCHAR(50)  NULL,

    -- The workshop this item is for. NULL until resolved.
    WorkshopID    INT           NULL CONSTRAINT FK_ScoItem_Workshop REFERENCES core.Workshop(WorkshopID),
    -- Auto | Manual | Created
    ResolvedBy    NVARCHAR(20)  NULL,
    -- Candidate workshop suggested at upload, so the screen can default to it.
    SuggestedWorkshopID INT     NULL,
    -- 0..1 similarity of the suggestion, for the admin to judge.
    SuggestionScore DECIMAL(5,4) NULL,
    ResolvedAt    DATETIME2(0)  NULL,
    ResolvedByUser NVARCHAR(200) NULL,

    CONSTRAINT UQ_ScoItem_Import_Name UNIQUE (ScoImportID, ItemName)
);
    CREATE INDEX IX_ScoItem_Import ON core.ScoItem(ScoImportID);
    PRINT 'Created core.ScoItem';
END
ELSE PRINT 'core.ScoItem already exists';
GO

-- Each staged row points at its resolved item, so payment matching can read
-- the workshop without re-deriving it from the name.
IF COL_LENGTH('core.ScoRow', 'ScoItemID') IS NULL
    ALTER TABLE core.ScoRow ADD ScoItemID INT NULL
        CONSTRAINT FK_ScoRow_Item REFERENCES core.ScoItem(ScoItemID);
ELSE PRINT 'core.ScoRow.ScoItemID already exists';
GO

-- Records that an upload's workshops have been settled, so the payment step
-- can refuse to run before then.
IF COL_LENGTH('core.ScoImport', 'WorkshopsResolvedAt') IS NULL
    ALTER TABLE core.ScoImport ADD WorkshopsResolvedAt DATETIME2(0) NULL;
ELSE PRINT 'core.ScoImport.WorkshopsResolvedAt already exists';
GO
