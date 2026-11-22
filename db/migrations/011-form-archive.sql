-- =====================================================================
--  011 - Form Designer: archive instead of delete
--
--  Deleting a form is destructive and, because versions and questions hang
--  off it, a mistake cannot be undone. Forms are now archived rather than
--  removed: the row stays, its versions and answers stay, and it simply
--  stops appearing in the picker.
--
--  Archive is deliberately separate from IsActive:
--
--    IsActive = 0   "not in use right now" - still listed, still editable,
--                   can be reactivated. A form being reworked.
--    ArchivedAt     "retired" - hidden from the default list and from the
--                   registration-link picker, restorable.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF COL_LENGTH('core.FormTemplate', 'ArchivedAt') IS NULL
BEGIN
    ALTER TABLE core.FormTemplate ADD ArchivedAt DATETIME2 NULL;
    PRINT 'added core.FormTemplate.ArchivedAt';
END
GO

IF COL_LENGTH('core.FormTemplate', 'ArchivedBy') IS NULL
BEGIN
    ALTER TABLE core.FormTemplate ADD ArchivedBy NVARCHAR(200) NULL;
    PRINT 'added core.FormTemplate.ArchivedBy';
END
GO

PRINT '011 complete';
GO
