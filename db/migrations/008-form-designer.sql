-- =====================================================================
--  008 - Form Designer
--
--  Lets staff design the questions on the public registration form.
--  Workshop details (title, date, time, cost, CEUs) are never part of a
--  template - they always render from core.Workshop.
--
--  Shape:
--    FormTemplate         a named form, e.g. "Standard Registration Form"
--    FormTemplateVersion  an immutable snapshot; editing creates a new one
--    FormQuestion         one question on a version
--    FormAnswer           one answer, tied to a registration
--
--  A registration link pins a VERSION, not a template, so editing a form
--  never changes what an already-shared link asks.
--
--  See docs/plans/form-designer.md.
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

/* ---------------- core.FormTemplate ---------------- */
IF OBJECT_ID('core.FormTemplate', 'U') IS NULL
BEGIN
    CREATE TABLE core.FormTemplate (
        FormTemplateID INT           NOT NULL CONSTRAINT PK_FormTemplate PRIMARY KEY,
        Name           NVARCHAR(100) NOT NULL,
        Description    NVARCHAR(500) NULL,
        IsActive       BIT           NOT NULL CONSTRAINT DF_FormTemplate_IsActive DEFAULT 1,
        CreatedBy      NVARCHAR(200) NOT NULL,
        CreatedAt      DATETIME2     NOT NULL CONSTRAINT DF_FormTemplate_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBy      NVARCHAR(200) NULL,
        UpdatedAt      DATETIME2     NULL
    );
    PRINT 'created core.FormTemplate';
END
GO

/* ---------------- core.FormTemplateVersion ---------------- */
IF OBJECT_ID('core.FormTemplateVersion', 'U') IS NULL
BEGIN
    CREATE TABLE core.FormTemplateVersion (
        FormTemplateVersionID INT       NOT NULL CONSTRAINT PK_FormTemplateVersion PRIMARY KEY,
        FormTemplateID        INT       NOT NULL
            CONSTRAINT FK_FormTemplateVersion_Template REFERENCES core.FormTemplate(FormTemplateID),
        VersionNumber         INT       NOT NULL,
        PublishedAt           DATETIME2 NULL,   -- NULL = draft, not selectable for new links
        PublishedBy           NVARCHAR(200) NULL,
        CreatedBy             NVARCHAR(200) NOT NULL,
        CreatedAt             DATETIME2 NOT NULL CONSTRAINT DF_FormTemplateVersion_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_FormTemplateVersion UNIQUE (FormTemplateID, VersionNumber)
    );
    PRINT 'created core.FormTemplateVersion';
END
GO

/* ---------------- core.FormQuestion ---------------- */
IF OBJECT_ID('core.FormQuestion', 'U') IS NULL
BEGIN
    CREATE TABLE core.FormQuestion (
        FormQuestionID        INT           NOT NULL CONSTRAINT PK_FormQuestion PRIMARY KEY,
        FormTemplateVersionID INT           NOT NULL
            CONSTRAINT FK_FormQuestion_Version REFERENCES core.FormTemplateVersion(FormTemplateVersionID),
        SortOrder             INT           NOT NULL,
        QuestionKey           NVARCHAR(50)  NOT NULL,
        Label                 NVARCHAR(200) NOT NULL,
        HelpText              NVARCHAR(300) NULL,
        Placeholder           NVARCHAR(100) NULL,
        FieldType             NVARCHAR(20)  NOT NULL,
        IsRequired            BIT           NOT NULL CONSTRAINT DF_FormQuestion_IsRequired DEFAULT 0,
        OptionsJson           NVARCHAR(MAX) NULL,
        MaxLength             INT           NULL,
        MapsToColumn          NVARCHAR(50)  NULL,
        IsBuiltIn             BIT           NOT NULL CONSTRAINT DF_FormQuestion_IsBuiltIn DEFAULT 0,
        IsActive              BIT           NOT NULL CONSTRAINT DF_FormQuestion_IsActive DEFAULT 1,
        CONSTRAINT UQ_FormQuestion_Key UNIQUE (FormTemplateVersionID, QuestionKey),
        CONSTRAINT CK_FormQuestion_FieldType
            CHECK (FieldType IN ('text', 'longtext', 'number', 'select', 'radio', 'checkbox'))
    );
    PRINT 'created core.FormQuestion';
END
GO

/* ---------------- core.FormAnswer ---------------- */
IF OBJECT_ID('core.FormAnswer', 'U') IS NULL
BEGIN
    CREATE TABLE core.FormAnswer (
        FormAnswerID   BIGINT        NOT NULL CONSTRAINT PK_FormAnswer PRIMARY KEY,
        RegistrationID INT           NOT NULL
            CONSTRAINT FK_FormAnswer_Registration REFERENCES core.Registration(RegistrationID),
        FormQuestionID INT           NOT NULL
            CONSTRAINT FK_FormAnswer_Question REFERENCES core.FormQuestion(FormQuestionID),
        AnswerText     NVARCHAR(MAX) NULL,
        AnswerJson     NVARCHAR(MAX) NULL,
        CreatedAt      DATETIME2     NOT NULL CONSTRAINT DF_FormAnswer_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_FormAnswer UNIQUE (RegistrationID, FormQuestionID)
    );
    CREATE INDEX IX_FormAnswer_Question ON core.FormAnswer(FormQuestionID);
    PRINT 'created core.FormAnswer';
END
GO

/* ---------------- link pins a version ---------------- */
IF COL_LENGTH('core.WorkshopRegistrationLink', 'FormTemplateVersionID') IS NULL
BEGIN
    ALTER TABLE core.WorkshopRegistrationLink
        ADD FormTemplateVersionID INT NULL
            CONSTRAINT FK_RegistrationLink_Version
            REFERENCES core.FormTemplateVersion(FormTemplateVersionID);
    PRINT 'added core.WorkshopRegistrationLink.FormTemplateVersionID';
END
GO

PRINT '008 complete';
GO
