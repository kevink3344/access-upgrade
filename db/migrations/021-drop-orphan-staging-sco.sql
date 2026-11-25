-- =====================================================================
--  021 - Remove the orphaned staging.Sco* tables from the test database
--
--  School Cash staging lives in core.ScoImport / core.ScoRow / core.ScoItem,
--  not in the staging schema. Migration 016 explains why: the application
--  login has no rights on staging in production, so the tables were put in
--  core, the schema the app owns.
--
--  staging.ScoImport and staging.ScoRow were created during early development
--  before that decision and were never referenced by the application or by
--  any migration. They are empty in the test database and do not exist in
--  production, which made compare-schema.ps1 report 46 permanent drift items
--  and hid real drift behind them.
--
--  This file drops them where they exist. It is a no-op in production, which
--  is the point: the same file runs against both databases and leaves them
--  identical.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

-- Refuse to drop anything with rows. These tables should be empty; if they
-- are not, the assumption behind this migration is wrong and a person needs
-- to look before data is destroyed.
IF OBJECT_ID('staging.ScoRow', 'U') IS NOT NULL
BEGIN
    IF EXISTS (SELECT 1 FROM staging.ScoRow)
    BEGIN
        DECLARE @rows INT = (SELECT COUNT(*) FROM staging.ScoRow);
        RAISERROR('staging.ScoRow holds %d rows - not dropping. Investigate first.', 16, 1, @rows);
        RETURN;
    END

    -- Child first: it carries the foreign key to staging.ScoImport.
    DROP TABLE staging.ScoRow;
    PRINT 'Dropped staging.ScoRow';
END
ELSE
    PRINT 'staging.ScoRow does not exist';
GO

IF OBJECT_ID('staging.ScoImport', 'U') IS NOT NULL
BEGIN
    IF EXISTS (SELECT 1 FROM staging.ScoImport)
    BEGIN
        DECLARE @imports INT = (SELECT COUNT(*) FROM staging.ScoImport);
        RAISERROR('staging.ScoImport holds %d rows - not dropping. Investigate first.', 16, 1, @imports);
        RETURN;
    END

    DROP TABLE staging.ScoImport;
    PRINT 'Dropped staging.ScoImport';
END
ELSE
    PRINT 'staging.ScoImport does not exist';
GO

-- Report what is left, so the run says something useful on both databases.
SELECT 'staging schema tables' AS CheckName,
       ISNULL(STRING_AGG(t.name, ', '), '(none)') AS Remaining
  FROM sys.tables t
  JOIN sys.schemas s ON s.schema_id = t.schema_id
 WHERE s.name = 'staging';
GO
