-- =====================================================================
--  023 - Form Designer: storage target
--
--  A form template now declares where its submissions are stored. The
--  standard form writes a registration (Participant/Registration); the
--  training request form writes a row in core.TrainingRequest instead, so it
--  appears on the Training requests screen.
--
--  `Kind` is a closed set rather than a free string: the submission handler
--  branches on it, so an unknown value must be rejected at write time.
--
--  Also adds TrainingRequest.Description. The public training request form
--  asks for a free-text description of the training wanted, and the legacy
--  table has nowhere to put it: the closest field, TopicRequested, lives on
--  the child quote table and is a workshop-type code, not prose.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF COL_LENGTH('core.FormTemplate', 'Kind') IS NULL
BEGIN
    ALTER TABLE core.FormTemplate
        ADD Kind NVARCHAR(30) NOT NULL
            CONSTRAINT DF_FormTemplate_Kind DEFAULT 'registration';

    PRINT 'added core.FormTemplate.Kind';
END
ELSE
    PRINT 'core.FormTemplate.Kind already exists - nothing to do';
GO

-- Separate batch: the CHECK constraint references a column that must already
-- exist, and SQL Server resolves names at batch compile time.
IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_FormTemplate_Kind'
       AND parent_object_id = OBJECT_ID('core.FormTemplate')
)
BEGIN
    ALTER TABLE core.FormTemplate
        ADD CONSTRAINT CK_FormTemplate_Kind
        CHECK (Kind IN ('registration', 'trainingRequest'));

    PRINT 'added CK_FormTemplate_Kind';
END
ELSE
    PRINT 'CK_FormTemplate_Kind already exists - nothing to do';
GO

IF COL_LENGTH('core.TrainingRequest', 'Description') IS NULL
BEGIN
    ALTER TABLE core.TrainingRequest ADD Description NVARCHAR(MAX) NULL;
    PRINT 'added core.TrainingRequest.Description';
END
ELSE
    PRINT 'core.TrainingRequest.Description already exists - nothing to do';
GO
