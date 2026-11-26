-- =====================================================================
--  028 - Utility run audit trail
--
--  The Utilities screen (Settings > Utilities) replaces the Access macros
--  and action queries that silently ran an UPDATE or DELETE across whole
--  tables. Every run is recorded here so that "what did that button do"
--  has an answer after the fact.
--
--  One row per attempt, including the ones that were refused: a refusal is
--  the interesting case when a merge is blocked because both participants
--  share a workshop, so Succeeded = 0 with the reason in Error is kept.
--
--  Parameters holds the JSON inputs as submitted. AffectedRows is what the
--  run actually changed, which is not always the count the preview showed
--  (a row can be fixed by another admin between preview and run), so both
--  are stored - the preview count lives in Parameters.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF OBJECT_ID('audit.UtilityRun', 'U') IS NULL
BEGIN
    CREATE TABLE audit.UtilityRun (
        UtilityRunID  BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_UtilityRun PRIMARY KEY,
        UtilityKey    NVARCHAR(60)  NOT NULL,
        Parameters    NVARCHAR(MAX) NULL,
        AffectedRows  INT           NOT NULL CONSTRAINT DF_UtilityRun_Affected DEFAULT 0,
        RunBy         NVARCHAR(200) NULL,
        RunAt         DATETIME2(0)  NOT NULL
            CONSTRAINT DF_UtilityRun_RunAt DEFAULT SYSUTCDATETIME(),
        Succeeded     BIT           NOT NULL CONSTRAINT DF_UtilityRun_Succeeded DEFAULT 0,
        Error         NVARCHAR(1000) NULL
    );
    PRINT 'audit.UtilityRun created';
END
ELSE
BEGIN
    PRINT 'audit.UtilityRun already exists';
END
GO

-- The history panel reads newest first, one key at a time.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_UtilityRun_Key_RunAt'
                  AND object_id = OBJECT_ID('audit.UtilityRun'))
    CREATE INDEX IX_UtilityRun_Key_RunAt ON audit.UtilityRun(UtilityKey, RunAt DESC);
GO
