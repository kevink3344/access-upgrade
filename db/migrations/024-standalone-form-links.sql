-- =====================================================================
--  024 - Standalone form links
--
--  A public link used to belong to a workshop, because the only public form
--  was a workshop registration. A training request form has no workshop, so
--  a link now belongs to EITHER a workshop OR a form template:
--
--    WorkshopID      the workshop being registered for (registration forms)
--    FormTemplateID  the form being answered (standalone forms)
--
--  Exactly one is set. Both are nullable now, so the constraint moves from
--  "WorkshopID is required" to "at least one is set".
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

-- Drop the NOT NULL on WorkshopID.
IF EXISTS (
    SELECT 1
      FROM sys.columns
     WHERE object_id = OBJECT_ID('core.WorkshopRegistrationLink')
       AND name = 'WorkshopID'
       AND is_nullable = 0
)
BEGIN
    ALTER TABLE core.WorkshopRegistrationLink ALTER COLUMN WorkshopID INT NULL;
    PRINT 'core.WorkshopRegistrationLink.WorkshopID is now nullable';
END
ELSE
    PRINT 'core.WorkshopRegistrationLink.WorkshopID already nullable - nothing to do';
GO

-- A standalone link points at a form template.
IF COL_LENGTH('core.WorkshopRegistrationLink', 'FormTemplateID') IS NULL
BEGIN
    ALTER TABLE core.WorkshopRegistrationLink
        ADD FormTemplateID INT NULL
            CONSTRAINT FK_RegistrationLink_FormTemplate
            REFERENCES core.FormTemplate(FormTemplateID);

    PRINT 'added core.WorkshopRegistrationLink.FormTemplateID';
END
ELSE
    PRINT 'core.WorkshopRegistrationLink.FormTemplateID already exists - nothing to do';
GO

-- A link must be attached to something, or it would ask nothing.
IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_RegistrationLink_Target'
       AND parent_object_id = OBJECT_ID('core.WorkshopRegistrationLink')
)
BEGIN
    ALTER TABLE core.WorkshopRegistrationLink
        ADD CONSTRAINT CK_RegistrationLink_Target
        CHECK (WorkshopID IS NOT NULL OR FormTemplateID IS NOT NULL);

    PRINT 'added CK_RegistrationLink_Target';
END
ELSE
    PRINT 'CK_RegistrationLink_Target already exists - nothing to do';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_RegistrationLink_FormTemplate'
       AND object_id = OBJECT_ID('core.WorkshopRegistrationLink')
)
BEGIN
    CREATE INDEX IX_RegistrationLink_FormTemplate
        ON core.WorkshopRegistrationLink(FormTemplateID);

    PRINT 'added IX_RegistrationLink_FormTemplate';
END
ELSE
    PRINT 'IX_RegistrationLink_FormTemplate already exists - nothing to do';
GO
