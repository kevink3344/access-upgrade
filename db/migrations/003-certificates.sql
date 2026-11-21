-- =====================================================================
--  003 - Certificates: images in the database + per-participant overrides
--
--  Adds:
--    core.CertificateAsset     image bytes (logo, per-participant image)
--    core.CertificateOverride  per-participant text and image
--    core.CertificateIssue     an issued certificate (snapshot + PDF)
--    core.Registration.IsLate  the legacy "Late" rule the CEU query used
--
--  Images live in SQL Server as VARBINARY(MAX). Azure SQL Database does
--  not support FILESTREAM, so this is the only in-database option.
--
--  Issued certificates store a SNAPSHOT of the template and the rendered
--  PDF, so a reissued certificate keeps the logo and signatories it was
--  issued with even after staff edit the template.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------
   core.CertificateAsset - one row per uploaded image
   --------------------------------------------------------------------- */
IF OBJECT_ID('core.CertificateAsset', 'U') IS NULL
BEGIN
    CREATE TABLE core.CertificateAsset (
        CertificateAssetID INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_CertificateAsset PRIMARY KEY,
        -- 'template-logo' | 'participant-image'
        AssetKind          NVARCHAR(30)  NOT NULL,
        FileName           NVARCHAR(260) NULL,
        ContentType        NVARCHAR(100) NOT NULL,
        ByteSize           INT           NOT NULL,
        Sha256             BINARY(32)    NOT NULL,
        Content            VARBINARY(MAX) NOT NULL,
        UploadedBy         NVARCHAR(200) NULL,
        UploadedAt         DATETIME2(0)  NOT NULL
            CONSTRAINT DF_CertificateAsset_UploadedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_CertificateAsset_Kind
            CHECK (AssetKind IN ('template-logo', 'participant-image')),
        CONSTRAINT CK_CertificateAsset_Size
            CHECK (ByteSize > 0 AND ByteSize <= 2097152)   -- 2 MB ceiling
    );
    PRINT 'Created core.CertificateAsset';
END
ELSE PRINT 'core.CertificateAsset already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_CertificateAsset_Sha256'
       AND object_id = OBJECT_ID('core.CertificateAsset')
)
BEGIN
    CREATE INDEX IX_CertificateAsset_Sha256 ON core.CertificateAsset (Sha256);
    PRINT 'Created IX_CertificateAsset_Sha256';
END
GO

/* ---------------------------------------------------------------------
   core.CertificateTemplate - add the logo FK
   --------------------------------------------------------------------- */
IF COL_LENGTH('core.CertificateTemplate', 'LogoAssetID') IS NULL
BEGIN
    ALTER TABLE core.CertificateTemplate
        ADD LogoAssetID INT NULL
            CONSTRAINT FK_CertificateTemplate_Logo
            REFERENCES core.CertificateAsset (CertificateAssetID);
    PRINT 'Added core.CertificateTemplate.LogoAssetID';
END
ELSE PRINT 'core.CertificateTemplate.LogoAssetID already exists';
GO

/* The NCDHHS / Division of Child Development mark that sits top-left on the
   supplied template, alongside the Project Enlightenment logo. */
IF COL_LENGTH('core.CertificateTemplate', 'SecondaryLogoAssetID') IS NULL
BEGIN
    ALTER TABLE core.CertificateTemplate
        ADD SecondaryLogoAssetID INT NULL
            CONSTRAINT FK_CertificateTemplate_SecondaryLogo
            REFERENCES core.CertificateAsset (CertificateAssetID);
    PRINT 'Added core.CertificateTemplate.SecondaryLogoAssetID';
END
ELSE PRINT 'core.CertificateTemplate.SecondaryLogoAssetID already exists';
GO

/* ---------------------------------------------------------------------
   core.CertificateOverride - per-participant text and image
   --------------------------------------------------------------------- */
IF OBJECT_ID('core.CertificateOverride', 'U') IS NULL
BEGIN
    CREATE TABLE core.CertificateOverride (
        CertificateOverrideID INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_CertificateOverride PRIMARY KEY,
        ParticipantID         INT           NOT NULL
            CONSTRAINT FK_CertificateOverride_Participant
            REFERENCES core.Participant (ParticipantID),
        SchoolYearID          INT           NOT NULL
            CONSTRAINT FK_CertificateOverride_SchoolYear
            REFERENCES ref.SchoolYear (SchoolYearID),
        CertificateType       NVARCHAR(10)  NOT NULL,   -- 'CEU' | 'CHC'

        -- Free text a staff member adds to this person's certificate only.
        CustomText            NVARCHAR(500) NULL,
        CustomTextLabel       NVARCHAR(100) NULL,       -- e.g. 'Awarded for'

        -- One optional image per participant.
        ImageAssetID          INT           NULL
            CONSTRAINT FK_CertificateOverride_Image
            REFERENCES core.CertificateAsset (CertificateAssetID),
        ImageAltText          NVARCHAR(200) NULL,
        ImagePlacement        NVARCHAR(20)  NULL,       -- 'header'|'body'|'footer'

        UpdatedBy             NVARCHAR(200) NULL,
        UpdatedAt             DATETIME2(0)  NOT NULL
            CONSTRAINT DF_CertificateOverride_UpdatedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT UQ_CertificateOverride
            UNIQUE (ParticipantID, SchoolYearID, CertificateType),
        CONSTRAINT CK_CertificateOverride_Type
            CHECK (CertificateType IN ('CEU', 'CHC')),
        CONSTRAINT CK_CertificateOverride_Placement
            CHECK (ImagePlacement IS NULL OR ImagePlacement IN ('header', 'body', 'footer')),
        -- An image without alt text is an accessibility defect, so the
        -- database refuses it rather than trusting the API to check.
        CONSTRAINT CK_CertificateOverride_AltText
            CHECK (ImageAssetID IS NULL OR (ImageAltText IS NOT NULL AND LEN(LTRIM(ImageAltText)) > 0))
    );
    PRINT 'Created core.CertificateOverride';
END
ELSE PRINT 'core.CertificateOverride already exists';
GO

/* ---------------------------------------------------------------------
   core.CertificateIssue - an issued certificate
   --------------------------------------------------------------------- */
IF OBJECT_ID('core.CertificateIssue', 'U') IS NULL
BEGIN
    CREATE TABLE core.CertificateIssue (
        CertificateIssueID    INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_CertificateIssue PRIMARY KEY,
        ParticipantID         INT           NOT NULL
            CONSTRAINT FK_CertificateIssue_Participant
            REFERENCES core.Participant (ParticipantID),
        SchoolYearID          INT           NOT NULL
            CONSTRAINT FK_CertificateIssue_SchoolYear
            REFERENCES ref.SchoolYear (SchoolYearID),
        CertificateType       NVARCHAR(10)  NOT NULL,

        -- Snapshotted at issue time so the PDF can be reproduced exactly.
        SnapshotJson          NVARCHAR(MAX) NOT NULL,
        PdfContent            VARBINARY(MAX) NULL,
        PdfByteSize           INT           NULL,

        TotalHours            DECIMAL(9,2)  NULL,
        TotalCeus             DECIMAL(9,2)  NULL,

        IssuedBy              NVARCHAR(200) NULL,
        IssuedAt              DATETIME2(0)  NOT NULL
            CONSTRAINT DF_CertificateIssue_IssuedAt DEFAULT SYSUTCDATETIME(),
        -- Set when a later template change supersedes this issue.
        SupersededAt          DATETIME2(0)  NULL,

        CONSTRAINT CK_CertificateIssue_Type
            CHECK (CertificateType IN ('CEU', 'CHC'))
    );
    PRINT 'Created core.CertificateIssue';
END
ELSE PRINT 'core.CertificateIssue already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_CertificateIssue_Lookup'
       AND object_id = OBJECT_ID('core.CertificateIssue')
)
BEGIN
    CREATE INDEX IX_CertificateIssue_Lookup
        ON core.CertificateIssue (ParticipantID, SchoolYearID, CertificateType);
    PRINT 'Created IX_CertificateIssue_Lookup';
END
GO

/* ---------------------------------------------------------------------
   core.Registration.IsLate - the legacy "Late" rule
   ---------------------------------------------------------------------
   sqryCEUCertificates excluded late attendees from credit. The column was
   never migrated because nothing else needed it; certificates do.
   --------------------------------------------------------------------- */
IF COL_LENGTH('core.Registration', 'IsLate') IS NULL
BEGIN
    ALTER TABLE core.Registration
        ADD IsLate BIT NOT NULL
            CONSTRAINT DF_Registration_IsLate DEFAULT 0;
    PRINT 'Added core.Registration.IsLate';
END
ELSE PRINT 'core.Registration.IsLate already exists';
GO

/* ---------------------------------------------------------------------
   core.vw_CertificateEligible - who can be issued a certificate
   ---------------------------------------------------------------------
   Ports sqryCEUCertificates:
     - attended, not cancelled
     - workshop code starts with 't'
     - not late
     - grouped by participant and school year
   --------------------------------------------------------------------- */
IF OBJECT_ID('core.vw_CertificateEligible', 'V') IS NOT NULL
    DROP VIEW core.vw_CertificateEligible;
GO
CREATE VIEW core.vw_CertificateEligible AS
SELECT
    p.ParticipantID,
    w.SchoolYearID,
    p.FirstName,
    p.LastName,
    p.MiddleName,
    p.Email,
    a.AgencyName,
    COUNT(*)                        AS WorkshopCount,
    SUM(w.SessionHours)             AS TotalHours,
    SUM(w.SessionHours * 0.1)       AS TotalCeus,
    MIN(w.StartDate)                AS FirstDate,
    MAX(COALESCE(w.EndDate, w.StartDate)) AS LastDate,
    -- Workshops with no hours recorded would silently produce a zero-credit
    -- certificate, so surface the count for the UI to warn about.
    SUM(CASE WHEN w.SessionHours IS NULL THEN 1 ELSE 0 END) AS MissingHoursCount
FROM core.Participant p
JOIN core.Registration r ON r.ParticipantID = p.ParticipantID
JOIN core.Workshop     w ON w.WorkshopID   = r.WorkshopID
LEFT JOIN core.Agency  a ON a.AgencyID     = p.AgencyID
WHERE r.Attended    = 1
  AND r.IsCancelled = 0
  AND r.IsLate      = 0
  AND w.WorkshopCode LIKE 't%'
GROUP BY p.ParticipantID, w.SchoolYearID, p.FirstName, p.LastName,
         p.MiddleName, p.Email, a.AgencyName;
GO
PRINT 'Created core.vw_CertificateEligible';
GO

/* ---------------------------------------------------------------------
   Align the seeded titles with the supplied template
   ---------------------------------------------------------------------
   The supplied "Credit Slips 26-27" template reads CERTIFICATE / OF
   ATTENDANCE, not "Certificate of Credit". Only rows still carrying the
   original seed value are touched, so a template staff have already
   edited is left alone.
   --------------------------------------------------------------------- */
UPDATE core.CertificateTemplate
   SET Title = 'Certificate',
       Subtitle = 'of Attendance',
       UpdatedBy = 'etl:seed-003',
       UpdatedAt = SYSUTCDATETIME()
 WHERE Title = 'Certificate of Credit'
   AND (UpdatedBy IS NULL OR UpdatedBy LIKE 'etl:%');
PRINT CONCAT('Aligned ', @@ROWCOUNT, ' template titles with the supplied design');
GO

/* ---------------------------------------------------------------------
   Seed a template for every school year that has eligible participants
   ---------------------------------------------------------------------
   Only 2025-26 was seeded by the ETL, but certificates are issued for
   historical years too. Each eligible year gets a CEU and a CHC template
   copied from the most recent one, so staff can edit them per year.
   --------------------------------------------------------------------- */
INSERT INTO core.CertificateTemplate
    (SchoolYearID, CertificateType, Title, Subtitle,
     ProgramDirectorName, ProgramDirectorTitle,
     ApprovingDirectorName, ApprovingDirectorTitle,
     CreditUnitLabel, FooterText, VisibleFields, UpdatedBy)
SELECT y.SchoolYearID, t.CertificateType, t.Title, t.Subtitle,
       t.ProgramDirectorName, t.ProgramDirectorTitle,
       t.ApprovingDirectorName, t.ApprovingDirectorTitle,
       t.CreditUnitLabel, t.FooterText, t.VisibleFields, 'etl:seed-003'
FROM (
    SELECT DISTINCT SchoolYearID FROM core.vw_CertificateEligible
) y
CROSS JOIN (
    SELECT TOP 2 CertificateType, Title, Subtitle,
           ProgramDirectorName, ProgramDirectorTitle,
           ApprovingDirectorName, ApprovingDirectorTitle,
           CreditUnitLabel, FooterText, VisibleFields
      FROM core.CertificateTemplate
     ORDER BY CertificateTemplateID
) t
WHERE NOT EXISTS (
    SELECT 1 FROM core.CertificateTemplate x
     WHERE x.SchoolYearID = y.SchoolYearID
       AND x.CertificateType = t.CertificateType
);
PRINT CONCAT('Seeded templates for ', @@ROWCOUNT, ' (school year, type) combinations');
GO

/* ---------------------------------------------------------------------
   Verify
   --------------------------------------------------------------------- */
SELECT
    (SELECT COUNT(*) FROM sys.tables
      WHERE name IN ('CertificateAsset','CertificateOverride','CertificateIssue')) AS TablesCreated,
    (SELECT COUNT(*) FROM sys.views WHERE name = 'vw_CertificateEligible')          AS ViewsCreated,
    (SELECT COUNT(*) FROM sys.columns
      WHERE name = 'IsLate' AND object_id = OBJECT_ID('core.Registration'))        AS IsLateAdded,
    (SELECT COUNT(*) FROM core.CertificateTemplate)                                AS Templates;
GO
