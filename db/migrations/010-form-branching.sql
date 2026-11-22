-- =====================================================================
--  010 - Form Designer: branching
--
--  The public form already branches: "I am registering as" is a radio with
--  Educator / Parent-caregiver, and each option reveals its own questions.
--  That logic lived only in the React component, so staff could not see it
--  and could not change it.
--
--  A question now carries an optional branch condition:
--
--    BranchOnQuestionID   the question whose answer decides visibility
--    BranchOptionValue    the option that must be chosen
--
--  A question with both set is shown only when the named question's answer
--  matches. A question with neither is always shown.
--
--  The built-in role question is itself a normal question, so the existing
--  Educator/Parent split becomes data rather than code.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
-- Filtered indexes require these SET options, and sqlcmd defaults them off.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF COL_LENGTH('core.FormQuestion', 'BranchOnQuestionID') IS NULL
BEGIN
    ALTER TABLE core.FormQuestion
        ADD BranchOnQuestionID INT NULL
            CONSTRAINT FK_FormQuestion_BranchOn
            REFERENCES core.FormQuestion(FormQuestionID);
    PRINT 'added core.FormQuestion.BranchOnQuestionID';
END
GO

IF COL_LENGTH('core.FormQuestion', 'BranchOptionValue') IS NULL
BEGIN
    ALTER TABLE core.FormQuestion
        ADD BranchOptionValue NVARCHAR(100) NULL;
    PRINT 'added core.FormQuestion.BranchOptionValue';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_FormQuestion_BranchOn'
       AND object_id = OBJECT_ID('core.FormQuestion')
)
BEGIN
    CREATE INDEX IX_FormQuestion_BranchOn
        ON core.FormQuestion (BranchOnQuestionID)
        WHERE BranchOnQuestionID IS NOT NULL;
    PRINT 'created IX_FormQuestion_BranchOn';
END
GO

PRINT '010 complete';
GO
