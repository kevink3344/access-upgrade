-- =====================================================================
--  Public registration links
--
--  Implements docs/features/public-registration.md §3.
--
--  A workshop gets one or more shareable links, each with an opaque slug.
--  The slug is the access control: it is unguessable and individually
--  revocable, so a leaked link can be killed without affecting others.
-- =====================================================================

SET NOCOUNT ON;
GO

IF OBJECT_ID('core.WorkshopRegistrationLink', 'U') IS NULL
BEGIN
    CREATE TABLE core.WorkshopRegistrationLink (
        RegistrationLinkID INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_WorkshopRegistrationLink PRIMARY KEY,
        -- A link belongs to a workshop (registration forms) or to a form
        -- template (standalone forms such as training requests). Exactly one
        -- is set; CK_RegistrationLink_Target enforces that at least one is.
        WorkshopID         INT           NULL
            CONSTRAINT FK_RegistrationLink_Workshop REFERENCES core.Workshop(WorkshopID),
        FormTemplateID     INT           NULL
            CONSTRAINT FK_RegistrationLink_FormTemplate REFERENCES core.FormTemplate(FormTemplateID),
        Slug               NVARCHAR(24)  NOT NULL,
        IsActive           BIT           NOT NULL CONSTRAINT DF_RegistrationLink_IsActive DEFAULT 0,
        WebSeatCap         INT           NULL,
        OpensAt            DATETIME2(0)  NULL,
        ClosesAt           DATETIME2(0)  NULL,
        RedirectToPayment  BIT           NOT NULL CONSTRAINT DF_RegistrationLink_Redirect DEFAULT 0,
        PaymentUrl         NVARCHAR(500) NULL,
        RevokedAt          DATETIME2(0)  NULL,
        RevokedBy          NVARCHAR(100) NULL,
        CreatedBy          NVARCHAR(100) NOT NULL,
        CreatedAt          DATETIME2(0)  NOT NULL CONSTRAINT DF_RegistrationLink_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_RegistrationLink_Slug UNIQUE (Slug),
        CONSTRAINT CK_RegistrationLink_Target
            CHECK (WorkshopID IS NOT NULL OR FormTemplateID IS NOT NULL),
        CONSTRAINT CK_RegistrationLink_PaymentUrl
            CHECK (RedirectToPayment = 0 OR PaymentUrl IS NOT NULL)
    );
    CREATE INDEX IX_RegistrationLink_Workshop ON core.WorkshopRegistrationLink(WorkshopID);
    CREATE INDEX IX_RegistrationLink_FormTemplate ON core.WorkshopRegistrationLink(FormTemplateID);
    PRINT 'core.WorkshopRegistrationLink created';
END
ELSE PRINT 'core.WorkshopRegistrationLink already exists';
GO

-- Workshop-level master switch. Separate from the link's own IsActive:
-- closing a workshop is a business decision, revoking a link is a
-- distribution mistake. They show different messages to the public.
IF COL_LENGTH('core.Workshop', 'IsRegistrationOpen') IS NULL
BEGIN
    ALTER TABLE core.Workshop
        ADD IsRegistrationOpen BIT NOT NULL
            CONSTRAINT DF_Workshop_IsRegistrationOpen DEFAULT 0;
    PRINT 'core.Workshop.IsRegistrationOpen added';
END
ELSE PRINT 'core.Workshop.IsRegistrationOpen already exists';
GO

-- Registration provenance + confirmation tracking.
IF COL_LENGTH('core.Registration', 'ConfirmationSentAt') IS NULL
BEGIN
    ALTER TABLE core.Registration ADD ConfirmationSentAt DATETIME2(0) NULL;
    PRINT 'core.Registration.ConfirmationSentAt added';
END
GO

IF COL_LENGTH('core.Registration', 'ConfirmationToken') IS NULL
BEGIN
    ALTER TABLE core.Registration ADD ConfirmationToken UNIQUEIDENTIFIER NULL;
    PRINT 'core.Registration.ConfirmationToken added';
END
GO

-- Every public submission is logged before business logic runs, so abuse
-- is visible even when the submission is rejected.
IF OBJECT_ID('audit.PublicSubmission', 'U') IS NULL
BEGIN
    CREATE TABLE audit.PublicSubmission (
        PublicSubmissionID BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_PublicSubmission PRIMARY KEY,
        RegistrationLinkID INT           NULL,
        SubmittedAt        DATETIME2(0)  NOT NULL CONSTRAINT DF_PublicSubmission_At DEFAULT SYSUTCDATETIME(),
        IpHash             VARBINARY(32) NULL,
        UserAgent          NVARCHAR(400) NULL,
        Outcome            NVARCHAR(30)  NOT NULL,
        Reason             NVARCHAR(200) NULL,
        PayloadHash        VARBINARY(32) NULL
    );
    CREATE INDEX IX_PublicSubmission_Link ON audit.PublicSubmission(RegistrationLinkID, SubmittedAt);
    CREATE INDEX IX_PublicSubmission_Ip ON audit.PublicSubmission(IpHash, SubmittedAt);
    PRINT 'audit.PublicSubmission created';
END
ELSE PRINT 'audit.PublicSubmission already exists';
GO

-- ---------------------------------------------------------------------
--  Role-specific answers from the public form
--
--  The form branches on registrantRole. Each branch asks two extra
--  questions that have no home in the legacy schema:
--
--    Educator          -> school name, class ages
--    Parent/caregiver  -> children's ages, second caregiver details
--
--  Educator answers reuse existing columns where the meaning already
--  matches (School name -> AgencyID via the agency picker, class ages ->
--  GradeLevel, which the legacy data already uses for class ages such as
--  'NC Pre K' and '3-4 year olds'). Only the parent answers are new.
-- ---------------------------------------------------------------------
IF COL_LENGTH('core.Participant', 'ChildrenAges') IS NULL
BEGIN
    ALTER TABLE core.Participant ADD ChildrenAges NVARCHAR(255) NULL;
    PRINT 'core.Participant.ChildrenAges added';
END
ELSE PRINT 'core.Participant.ChildrenAges already exists';
GO

IF COL_LENGTH('core.Participant', 'SecondCaregiverInfo') IS NULL
BEGIN
    ALTER TABLE core.Participant ADD SecondCaregiverInfo NVARCHAR(MAX) NULL;
    PRINT 'core.Participant.SecondCaregiverInfo added';
END
ELSE PRINT 'core.Participant.SecondCaregiverInfo already exists';
GO
