-- =====================================================================
--  030 - Form answers for training requests
--
--  008 gave core.FormAnswer a RegistrationID, which only fits a
--  registration form. A training-request form wrote its five mapped values
--  into core.TrainingRequest and dropped every other answer, so the
--  questions the requester actually answered were lost.
--
--  An answer now belongs to EITHER a registration OR a training request:
--
--    RegistrationID    set for a registration form
--    TrainingRequestID set for a training-request form
--
--  Both stay nullable so existing rows keep working. The old unique key
--  (RegistrationID, FormQuestionID) is replaced by two filtered unique
--  indexes, one per owner, because a plain UNIQUE over both columns would
--  not stop a duplicate within the same registration (NULLs are distinct).
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
-- Filtered indexes require these SET options, and sqlcmd defaults them off.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF COL_LENGTH('core.FormAnswer', 'TrainingRequestID') IS NULL
BEGIN
    ALTER TABLE core.FormAnswer
        ADD TrainingRequestID INT NULL
            CONSTRAINT FK_FormAnswer_TrainingRequest
            REFERENCES core.TrainingRequest(TrainingRequestID);
    PRINT 'added core.FormAnswer.TrainingRequestID';
END
GO

-- The original key allowed only one answer per question per registration.
-- Drop it before touching the column it depends on.
IF EXISTS (
    SELECT 1 FROM sys.key_constraints
     WHERE name = 'UQ_FormAnswer'
       AND parent_object_id = OBJECT_ID('core.FormAnswer')
)
BEGIN
    ALTER TABLE core.FormAnswer DROP CONSTRAINT UQ_FormAnswer;
    PRINT 'dropped UQ_FormAnswer';
END
GO

-- An answer belongs to one owner or the other, so RegistrationID must accept
-- NULL for the training-request rows.
IF EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('core.FormAnswer')
       AND name = 'RegistrationID'
       AND is_nullable = 0
)
BEGIN
    -- Any index over RegistrationID blocks the ALTER COLUMN, so drop ours
    -- first and recreate it below.
    IF EXISTS (
        SELECT 1 FROM sys.indexes
         WHERE name = 'UQ_FormAnswer_Registration'
           AND object_id = OBJECT_ID('core.FormAnswer')
    )
        DROP INDEX UQ_FormAnswer_Registration ON core.FormAnswer;

    ALTER TABLE core.FormAnswer ALTER COLUMN RegistrationID INT NULL;
    PRINT 'made core.FormAnswer.RegistrationID nullable';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'UQ_FormAnswer_Registration'
       AND object_id = OBJECT_ID('core.FormAnswer')
)
BEGIN
    CREATE UNIQUE INDEX UQ_FormAnswer_Registration
        ON core.FormAnswer (RegistrationID, FormQuestionID)
        WHERE RegistrationID IS NOT NULL;
    PRINT 'created UQ_FormAnswer_Registration';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'UQ_FormAnswer_TrainingRequest'
       AND object_id = OBJECT_ID('core.FormAnswer')
)
BEGIN
    CREATE UNIQUE INDEX UQ_FormAnswer_TrainingRequest
        ON core.FormAnswer (TrainingRequestID, FormQuestionID)
        WHERE TrainingRequestID IS NOT NULL;
    PRINT 'created UQ_FormAnswer_TrainingRequest';
END
GO

PRINT '030 complete';
GO
