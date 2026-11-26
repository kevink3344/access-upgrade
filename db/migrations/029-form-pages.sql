-- =====================================================================
--  029 - Form Designer: pages
--
--  A long form is easier to answer a page at a time. A version now owns an
--  ordered list of pages, and each question belongs to one:
--
--    core.FormPage        one page on a version (title, subtitle, order)
--    FormQuestion.FormPageID  the page a question is asked on
--
--  A version with no pages renders exactly as it does today: one continuous
--  form, no Next/Back. The public page only paginates when a version has
--  more than one page, so every already-shared link keeps its current
--  behaviour without being edited.
--
--  FormPageID is nullable on purpose. Existing versions are not backfilled:
--  a NULL page means "the page-less form", which is what they are.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
-- Filtered indexes require these SET options, and sqlcmd defaults them off.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('core.FormPage', 'U') IS NULL
BEGIN
    CREATE TABLE core.FormPage (
        FormPageID            INT           NOT NULL CONSTRAINT PK_FormPage PRIMARY KEY,
        FormTemplateVersionID INT           NOT NULL
            CONSTRAINT FK_FormPage_Version
            REFERENCES core.FormTemplateVersion(FormTemplateVersionID),
        SortOrder             INT           NOT NULL,
        Title                 NVARCHAR(100) NOT NULL,
        Subtitle              NVARCHAR(300) NULL,
        CONSTRAINT UQ_FormPage_Sort UNIQUE (FormTemplateVersionID, SortOrder)
    );
    PRINT 'created core.FormPage';
END
GO

IF COL_LENGTH('core.FormQuestion', 'FormPageID') IS NULL
BEGIN
    ALTER TABLE core.FormQuestion
        ADD FormPageID INT NULL
            CONSTRAINT FK_FormQuestion_Page
            REFERENCES core.FormPage(FormPageID);
    PRINT 'added core.FormQuestion.FormPageID';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_FormQuestion_Page'
       AND object_id = OBJECT_ID('core.FormQuestion')
)
BEGIN
    CREATE INDEX IX_FormQuestion_Page
        ON core.FormQuestion (FormPageID)
        WHERE FormPageID IS NOT NULL;
    PRINT 'created IX_FormQuestion_Page';
END
GO

PRINT '029 complete';
GO
