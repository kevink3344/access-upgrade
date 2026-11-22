-- =====================================================================
--  Project Enlightenment Training Database
--  Target schema for Azure SQL (project-enlightenment)
--
--  Source of truth: database/TrainingDatabase.accdb, read 2026-11-19.
--  Column names, types, sizes and nullability were extracted from the
--  live Access database, NOT copied from the migration plan's abridged
--  DDL - the plan's assumed names differ from reality in several places
--  (see docs/completions/2026-11-19-schema.md).
--
--  IDEMPOTENT AND NON-DESTRUCTIVE.
--
--  This file never drops anything. Every object is created only if it
--  does not already exist, so it is safe to run against a populated
--  database: existing tables and their data are left untouched.
--
--  It is therefore NOT a migration tool. To change an object that
--  already exists, write a targeted ALTER in db/migrations/ and apply
--  it to both databases (see docs/features/schema-environments.md).
--
--  Data load is a separate step (db/etl) and is NOT performed here.

-- =====================================================================

SET NOCOUNT ON;
GO

-- =====================================================================
--  Schemas

-- =====================================================================
IF SCHEMA_ID('ref')     IS NULL EXEC('CREATE SCHEMA ref');
GO
IF SCHEMA_ID('core')    IS NULL EXEC('CREATE SCHEMA core');
GO
IF SCHEMA_ID('audit')   IS NULL EXEC('CREATE SCHEMA audit');
GO
IF SCHEMA_ID('staging') IS NULL EXEC('CREATE SCHEMA staging');
GO

-- =====================================================================
--  ref -- lookup tables (29). One row per legacy lst* table.

-- =====================================================================
IF OBJECT_ID('ref.AgencyType', 'U') IS NULL
BEGIN
CREATE TABLE ref.AgencyType (
    AgencyTypeID  INT           NOT NULL CONSTRAINT PK_AgencyType PRIMARY KEY,
    TypeName      NVARCHAR(50)  NULL
);
END

IF OBJECT_ID('ref.Age', 'U') IS NULL
BEGIN
CREATE TABLE ref.Age (
    AgesID        INT            NOT NULL CONSTRAINT PK_Age PRIMARY KEY,
    Ages          NVARCHAR(100)  NULL,
    SortOrder     INT            NULL      -- legacy column named [Order]
);
END

IF OBJECT_ID('ref.BackupTime', 'U') IS NULL
BEGIN
CREATE TABLE ref.BackupTime (
    BackupTimeID  INT           NOT NULL CONSTRAINT PK_BackupTime PRIMARY KEY,
    BackupTime    NVARCHAR(15)  NULL
);
END

IF OBJECT_ID('ref.Category', 'U') IS NULL
BEGIN
CREATE TABLE ref.Category (
    CategoryID    INT           NOT NULL CONSTRAINT PK_Category PRIMARY KEY,
    CategoryCode  NVARCHAR(50)  NULL,
    CategoryType  NVARCHAR(10)  NULL,     -- legacy [Type]: 'Classroom' | 'Workshops' | 'Grant'
    IsInUse       BIT           NOT NULL CONSTRAINT DF_Category_InUse DEFAULT 1
);
END

IF OBJECT_ID('ref.City', 'U') IS NULL
BEGIN
CREATE TABLE ref.City (
    CityID        INT           NOT NULL CONSTRAINT PK_City PRIMARY KEY,
    RegionID      INT           NULL,
    City          NVARCHAR(30)  NULL
);
END

IF OBJECT_ID('ref.Component', 'U') IS NULL
BEGIN
CREATE TABLE ref.Component (
    ComponentID   INT           NOT NULL CONSTRAINT PK_Component PRIMARY KEY,
    PrEComponent  NVARCHAR(30)  NULL,
    PrECompAbbrev NVARCHAR(10)  NULL
);
END

IF OBJECT_ID('ref.ContactType', 'U') IS NULL
BEGIN
CREATE TABLE ref.ContactType (
    ContactTypeID INT           NOT NULL CONSTRAINT PK_ContactType PRIMARY KEY,
    ContactType   NVARCHAR(50)  NULL
);
END

IF OBJECT_ID('ref.County', 'U') IS NULL
BEGIN
CREATE TABLE ref.County (
    CountyID      INT           NOT NULL CONSTRAINT PK_County PRIMARY KEY,
    County        NVARCHAR(20)  NULL
);
END

IF OBJECT_ID('ref.CreditSlipCategory', 'U') IS NULL
BEGIN
CREATE TABLE ref.CreditSlipCategory (
    CreditSlipsCategoryID INT          NOT NULL CONSTRAINT PK_CreditSlipCategory PRIMARY KEY,
    CreditSlipsCategory   NVARCHAR(30) NULL
);
END

IF OBJECT_ID('ref.CreditType', 'U') IS NULL
BEGIN
CREATE TABLE ref.CreditType (
    CreditTypeID      INT           NOT NULL CONSTRAINT PK_CreditType PRIMARY KEY,
    CreditCode        NVARCHAR(50)  NULL,
    CreditDescription NVARCHAR(50)  NULL
);
END

IF OBJECT_ID('ref.DesiredTopicCategory', 'U') IS NULL
BEGIN
CREATE TABLE ref.DesiredTopicCategory (
    DesiredTopicCategoryID INT           NOT NULL CONSTRAINT PK_DesiredTopicCategory PRIMARY KEY,
    DesiredTopicCategory   NVARCHAR(255) NULL
);
END

IF OBJECT_ID('ref.Equipment', 'U') IS NULL
BEGIN
CREATE TABLE ref.Equipment (
    EquipmentID   INT           NOT NULL CONSTRAINT PK_Equipment PRIMARY KEY,
    Equipment     NVARCHAR(255) NULL
);
END

IF OBJECT_ID('ref.EvalQuestionType', 'U') IS NULL
BEGIN
CREATE TABLE ref.EvalQuestionType (
    EvalQuestTypeID INT          NOT NULL CONSTRAINT PK_EvalQuestionType PRIMARY KEY,
    EvalQuestType   NVARCHAR(15) NULL
);
END

IF OBJECT_ID('ref.EvalType', 'U') IS NULL
BEGIN
CREATE TABLE ref.EvalType (
    -- Legacy PK is named WorkshopTypeID; renamed per plan §B.1
    EvalTypeID    INT           NOT NULL CONSTRAINT PK_EvalType PRIMARY KEY,
    WorkshopType  NVARCHAR(255) NULL
);
END

IF OBJECT_ID('ref.EventType', 'U') IS NULL
BEGIN
CREATE TABLE ref.EventType (
    EventTypeID   INT           NOT NULL CONSTRAINT PK_EventType PRIMARY KEY,
    EventType     NVARCHAR(100) NULL
);
END

IF OBJECT_ID('ref.FacilityType', 'U') IS NULL
BEGIN
CREATE TABLE ref.FacilityType (
    FacilityTypeID INT           NOT NULL CONSTRAINT PK_FacilityType PRIMARY KEY,
    FacilityType   NVARCHAR(255) NULL
);
END

IF OBJECT_ID('ref.MailingList', 'U') IS NULL
BEGIN
CREATE TABLE ref.MailingList (
    MailingListID INT           NOT NULL CONSTRAINT PK_MailingList PRIMARY KEY,
    MailingList   NVARCHAR(25)  NULL
);
END

-- Legacy table has no PK and a space in the column name; 1,091 rows but
-- only 106 distinct ZIPs, so the ZIP is NOT unique. A surrogate key is
-- added and the legacy data is preserved verbatim.
IF OBJECT_ID('ref.ZipCode', 'U') IS NULL
BEGIN
CREATE TABLE ref.ZipCode (
    ZipCodeRowID  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ZipCode PRIMARY KEY,
    ZipCode       NVARCHAR(10)  NULL,     -- legacy column named [Zip Code]
    RegionID      INT           NULL,
    City          NVARCHAR(255) NULL,
    County        NVARCHAR(255) NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ZipCode_ZipCode' AND object_id = OBJECT_ID('ref.ZipCode'))
    CREATE INDEX IX_ZipCode_ZipCode ON ref.ZipCode(ZipCode);

IF OBJECT_ID('ref.Other', 'U') IS NULL
BEGIN
CREATE TABLE ref.Other (
    OtherID       INT           NOT NULL CONSTRAINT PK_Other PRIMARY KEY,
    OtherNickname NVARCHAR(50)  NULL,
    Description   NVARCHAR(50)  NULL
);
END

IF OBJECT_ID('ref.PaymentMethod', 'U') IS NULL
BEGIN
CREATE TABLE ref.PaymentMethod (
    PaymentMethodID INT          NOT NULL CONSTRAINT PK_PaymentMethod PRIMARY KEY,
    PaymentMethod   NVARCHAR(50) NULL
);
END

IF OBJECT_ID('ref.PreferredTime', 'U') IS NULL
BEGIN
CREATE TABLE ref.PreferredTime (
    PreferredTimesID    INT           NOT NULL CONSTRAINT PK_PreferredTime PRIMARY KEY,
    PreferredTimes      NVARCHAR(25)  NULL,
    PreferredTimesNotes NVARCHAR(255) NULL
);
END

IF OBJECT_ID('ref.ReferralType', 'U') IS NULL
BEGIN
CREATE TABLE ref.ReferralType (
    ReferralTypeID INT          NOT NULL CONSTRAINT PK_ReferralType PRIMARY KEY,
    ReferralType   NVARCHAR(35) NULL,
    ReferralAbrev  NVARCHAR(10) NULL
);
END

IF OBJECT_ID('ref.Region', 'U') IS NULL
BEGIN
CREATE TABLE ref.Region (
    RegionID      INT           NOT NULL CONSTRAINT PK_Region PRIMARY KEY,
    Region        NVARCHAR(50)  NULL
);
END

IF OBJECT_ID('ref.Salutation', 'U') IS NULL
BEGIN
CREATE TABLE ref.Salutation (
    SalutationID  INT           NOT NULL CONSTRAINT PK_Salutation PRIMARY KEY,
    Salutation    NVARCHAR(50)  NULL
);
END

IF OBJECT_ID('ref.SchoolYear', 'U') IS NULL
BEGIN
CREATE TABLE ref.SchoolYear (
    SchoolYearID  INT           NOT NULL CONSTRAINT PK_SchoolYear PRIMARY KEY,  -- legacy SYID
    SchoolYear    NVARCHAR(50)  NULL,
    IsPastYear    BIT           NOT NULL CONSTRAINT DF_SchoolYear_IsPastYear DEFAULT 0,
    BeginDate     DATETIME2(0)  NULL,
    EndDate       DATETIME2(0)  NULL
);
END

IF OBJECT_ID('ref.State', 'U') IS NULL
BEGIN
CREATE TABLE ref.State (
    StateID       INT           NOT NULL CONSTRAINT PK_State PRIMARY KEY,
    State         NVARCHAR(2)   NULL
);
END

IF OBJECT_ID('ref.StreetType', 'U') IS NULL
BEGIN
CREATE TABLE ref.StreetType (
    StreetTypeID     INT          NOT NULL CONSTRAINT PK_StreetType PRIMARY KEY,
    StreetTypeName   NVARCHAR(15) NULL,
    StreetTypeAbbrev NVARCHAR(8)  NULL
);
END

IF OBJECT_ID('ref.SummaryCountType', 'U') IS NULL
BEGIN
CREATE TABLE ref.SummaryCountType (
    -- Legacy PK is named CountyTypeID; renamed per plan §B.1
    SummaryCountTypeID INT          NOT NULL CONSTRAINT PK_SummaryCountType PRIMARY KEY,
    CountType          NVARCHAR(25) NULL
);
END
GO

-- =====================================================================
--  core -- operational tables (32)

-- =====================================================================

IF OBJECT_ID('core.Agency', 'U') IS NULL
BEGIN
CREATE TABLE core.Agency (
    AgencyID           INT            NOT NULL CONSTRAINT PK_Agency PRIMARY KEY,
    WakeSitesFacilityID INT           NULL,
    CountyID           INT            NULL REFERENCES ref.County(CountyID),
    StreetTypeID       INT            NULL REFERENCES ref.StreetType(StreetTypeID),
    CityID             INT            NULL REFERENCES ref.City(CityID),
    StateID            INT            NULL REFERENCES ref.State(StateID),
    AgencyTypeID       INT            NULL REFERENCES ref.AgencyType(AgencyTypeID),
    FacilityTypeID     INT            NULL REFERENCES ref.FacilityType(FacilityTypeID),
    AgencyName         NVARCHAR(250)  NULL,
    AgencyShortName    NVARCHAR(255)  NULL,
    AgencyAddress1     NVARCHAR(255)  NULL,
    AgencyAddress2     NVARCHAR(50)   NULL,
    AgencyZip          NVARCHAR(10)   NULL,
    AgencyPhone        NVARCHAR(16)   NULL,
    AgencyFax          NVARCHAR(16)   NULL,
    AgencyEmail        NVARCHAR(50)   NULL,
    AgencyWebsite      NVARCHAR(100)  NULL,
    DirectorFirstName  NVARCHAR(50)   NULL,   -- legacy DirectorFName
    DirectorLastName   NVARCHAR(50)   NULL,   -- legacy DirectorLName
    AltContactFirstName NVARCHAR(30)  NULL,   -- legacy AltContactF
    AltContactLastName NVARCHAR(30)   NULL,   -- legacy AltContactL
    IsOutOfBusiness    BIT            NOT NULL CONSTRAINT DF_Agency_OutOfBusiness DEFAULT 0,
    SchoolCode         NVARCHAR(255)  NULL,
    Calendar           INT            NULL,
    IsWorkshopSite     BIT            NOT NULL CONSTRAINT DF_Agency_WorkshopSite DEFAULT 0,
    Notes              NVARCHAR(MAX)  NULL,   -- legacy AgencyNotes
    CreatedAt          DATETIME2(0)   NULL,
    UpdatedAt          DATETIME2(0)   NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Agency_Name' AND object_id = OBJECT_ID('core.Agency'))
    CREATE INDEX IX_Agency_Name ON core.Agency(AgencyName);

IF OBJECT_ID('core.AgencyMailAddress', 'U') IS NULL
BEGIN
CREATE TABLE core.AgencyMailAddress (
    AgencyID             INT           NOT NULL CONSTRAINT PK_AgencyMailAddress PRIMARY KEY,
    StreetTypeID         INT           NULL REFERENCES ref.StreetType(StreetTypeID),
    CityID               INT           NULL REFERENCES ref.City(CityID),
    StateID              INT           NULL REFERENCES ref.State(StateID),
    MailingAddressLine1  NVARCHAR(50)  NULL,
    MailingAddressLine2  NVARCHAR(20)  NULL,
    MailingZipCode       NVARCHAR(255) NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'FK_AgencyMailAddress_Agency' AND type IN ('F','C'))
BEGIN
ALTER TABLE core.AgencyMailAddress
    ADD CONSTRAINT FK_AgencyMailAddress_Agency FOREIGN KEY (AgencyID) REFERENCES core.Agency(AgencyID);
END

IF OBJECT_ID('core.BoardMember', 'U') IS NULL
BEGIN
CREATE TABLE core.BoardMember (
    BoardID       INT           NOT NULL CONSTRAINT PK_BoardMember PRIMARY KEY,
    AgencyID      INT           NULL,
    CityID        INT           NULL,
    StateID       INT           NULL,
    BoardFirstName NVARCHAR(15) NULL,   -- legacy BoardFName
    BoardLastName  NVARCHAR(20) NULL,   -- legacy BoardLName
    BoardTitle     NVARCHAR(25) NULL,
    BoardAddress1  NVARCHAR(100) NULL,
    BoardAddress2  NVARCHAR(35) NULL,
    BoardZip       NVARCHAR(10) NULL,
    BoardPhone     NVARCHAR(14) NULL,
    BoardEmail     NVARCHAR(255) NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'FK_BoardMember_Agency' AND type IN ('F','C'))
BEGIN
ALTER TABLE core.BoardMember
    ADD CONSTRAINT FK_BoardMember_Agency FOREIGN KEY (AgencyID) REFERENCES core.Agency(AgencyID);
END

IF OBJECT_ID('core.Participant', 'U') IS NULL
BEGIN
CREATE TABLE core.Participant (
    ParticipantID      INT           NOT NULL CONSTRAINT PK_Participant PRIMARY KEY,
    WebID              INT           NULL,
    SalutationID       INT           NULL REFERENCES ref.Salutation(SalutationID),
    AgencyID           INT           NULL REFERENCES core.Agency(AgencyID),  -- 5,353 NULLs are legitimate
    StreetTypeID       INT           NULL REFERENCES ref.StreetType(StreetTypeID),
    CityID             INT           NULL REFERENCES ref.City(CityID),
    StateID            INT           NULL REFERENCES ref.State(StateID),
    FirstName          NVARCHAR(30)  NULL,   -- legacy FName
    LastName           NVARCHAR(30)  NULL,   -- legacy LName
    MiddleName         NVARCHAR(20)  NULL,   -- legacy MName
    HomePhone          NVARCHAR(15)  NULL,
    HomeFax            NVARCHAR(15)  NULL,
    WorkPhone          NVARCHAR(15)  NULL,   -- legacy WorkPhoneOpt
    WorkPhoneExt       NVARCHAR(6)   NULL,
    HomeAddress1       NVARCHAR(200) NULL,
    HomeAddress2       NVARCHAR(50)  NULL,
    HomeZip            NVARCHAR(10)  NULL,
    Email              NVARCHAR(100) NULL,   -- legacy ParticipantEmail
    Email2             NVARCHAR(100) NULL,
    Email3             NVARCHAR(255) NULL,
    Position           NVARCHAR(255) NULL,
    GradeLevel         NVARCHAR(255) NULL,   -- legacy GradeLvl
    IsParentMailingList   BIT NOT NULL CONSTRAINT DF_Participant_ParentList   DEFAULT 0, -- legacy [ParentMailingList?]
    IsTeacherMailingList  BIT NOT NULL CONSTRAINT DF_Participant_TeacherList  DEFAULT 0, -- legacy [TeacherMailingList?]
    IsDirectorMailingList BIT NOT NULL CONSTRAINT DF_Participant_DirectorList DEFAULT 0, -- legacy [DirectorMailingList?]
    IsStaff            BIT NOT NULL CONSTRAINT DF_Participant_Staff      DEFAULT 0,      -- legacy [Staff?]
    IsWcpss            BIT NOT NULL CONSTRAINT DF_Participant_Wcpss      DEFAULT 0,      -- legacy [WCPSS?]
    HasCeuCertificate  BIT NOT NULL CONSTRAINT DF_Participant_CeuCert    DEFAULT 0,      -- legacy CEUCertificate
    HasChcCertificate  BIT NOT NULL CONSTRAINT DF_Participant_ChcCert    DEFAULT 0,      -- legacy CHCCertificate
    DateOfEntry        DATETIME2(0)  NULL,
    UpdatedAt          DATETIME2(0)  NULL    -- legacy DateUpdated
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Participant_LastName' AND object_id = OBJECT_ID('core.Participant'))
    CREATE INDEX IX_Participant_LastName ON core.Participant(LastName, FirstName);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Participant_Email' AND object_id = OBJECT_ID('core.Participant'))
    CREATE INDEX IX_Participant_Email ON core.Participant(Email); -- non-unique: 962 duplicate groups
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Participant_Agency' AND object_id = OBJECT_ID('core.Participant'))
    CREATE INDEX IX_Participant_Agency ON core.Participant(AgencyID);

IF OBJECT_ID('core.Payee', 'U') IS NULL
BEGIN
CREATE TABLE core.Payee (
    PayeeID  INT           NOT NULL CONSTRAINT PK_Payee PRIMARY KEY,
    Payee    NVARCHAR(255) NULL,
    IsDeleted BIT NOT NULL CONSTRAINT DF_Payee_Deleted DEFAULT 0   -- legacy [Delete]
);
END

IF OBJECT_ID('core.Payment', 'U') IS NULL
BEGIN
CREATE TABLE core.Payment (
    PaymentID       INT            NOT NULL CONSTRAINT PK_Payment PRIMARY KEY,
    PaymentMethodID INT            NULL REFERENCES ref.PaymentMethod(PaymentMethodID),
    PayeeID         INT            NULL REFERENCES core.Payee(PayeeID),
    SchoolYearID    INT            NULL REFERENCES ref.SchoolYear(SchoolYearID),
    CheckNumber     INT            NULL,
    ReceiptNumber   INT            NULL,
    PaymentTotal    DECIMAL(19,4)  NULL,
    PaidDate        DATETIME2(0)   NULL,
    Notes           NVARCHAR(255)  NULL    -- legacy PaymentNotes
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Payment_Payee' AND object_id = OBJECT_ID('core.Payment'))
    CREATE INDEX IX_Payment_Payee ON core.Payment(PayeeID);

IF OBJECT_ID('core.WorkshopName', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopName (
    WorkshopNameID    INT           NOT NULL CONSTRAINT PK_WorkshopName PRIMARY KEY,
    AgesID            INT           NULL REFERENCES ref.Age(AgesID),
    WorkshopName      NVARCHAR(255) NULL,
    ShortName         NVARCHAR(100) NULL,   -- legacy WorkshopShortName
    ECourseNum        INT           NULL,   -- legacy E_CourseNum
    WLCourse          INT           NULL,
    Prerequisites     NVARCHAR(255) NULL,
    Description       NVARCHAR(MAX) NULL,
    TopicNums         NVARCHAR(15)  NULL,
    IsLiteracy        BIT NOT NULL CONSTRAINT DF_WorkshopName_Literacy DEFAULT 0  -- legacy Literacy
);
END

IF OBJECT_ID('core.Workshop', 'U') IS NULL
BEGIN
CREATE TABLE core.Workshop (
    WorkshopID        INT            NOT NULL CONSTRAINT PK_Workshop PRIMARY KEY,
    LegacyWorkshopID  INT            NULL,   -- legacy WorkshopID_Old (1,438 populated, unique)
    WorkshopNameID    INT            NULL REFERENCES core.WorkshopName(WorkshopNameID),
    EvalTypeID        INT            NULL REFERENCES ref.EvalType(EvalTypeID),
    ComponentID       INT            NULL REFERENCES ref.Component(ComponentID),  -- legacy ComponenetID (typo)
    CategoryID        INT            NULL REFERENCES ref.Category(CategoryID),
    AgencyID          INT            NULL REFERENCES core.Agency(AgencyID),
    SchoolYearID      INT            NULL REFERENCES ref.SchoolYear(SchoolYearID), -- legacy SYID
    TorP              INT            NULL,
    VorIP             INT            NULL,   -- legacy VorIP
    WorkshopCode      NVARCHAR(10)   NULL,
    ESessionNum       INT            NULL,   -- legacy E_SessionNum
    WLSession         INT            NULL,
    StartDate         DATETIME2(0)   NULL,
    EndDate           DATETIME2(0)   NULL,
    StartTime         TIME(0)        NULL,   -- legacy 1899-12-30 datetime
    EndTime           TIME(0)        NULL,
    DatesText         NVARCHAR(125)  NULL,   -- legacy [Dates]
    TimesText         NVARCHAR(100)  NULL,   -- legacy [Times]
    MaxEnrollment     INT            NULL,   -- legacy [Max]
    MinEnrollment     INT            NULL,   -- legacy [Min]
    ESchoolSeats      INT            NULL,
    Room              SMALLINT       NULL,
    IsBrochure        BIT NOT NULL CONSTRAINT DF_Workshop_Brochure   DEFAULT 0, -- legacy Brochure
    IsFolder          BIT NOT NULL CONSTRAINT DF_Workshop_Folder     DEFAULT 0, -- legacy Folder
    IsLabel           BIT NOT NULL CONSTRAINT DF_Workshop_Label      DEFAULT 0, -- legacy Label
    IsClosed          BIT NOT NULL CONSTRAINT DF_Workshop_Closed     DEFAULT 0, -- legacy Closed
    IsCancelled       BIT NOT NULL CONSTRAINT DF_Workshop_Cancelled  DEFAULT 0, -- legacy Cancelled
    IsContracted      BIT NOT NULL CONSTRAINT DF_Workshop_Contracted DEFAULT 0, -- legacy Contracted
    IsWcpc            BIT NOT NULL CONSTRAINT DF_Workshop_Wcpc       DEFAULT 0, -- legacy WCPC
    IsStaffDev        BIT NOT NULL CONSTRAINT DF_Workshop_StaffDev   DEFAULT 0, -- legacy StaffDev
    ConsultFee        DECIMAL(19,4)  NULL,
    Cost1             DECIMAL(19,4)  NULL,
    Cost2             DECIMAL(19,4)  NULL,
    CreditPossible    NVARCHAR(50)   NULL,
    SessionCount      INT            NULL,   -- legacy [Sessions]
    SessionHours      DECIMAL(18,2)  NULL,   -- legacy SessionHrs (max 55.00); plan §B.1 said FLOAT
    SessionCeus       DECIMAL(6,2)   NULL,   -- legacy SessionCEUs (Single); migration 007 widened from REAL
    ESchoolRegistered SMALLINT       NULL,
    ESchoolAttended   INT            NULL,   -- legacy eSchoolAttend
    ESchoolDropped    SMALLINT       NULL,
    ESchoolLateDropped INT           NULL,
    ESchoolNoShow     INT            NULL,
    EvaluationCount   SMALLINT       NULL,   -- legacy Evaluations
    NumPractices      SMALLINT       NULL,
    -- Legacy Virtual/In-Person are INT with 12 and 17 distinct values (0..14).
    -- They are NOT booleans in the data, so they are preserved as INT rather
    -- than converted to BIT as the plan proposed. See completion note.
    Virtual           INT            NULL,
    IsInPerson        INT            NULL,   -- legacy [In-Person]
    InternetYes       SMALLINT       NULL,
    InternetNo        SMALLINT       NULL,
    PublicRegistrations INT          NULL,
    -- Legacy TotalRegistrations/TotalParticipants are stored DOUBLEs that drift.
    -- Deliberately NOT migrated; replaced by core.vw_WorkshopCounts.
    Notes             NVARCHAR(MAX)  NULL,   -- legacy WorkshopNotes
    SpecialNotes      NVARCHAR(MAX)  NULL,
    IsFullyCodified   BIT NOT NULL CONSTRAINT DF_Workshop_FullyCodified DEFAULT 0, -- legacy FullyCodified
    CreatedAt         DATETIME2(0)   NULL,   -- legacy DateCreated
    UpdatedAt         DATETIME2(0)   NULL    -- legacy DateUpdated
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Workshop_SchoolYear_Start' AND object_id = OBJECT_ID('core.Workshop'))
    CREATE INDEX IX_Workshop_SchoolYear_Start ON core.Workshop(SchoolYearID, StartDate);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Workshop_Code' AND object_id = OBJECT_ID('core.Workshop'))
    CREATE INDEX IX_Workshop_Code ON core.Workshop(WorkshopCode);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Workshop_WorkshopName' AND object_id = OBJECT_ID('core.Workshop'))
    CREATE INDEX IX_Workshop_WorkshopName ON core.Workshop(WorkshopNameID);
-- NOTE: CK_Workshop_Dates is intentionally NOT added yet -- 9 legacy rows have
-- StartDate > EndDate. Add it after those rows are corrected during ETL.
GO

IF OBJECT_ID('core.WorkshopSession', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopSession (
    WorkshopSessionID INT           NOT NULL CONSTRAINT PK_WorkshopSession PRIMARY KEY,
    WorkshopID        INT           NULL REFERENCES core.Workshop(WorkshopID),
    StaffID           INT           NULL,
    BackUpTimeID      INT           NULL REFERENCES ref.BackupTime(BackupTimeID),
    SessionDate       DATETIME2(0)  NULL,
    RegAttend         INT           NULL,
    ESchoolAttend     INT           NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_WorkshopSession_Workshop' AND object_id = OBJECT_ID('core.WorkshopSession'))
    CREATE INDEX IX_WorkshopSession_Workshop ON core.WorkshopSession(WorkshopID);

IF OBJECT_ID('core.PresenterStaff', 'U') IS NULL
BEGIN
CREATE TABLE core.PresenterStaff (
    PresenterStaffID   INT           NOT NULL CONSTRAINT PK_PresenterStaff PRIMARY KEY,
    SalutationID       INT           NULL REFERENCES ref.Salutation(SalutationID),
    AgencyID           INT           NULL REFERENCES core.Agency(AgencyID),
    CityID             INT           NULL REFERENCES ref.City(CityID),
    StateID            INT           NULL REFERENCES ref.State(StateID),
    LastName           NVARCHAR(30)  NULL,   -- legacy StaffLName
    FirstName          NVARCHAR(30)  NULL,   -- legacy StaffFName
    MiddleName         NVARCHAR(20)  NULL,   -- legacy StaffMName
    WorkPhone          NVARCHAR(14)  NULL,   -- legacy StaffWPhone
    Extension          INT           NULL,   -- legacy StaffExtension
    HomePhone          NVARCHAR(15)  NULL,   -- legacy StaffHPhone
    CellPhone          NVARCHAR(14)  NULL,   -- legacy StaffCPhone
    HomeEmail          NVARCHAR(50)  NULL,   -- legacy StaffHEmail
    Address            NVARCHAR(200) NULL,   -- legacy StaffAddress
    Zip                NVARCHAR(10)  NULL,   -- legacy StaffZip
    IsRetired          BIT NOT NULL CONSTRAINT DF_PresenterStaff_Retired DEFAULT 0, -- legacy Retired
    DateOfEntry        DATETIME2(0)  NULL,   -- legacy StaffDateOfEntry
    UpdatedAt          DATETIME2(0)  NULL    -- legacy PresenterDateUpdated
);
END

IF OBJECT_ID('core.WorkshopPresenter', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopPresenter (
    WorkshopPresenterID INT NOT NULL CONSTRAINT PK_WorkshopPresenter PRIMARY KEY,
    PresenterID         INT NULL REFERENCES core.PresenterStaff(PresenterStaffID),
    WorkshopID          INT NULL REFERENCES core.Workshop(WorkshopID)
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_WorkshopPresenter_Workshop' AND object_id = OBJECT_ID('core.WorkshopPresenter'))
    CREATE INDEX IX_WorkshopPresenter_Workshop ON core.WorkshopPresenter(WorkshopID);

IF OBJECT_ID('core.Registration', 'U') IS NULL
BEGIN
CREATE TABLE core.Registration (
    RegistrationID     INT            NOT NULL CONSTRAINT PK_Registration PRIMARY KEY,
    ParticipantID      INT            NULL,   -- FK added after orphan quarantine
    CreditTypeID       INT            NULL REFERENCES ref.CreditType(CreditTypeID),
    WorkshopID         INT            NULL,   -- FK added after orphan quarantine
    PaymentID          INT            NULL REFERENCES core.Payment(PaymentID),
    PaymentMethodID    INT            NULL REFERENCES ref.PaymentMethod(PaymentMethodID),
    PaidAmount         DECIMAL(19,4)  NULL,   -- legacy PaidAmt; 189 negative rows (refunds)
    TicketCount        INT            NULL,   -- legacy Tickets
    IsScholarship      BIT NOT NULL CONSTRAINT DF_Registration_Scholarship DEFAULT 0, -- legacy Scholarship
    RegistrationDate   DATETIME2(0)   NULL,
    IsCancelled        BIT NOT NULL CONSTRAINT DF_Registration_Cancelled   DEFAULT 0, -- legacy Cancellation
    Notes              NVARCHAR(255)  NULL,   -- legacy RegistrationNotes
    EmailConfirmation  BIT NOT NULL CONSTRAINT DF_Registration_EmailConf   DEFAULT 0,
    PayeeID            INT            NULL REFERENCES core.Payee(PayeeID),
    ReceiptNumber      INT            NULL,   -- legacy [Receipt#]
    CheckNumber        INT            NULL,
    CheckTotal         DECIMAL(19,4)  NULL,
    PaidDate           DATETIME2(0)   NULL,
    Attended           BIT NOT NULL CONSTRAINT DF_Registration_Attended    DEFAULT 0,
    UpdatedAt          DATETIME2(0)   NULL,   -- legacy RegistrationUpdated
    -- Provenance for the public registration form (see docs/features/public-registration.md)
    Source             NVARCHAR(20)   NOT NULL CONSTRAINT DF_Registration_Source DEFAULT 'Manual',
    RegistrationLinkID INT            NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Registration_Workshop' AND object_id = OBJECT_ID('core.Registration'))
    CREATE INDEX IX_Registration_Workshop ON core.Registration(WorkshopID);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Registration_Participant' AND object_id = OBJECT_ID('core.Registration'))
    CREATE INDEX IX_Registration_Participant ON core.Registration(ParticipantID);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Registration_Payment' AND object_id = OBJECT_ID('core.Registration'))
    CREATE INDEX IX_Registration_Payment ON core.Registration(PaymentID);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Registration_Source' AND object_id = OBJECT_ID('core.Registration'))
    CREATE INDEX IX_Registration_Source ON core.Registration(Source);

IF OBJECT_ID('core.SessionParticipant', 'U') IS NULL
BEGIN
CREATE TABLE core.SessionParticipant (
    ParticipantID     INT NOT NULL,
    WorkshopSessionID INT NOT NULL,
    IsLate            BIT NOT NULL CONSTRAINT DF_SessionParticipant_Late DEFAULT 0, -- legacy Late
    CONSTRAINT PK_SessionParticipant PRIMARY KEY (ParticipantID, WorkshopSessionID)
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SessionParticipant_Session' AND object_id = OBJECT_ID('core.SessionParticipant'))
    CREATE INDEX IX_SessionParticipant_Session ON core.SessionParticipant(WorkshopSessionID);

IF OBJECT_ID('core.CreditSlip', 'U') IS NULL
BEGIN
CREATE TABLE core.CreditSlip (
    CreditSlipID          INT           NOT NULL CONSTRAINT PK_CreditSlip PRIMARY KEY,
    CreditSlipsCategoryID INT           NULL REFERENCES ref.CreditSlipCategory(CreditSlipsCategoryID),
    ParticipantID         INT           NULL REFERENCES core.Participant(ParticipantID),
    WorkshopID            INT           NULL REFERENCES core.Workshop(WorkshopID),
    DateIssued            DATETIME2(0)  NULL,
    DateUsed              DATETIME2(0)  NULL,
    UsedWorkshopID        INT           NULL REFERENCES core.Workshop(WorkshopID),
    UsedParticipantID     INT           NULL REFERENCES core.Participant(ParticipantID),
    Amount                DECIMAL(19,4) NULL,
    TrackingYear          INT           NULL,
    Email                 BIT NOT NULL CONSTRAINT DF_CreditSlip_Email DEFAULT 0
);
END

IF OBJECT_ID('core.EvalQuestion', 'U') IS NULL
BEGIN
CREATE TABLE core.EvalQuestion (
    EvalQuestID       INT           NOT NULL CONSTRAINT PK_EvalQuestion PRIMARY KEY,
    EvaluationTypeID  INT           NULL REFERENCES ref.EvalType(EvalTypeID),
    EvalQuestTypeID   INT           NULL REFERENCES ref.EvalQuestionType(EvalQuestTypeID),
    EvalQuestion      NVARCHAR(255) NULL,
    EvalQuestNum      INT           NULL,
    IsActive          BIT NOT NULL CONSTRAINT DF_EvalQuestion_Active DEFAULT 1
);
END

IF OBJECT_ID('core.WorkshopEvalQuestion', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopEvalQuestion (
    -- Legacy PK is named WorkshopEvaluations; renamed per plan §B.1.
    -- It is genuinely unique (3,540/3,540), so it is a real surrogate key.
    WorkshopEvaluationID INT NOT NULL CONSTRAINT PK_WorkshopEvalQuestion PRIMARY KEY,
    WorkshopID           INT NULL REFERENCES core.Workshop(WorkshopID),
    EvalQuestID          INT NULL REFERENCES core.EvalQuestion(EvalQuestID),
    WorkshopEvalRating   INT NULL,
    WorkshopEvalQty      INT NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_WorkshopEvalQuestion_Workshop' AND object_id = OBJECT_ID('core.WorkshopEvalQuestion'))
    CREATE INDEX IX_WorkshopEvalQuestion_Workshop ON core.WorkshopEvalQuestion(WorkshopID);

IF OBJECT_ID('core.WorkshopComment', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopComment (
    WorkshopCommentID INT           NOT NULL CONSTRAINT PK_WorkshopComment PRIMARY KEY,
    WorkshopID        INT           NULL REFERENCES core.Workshop(WorkshopID),
    Comment           NVARCHAR(MAX) NULL
);
END

IF OBJECT_ID('core.WorkshopPresenterComment', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopPresenterComment (
    WorkshopPresenterCommentID INT           NOT NULL CONSTRAINT PK_WorkshopPresenterComment PRIMARY KEY,
    WorkshopID                 INT           NULL REFERENCES core.Workshop(WorkshopID),
    PresenterComment           NVARCHAR(255) NULL
);
END

IF OBJECT_ID('core.WorkshopDesiredTopic', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopDesiredTopic (
    WorkshopDesiredTopicsID INT           NOT NULL CONSTRAINT PK_WorkshopDesiredTopic PRIMARY KEY,
    WorkshopID              INT           NULL REFERENCES core.Workshop(WorkshopID),
    DesiredTopicCategoryID  INT           NULL REFERENCES ref.DesiredTopicCategory(DesiredTopicCategoryID),
    WorkshopDesiredTopics   NVARCHAR(255) NULL
);
END

IF OBJECT_ID('core.WorkshopPreferredTime', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopPreferredTime (
    WorkshopPreferredTime    INT NOT NULL CONSTRAINT PK_WorkshopPreferredTime PRIMARY KEY, -- legacy WorkshopPreferredTime
    WorkshopID               INT NULL REFERENCES core.Workshop(WorkshopID),
    PreferredTimeID          INT NULL REFERENCES ref.PreferredTime(PreferredTimesID),
    WorkshopPreferredTimeQty INT NULL
);
END

IF OBJECT_ID('core.WorkshopReferral', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopReferral (
    WorkshopReferralID INT           NOT NULL CONSTRAINT PK_WorkshopReferral PRIMARY KEY,
    WorkshopID         INT           NULL REFERENCES core.Workshop(WorkshopID),
    ReferralTypeID     INT           NULL REFERENCES ref.ReferralType(ReferralTypeID),
    ReferralNum        INT           NULL,
    ReferralNotes      NVARCHAR(255) NULL
);
END

IF OBJECT_ID('core.WorkshopLikedMost', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopLikedMost (
    LikedMostID INT           NOT NULL CONSTRAINT PK_WorkshopLikedMost PRIMARY KEY,
    WorkshopID  INT           NULL REFERENCES core.Workshop(WorkshopID),
    LikedMost   NVARCHAR(255) NULL
);
END

IF OBJECT_ID('core.WorkshopLikedLeast', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopLikedLeast (
    LikedLeastID INT           NOT NULL CONSTRAINT PK_WorkshopLikedLeast PRIMARY KEY,
    WorkshopID   INT           NULL REFERENCES core.Workshop(WorkshopID),
    LikedLeast   NVARCHAR(255) NULL
);
END

IF OBJECT_ID('core.WorkshopPractice', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopPractice (
    WorkshopsPracticesID INT           NOT NULL CONSTRAINT PK_WorkshopPractice PRIMARY KEY,
    WorkshopID           INT           NULL REFERENCES core.Workshop(WorkshopID),
    WorkshopPractice     NVARCHAR(255) NULL
);
END

IF OBJECT_ID('core.WorkshopSummaryCount', 'U') IS NULL
BEGIN
CREATE TABLE core.WorkshopSummaryCount (
    WorkshopSummaryCountsID INT NOT NULL CONSTRAINT PK_WorkshopSummaryCount PRIMARY KEY,
    WorkshopID              INT NULL REFERENCES core.Workshop(WorkshopID),
    CountTypeID             INT NULL REFERENCES ref.SummaryCountType(SummaryCountTypeID),
    [Count]                 INT NULL,
    CountSessionNum         SMALLINT NULL
);
END

IF OBJECT_ID('core.OtherCount', 'U') IS NULL
BEGIN
CREATE TABLE core.OtherCount (
    OtherCountID INT NOT NULL CONSTRAINT PK_OtherCount PRIMARY KEY,
    OtherID      INT NULL REFERENCES ref.Other(OtherID),
    WorkshopID   INT NULL REFERENCES core.Workshop(WorkshopID),
    NumberParents INT NULL
);
END

IF OBJECT_ID('core.CommunityEvent', 'U') IS NULL
BEGIN
CREATE TABLE core.CommunityEvent (
    EventID         INT           NOT NULL CONSTRAINT PK_CommunityEvent PRIMARY KEY,
    ComponentID     INT           NULL REFERENCES ref.Component(ComponentID),
    EventTypeID     INT           NULL REFERENCES ref.EventType(EventTypeID),
    EventTitle      NVARCHAR(255) NULL,
    EventType       NVARCHAR(100) NULL,   -- denormalised text copy, retained
    EventLocation   NVARCHAR(100) NULL,
    EventDate       DATETIME2(0)  NULL,
    EventTimes      NVARCHAR(25)  NULL,
    EventAttendees  SMALLINT      NULL,
    NumAdults       SMALLINT      NULL,
    NumChildren     SMALLINT      NULL,
    NumTeachers     SMALLINT      NULL,
    EventDateEntered DATETIME2(0) NULL
);
END

IF OBJECT_ID('core.CommunityEventStaff', 'U') IS NULL
BEGIN
CREATE TABLE core.CommunityEventStaff (
    EventID  INT NOT NULL REFERENCES core.CommunityEvent(EventID),
    StaffID  INT NOT NULL,
    CONSTRAINT PK_CommunityEventStaff PRIMARY KEY (EventID, StaffID)  -- 620/620 unique
);
END

IF OBJECT_ID('core.TrainingRequest', 'U') IS NULL
BEGIN
CREATE TABLE core.TrainingRequest (
    TrainingRequestID INT            NOT NULL CONSTRAINT PK_TrainingRequest PRIMARY KEY,
    AgencyID          INT            NULL REFERENCES core.Agency(AgencyID),
    RequestDate       DATETIME2(0)   NULL,
    RequestedBy       NVARCHAR(100)  NULL,
    RequestPhone      NVARCHAR(14)   NULL,
    RequestExt        INT            NULL,
    RequestEmail      NVARCHAR(100)  NULL,
    -- Legacy NumParticpants (typo) is NVARCHAR(255). Kept as text per plan §B.1
    -- until the values are reviewed; rename applied, type not yet changed.
    ParticipantCount  NVARCHAR(255)  NULL,
    InvoiceNum        NVARCHAR(10)   NULL,
    InvoiceDate       DATETIME2(0)   NULL,
    DueDate           DATETIME2(0)   NULL,
    AmtDue            DECIMAL(19,4)  NULL,
    IsActive          BIT NOT NULL CONSTRAINT DF_TrainingRequest_Active DEFAULT 1
);
END

IF OBJECT_ID('core.TrainingRequestContact', 'U') IS NULL
BEGIN
CREATE TABLE core.TrainingRequestContact (
    TrainingRequestContactID INT           NOT NULL CONSTRAINT PK_TrainingRequestContact PRIMARY KEY,
    TrainingRequestID        INT           NULL REFERENCES core.TrainingRequest(TrainingRequestID),
    ContactDate              DATETIME2(0)  NULL,
    Note                     NVARCHAR(MAX) NULL
);
END

IF OBJECT_ID('core.TrainingRequestQuote', 'U') IS NULL
BEGIN
CREATE TABLE core.TrainingRequestQuote (
    TrainingRequestQuoteID INT           NOT NULL CONSTRAINT PK_TrainingRequestQuote PRIMARY KEY,
    TrainingRequestID      INT           NULL REFERENCES core.TrainingRequest(TrainingRequestID),
    WorkshopTypeID         INT           NULL REFERENCES ref.EvalType(EvalTypeID),
    TopicRequested         NVARCHAR(255) NULL,
    Location               NVARCHAR(255) NULL,
    NumStudents            NVARCHAR(10)  NULL,
    NumSessions            INT           NULL,
    DatesRequested         NVARCHAR(25)  NULL,
    TimesRequested         NVARCHAR(25)  NULL,
    Duration               NVARCHAR(25)  NULL,
    SpecialEquip           NVARCHAR(255) NULL,
    RequestAmt             DECIMAL(19,4) NULL
);
END

IF OBJECT_ID('core.TrainingRequestScheduled', 'U') IS NULL
BEGIN
CREATE TABLE core.TrainingRequestScheduled (
    TrainingRequestID INT           NULL REFERENCES core.TrainingRequest(TrainingRequestID),
    WorkshopID        INT           NULL REFERENCES core.Workshop(WorkshopID),
    ScheduledOn       DATETIME2(0)  NULL
);
END
-- 84 rows / 81 distinct (TrainingRequestID, WorkshopID): 3 duplicates exist.
-- No PK is declared; the ETL must resolve them first.

IF OBJECT_ID('core.TrainingRequestPayment', 'U') IS NULL
BEGIN
CREATE TABLE core.TrainingRequestPayment (
    TrainingRequestID INT NOT NULL REFERENCES core.TrainingRequest(TrainingRequestID),
    PaymentID         INT NOT NULL REFERENCES core.Payment(PaymentID),
    CONSTRAINT PK_TrainingRequestPayment PRIMARY KEY (TrainingRequestID, PaymentID)
);
END

-- Certificate template settings, staff-editable per school year.
-- See plan §8.6. Versioned by year so reissued certificates keep the
-- logo and signatories they were issued with.
IF OBJECT_ID('core.CertificateTemplate', 'U') IS NULL
BEGIN
CREATE TABLE core.CertificateTemplate (
    CertificateTemplateID  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_CertificateTemplate PRIMARY KEY,
    SchoolYearID           INT           NOT NULL REFERENCES ref.SchoolYear(SchoolYearID),
    CertificateType        NVARCHAR(10)  NOT NULL,   -- 'CEU' | 'CHC'
    Title                  NVARCHAR(200) NULL,
    Subtitle               NVARCHAR(500) NULL,
    LogoPath               NVARCHAR(400) NULL,
    ProgramDirectorName    NVARCHAR(100) NULL,
    ProgramDirectorTitle   NVARCHAR(100) NULL,
    ApprovingDirectorName  NVARCHAR(100) NULL,
    ApprovingDirectorTitle NVARCHAR(100) NULL,
    CreditUnitLabel        NVARCHAR(100) NULL,
    FooterText             NVARCHAR(500) NULL,
    VisibleFields          NVARCHAR(MAX) NULL,       -- JSON array of field keys
    UpdatedBy              NVARCHAR(100) NULL,
    UpdatedAt              DATETIME2(0)  NOT NULL CONSTRAINT DF_CertificateTemplate_UpdatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_CertificateTemplate UNIQUE (SchoolYearID, CertificateType),
    CONSTRAINT CK_CertificateTemplate_Type CHECK (CertificateType IN ('CEU','CHC'))
);
END
GO

-- =====================================================================
--  Certificates: image assets, per-participant overrides, issued PDFs
--  See docs/features/certificates.md and db/migrations/003-certificates.sql
--  Images live in SQL Server because Azure SQL has no FILESTREAM.
-- =====================================================================
IF OBJECT_ID('core.CertificateAsset', 'U') IS NULL
BEGIN
CREATE TABLE core.CertificateAsset (
    CertificateAssetID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_CertificateAsset PRIMARY KEY,
    AssetKind          NVARCHAR(30)  NOT NULL,       -- 'template-logo' | 'participant-image'
    FileName           NVARCHAR(260) NULL,
    ContentType        NVARCHAR(100) NOT NULL,
    ByteSize           INT           NOT NULL,
    Sha256             BINARY(32)    NOT NULL,
    Content            VARBINARY(MAX) NOT NULL,
    UploadedBy         NVARCHAR(200) NULL,
    UploadedAt         DATETIME2(0)  NOT NULL CONSTRAINT DF_CertificateAsset_UploadedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_CertificateAsset_Kind CHECK (AssetKind IN ('template-logo','participant-image')),
    CONSTRAINT CK_CertificateAsset_Size CHECK (ByteSize > 0 AND ByteSize <= 2097152)
);
CREATE INDEX IX_CertificateAsset_Sha256 ON core.CertificateAsset (Sha256);
END
GO

IF COL_LENGTH('core.CertificateTemplate', 'LogoAssetID') IS NULL
    ALTER TABLE core.CertificateTemplate
        ADD LogoAssetID INT NULL
            CONSTRAINT FK_CertificateTemplate_Logo
            REFERENCES core.CertificateAsset (CertificateAssetID);
GO

IF COL_LENGTH('core.CertificateTemplate', 'SecondaryLogoAssetID') IS NULL
    ALTER TABLE core.CertificateTemplate
        ADD SecondaryLogoAssetID INT NULL
            CONSTRAINT FK_CertificateTemplate_SecondaryLogo
            REFERENCES core.CertificateAsset (CertificateAssetID);
GO

-- Portrait (8.5x11) or landscape (11x8.5). See db/migrations/004.
IF COL_LENGTH('core.CertificateTemplate', 'Layout') IS NULL
    ALTER TABLE core.CertificateTemplate
        ADD Layout NVARCHAR(10) NOT NULL
            CONSTRAINT DF_CertificateTemplate_Layout DEFAULT 'portrait';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_CertificateTemplate_Layout'
       AND parent_object_id = OBJECT_ID('core.CertificateTemplate')
)
    ALTER TABLE core.CertificateTemplate
        ADD CONSTRAINT CK_CertificateTemplate_Layout
        CHECK (Layout IN ('portrait', 'landscape'));
GO

IF OBJECT_ID('core.CertificateOverride', 'U') IS NULL
BEGIN
CREATE TABLE core.CertificateOverride (
    CertificateOverrideID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_CertificateOverride PRIMARY KEY,
    ParticipantID         INT           NOT NULL REFERENCES core.Participant(ParticipantID),
    SchoolYearID          INT           NOT NULL REFERENCES ref.SchoolYear(SchoolYearID),
    CertificateType       NVARCHAR(10)  NOT NULL,   -- 'CEU' | 'CHC'
    CustomText            NVARCHAR(500) NULL,
    CustomTextLabel       NVARCHAR(100) NULL,
    ImageAssetID          INT           NULL REFERENCES core.CertificateAsset(CertificateAssetID),
    ImageAltText          NVARCHAR(200) NULL,
    ImagePlacement        NVARCHAR(20)  NULL,       -- 'header' | 'body' | 'footer'
    UpdatedBy             NVARCHAR(200) NULL,
    UpdatedAt             DATETIME2(0)  NOT NULL CONSTRAINT DF_CertificateOverride_UpdatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_CertificateOverride UNIQUE (ParticipantID, SchoolYearID, CertificateType),
    CONSTRAINT CK_CertificateOverride_Type CHECK (CertificateType IN ('CEU','CHC')),
    CONSTRAINT CK_CertificateOverride_Placement
        CHECK (ImagePlacement IS NULL OR ImagePlacement IN ('header','body','footer')),
    -- An image without alt text is an accessibility defect; refuse it here
    -- rather than trusting the API to check.
    CONSTRAINT CK_CertificateOverride_AltText
        CHECK (ImageAssetID IS NULL OR (ImageAltText IS NOT NULL AND LEN(LTRIM(ImageAltText)) > 0))
);
END
GO

IF OBJECT_ID('core.CertificateIssue', 'U') IS NULL
BEGIN
CREATE TABLE core.CertificateIssue (
    CertificateIssueID    INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_CertificateIssue PRIMARY KEY,
    ParticipantID         INT           NOT NULL REFERENCES core.Participant(ParticipantID),
    SchoolYearID          INT           NOT NULL REFERENCES ref.SchoolYear(SchoolYearID),
    CertificateType       NVARCHAR(10)  NOT NULL,
    SnapshotJson          NVARCHAR(MAX) NOT NULL,   -- template + data at issue time
    PdfContent            VARBINARY(MAX) NULL,
    PdfByteSize           INT           NULL,
    TotalHours            DECIMAL(9,2)  NULL,
    TotalCeus             DECIMAL(9,2)  NULL,
    IssuedBy              NVARCHAR(200) NULL,
    IssuedAt              DATETIME2(0)  NOT NULL CONSTRAINT DF_CertificateIssue_IssuedAt DEFAULT SYSUTCDATETIME(),
    SupersededAt          DATETIME2(0)  NULL,
    CONSTRAINT CK_CertificateIssue_Type CHECK (CertificateType IN ('CEU','CHC'))
);
CREATE INDEX IX_CertificateIssue_Lookup
    ON core.CertificateIssue (ParticipantID, SchoolYearID, CertificateType);
END
GO

-- The legacy "Late" rule that sqryCEUCertificates applied.
IF COL_LENGTH('core.Registration', 'IsLate') IS NULL
    ALTER TABLE core.Registration
        ADD IsLate BIT NOT NULL CONSTRAINT DF_Registration_IsLate DEFAULT 0;
GO

-- Who can be issued a certificate: ports sqryCEUCertificates.
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

-- =====================================================================
--  audit -- change tracking and public-form submissions

-- =====================================================================

IF OBJECT_ID('audit.ChangeLog', 'U') IS NULL
BEGIN
CREATE TABLE audit.ChangeLog (
    ChangeLogID  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ChangeLog PRIMARY KEY,
    SchemaName   NVARCHAR(128) NOT NULL,
    TableName    NVARCHAR(128) NOT NULL,
    RecordID     NVARCHAR(100) NULL,
    Action       CHAR(1)       NOT NULL,   -- I / U / D
    ChangedBy    NVARCHAR(128) NULL,
    ChangedAt    DATETIME2(0)  NOT NULL CONSTRAINT DF_ChangeLog_ChangedAt DEFAULT SYSUTCDATETIME(),
    OldValues    NVARCHAR(MAX) NULL,
    NewValues    NVARCHAR(MAX) NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ChangeLog_Table_Record' AND object_id = OBJECT_ID('audit.ChangeLog'))
    CREATE INDEX IX_ChangeLog_Table_Record ON audit.ChangeLog(TableName, RecordID);

IF OBJECT_ID('audit.PublicSubmission', 'U') IS NULL
BEGIN
CREATE TABLE audit.PublicSubmission (
    PublicSubmissionID BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PublicSubmission PRIMARY KEY,
    RegistrationLinkID INT           NULL,
    SubmittedAt        DATETIME2(0)  NOT NULL CONSTRAINT DF_PublicSubmission_SubmittedAt DEFAULT SYSUTCDATETIME(),
    IpHash             VARBINARY(32) NULL,   -- salted hash, never the raw IP
    UserAgent          NVARCHAR(400) NULL,
    Outcome            NVARCHAR(30)  NOT NULL, -- Accepted | Rejected | Duplicate | RateLimited | Honeypot
    Reason             NVARCHAR(200) NULL,
    PayloadHash        VARBINARY(32) NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PublicSubmission_SubmittedAt' AND object_id = OBJECT_ID('audit.PublicSubmission'))
    CREATE INDEX IX_PublicSubmission_SubmittedAt ON audit.PublicSubmission(SubmittedAt);
GO

-- =====================================================================
--  staging -- raw landing zone for the Access extract
--  Everything lands as text/JSON so nothing is lost or coerced.

-- =====================================================================
IF OBJECT_ID('staging.RawRow', 'U') IS NULL
BEGIN
CREATE TABLE staging.RawRow (
    RawRowID      BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_RawRow PRIMARY KEY,
    SourceTable   NVARCHAR(128) NOT NULL,
    SourceRowID   NVARCHAR(100) NULL,
    LoadedAt      DATETIME2(0)  NOT NULL CONSTRAINT DF_RawRow_LoadedAt DEFAULT SYSUTCDATETIME(),
    RawJson       NVARCHAR(MAX) NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RawRow_Source' AND object_id = OBJECT_ID('staging.RawRow'))
    CREATE INDEX IX_RawRow_Source ON staging.RawRow(SourceTable);

IF OBJECT_ID('staging.Quarantine', 'U') IS NULL
BEGIN
CREATE TABLE staging.Quarantine (
    QuarantineID  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Quarantine PRIMARY KEY,
    SourceTable   NVARCHAR(128) NOT NULL,
    SourceRowID   NVARCHAR(100) NULL,
    Reason        NVARCHAR(400) NOT NULL,
    QuarantinedAt DATETIME2(0)  NOT NULL CONSTRAINT DF_Quarantine_QuarantinedAt DEFAULT SYSUTCDATETIME(),
    RawJson       NVARCHAR(MAX) NULL
);
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Quarantine_Table' AND object_id = OBJECT_ID('staging.Quarantine'))
    CREATE INDEX IX_Quarantine_Table ON staging.Quarantine(SourceTable, Reason);
GO

-- =====================================================================
--  Constraints that depend on loaded data
--
--  These live here rather than in the CREATE TABLE blocks so that
--  db/schema.sql alone reproduces production exactly. transform.sql
--  re-applies them after the data load, which is why both files list them.

-- =====================================================================

-- Deferred from the CREATE TABLE above: the legacy data has 4 orphan
-- Registration rows. transform.sql quarantines them before this runs.
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'FK_Registration_Participant' AND type IN ('F','C'))
BEGIN
ALTER TABLE core.Registration
    ADD CONSTRAINT FK_Registration_Participant FOREIGN KEY (ParticipantID) REFERENCES core.Participant(ParticipantID);
END
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'FK_Registration_Workshop' AND type IN ('F','C'))
BEGIN
ALTER TABLE core.Registration
    ADD CONSTRAINT FK_Registration_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
END

-- Access allowed inverted date ranges; 9 rows had them and were corrected
-- during migration. Enforced from here on.
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'CK_Workshop_Dates' AND type IN ('F','C'))
BEGIN
ALTER TABLE core.Workshop
    ADD CONSTRAINT CK_Workshop_Dates CHECK (EndDate IS NULL OR StartDate IS NULL OR EndDate >= StartDate);
END
GO

-- =====================================================================
--  Views -- replace stored, drifting totals (plan §5.4)

-- =====================================================================
IF OBJECT_ID('core.vw_WorkshopCounts', 'V') IS NULL
    EXEC('CREATE VIEW core.vw_WorkshopCounts AS
    SELECT w.WorkshopID,
           COUNT(DISTINCT r.RegistrationID)                                   AS TotalRegistrations,
           COUNT(DISTINCT r.ParticipantID)                                    AS TotalParticipants,
           COUNT(DISTINCT CASE WHEN r.Attended = 1 THEN r.ParticipantID END)  AS TotalAttended
    FROM core.Workshop w
    LEFT JOIN core.Registration r
           ON r.WorkshopID = w.WorkshopID
          AND r.IsCancelled = 0
    GROUP BY w.WorkshopID');
GO

IF OBJECT_ID('core.vw_ParticipantCertificate', 'V') IS NULL
    EXEC('CREATE VIEW core.vw_ParticipantCertificate AS
    SELECT p.ParticipantID,
           p.FirstName,
           p.LastName,
           p.MiddleName,
           p.Email,
           a.AgencyName,
           p.HasCeuCertificate,
           p.HasChcCertificate
    FROM core.Participant p
    LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID');
GO

-- Review view for negative payments (refunds and corrections).
IF OBJECT_ID('core.vw_NegativePayment', 'V') IS NULL
    EXEC('CREATE VIEW core.vw_NegativePayment AS
    SELECT r.RegistrationID, r.ParticipantID, p.LastName, p.FirstName,
           r.WorkshopID, w.WorkshopCode, r.PaidAmount, r.RegistrationDate, r.IsCancelled
    FROM core.Registration r
    JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
    LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
    WHERE r.PaidAmount < 0');
GO

PRINT 'Schema created: 4 schemas, 29 ref tables, 32 core tables, 2 audit tables, 2 staging tables, 3 views.';
GO

-- =====================================================================
--  Notifications - see db/migrations/005-notifications.sql
--  In-app only; email is blocked on Microsoft Graph credentials.
-- =====================================================================
IF OBJECT_ID('core.Notification', 'U') IS NULL
BEGIN
CREATE TABLE core.Notification (
    NotificationID  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Notification PRIMARY KEY,
    Kind            NVARCHAR(40)  NOT NULL,
    Title           NVARCHAR(200) NOT NULL,
    Body            NVARCHAR(1000) NULL,
    LinkPath        NVARCHAR(400) NULL,
    WorkshopID      INT           NULL REFERENCES core.Workshop(WorkshopID),
    CreatedAt       DATETIME2(0)  NOT NULL CONSTRAINT DF_Notification_CreatedAt DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Notification_CreatedAt ON core.Notification (CreatedAt DESC);
END
GO

IF OBJECT_ID('core.NotificationRecipient', 'U') IS NULL
BEGIN
CREATE TABLE core.NotificationRecipient (
    NotificationRecipientID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_NotificationRecipient PRIMARY KEY,
    NotificationID  INT           NOT NULL REFERENCES core.Notification(NotificationID) ON DELETE CASCADE,
    UserID          INT           NOT NULL REFERENCES core.AppUser(UserID),
    ReadAt          DATETIME2(0)  NULL,
    DismissedAt     DATETIME2(0)  NULL,
    CONSTRAINT UQ_NotificationRecipient UNIQUE (NotificationID, UserID)
);
CREATE INDEX IX_NotificationRecipient_User ON core.NotificationRecipient (UserID, ReadAt);
END
GO

IF COL_LENGTH('core.Workshop', 'NotifyPercentFull') IS NULL
    ALTER TABLE core.Workshop
        ADD NotifyPercentFull INT NULL CONSTRAINT DF_Workshop_NotifyPercentFull DEFAULT 80;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
                WHERE name = 'CK_Workshop_NotifyPercentFull'
                  AND parent_object_id = OBJECT_ID('core.Workshop'))
    ALTER TABLE core.Workshop
        ADD CONSTRAINT CK_Workshop_NotifyPercentFull
        CHECK (NotifyPercentFull IS NULL OR (NotifyPercentFull >= 1 AND NotifyPercentFull <= 100));
GO

IF COL_LENGTH('core.Workshop', 'NotifyFiredAt') IS NULL
    ALTER TABLE core.Workshop ADD NotifyFiredAt DATETIME2(0) NULL;
GO

-- =====================================================================
--  Webhooks - see db/migrations/006-webhooks.sql
-- =====================================================================
IF OBJECT_ID('core.Webhook', 'U') IS NULL
BEGIN
CREATE TABLE core.Webhook (
    WebhookID     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Webhook PRIMARY KEY,
    Title         NVARCHAR(200)  NOT NULL,
    Description   NVARCHAR(1000) NULL,
    Url           NVARCHAR(2000) NOT NULL,
    JsonSchema    NVARCHAR(MAX)  NULL,
    PayloadFormat NVARCHAR(20)   NOT NULL CONSTRAINT DF_Webhook_PayloadFormat DEFAULT 'json',
    IsActive      BIT            NOT NULL CONSTRAINT DF_Webhook_IsActive DEFAULT 1,
    Secret        NVARCHAR(200)  NULL,
    CreatedBy     NVARCHAR(200)  NULL,
    CreatedAt     DATETIME2(0)   NOT NULL CONSTRAINT DF_Webhook_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedBy     NVARCHAR(200)  NULL,
    UpdatedAt     DATETIME2(0)   NOT NULL CONSTRAINT DF_Webhook_UpdatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Webhook_PayloadFormat CHECK (PayloadFormat IN ('json','slack'))
);
END
GO

IF OBJECT_ID('core.WebhookDelivery', 'U') IS NULL
BEGIN
CREATE TABLE core.WebhookDelivery (
    WebhookDeliveryID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_WebhookDelivery PRIMARY KEY,
    WebhookID     INT NOT NULL CONSTRAINT FK_WebhookDelivery_Webhook
        REFERENCES core.Webhook(WebhookID) ON DELETE CASCADE,
    EventKind     NVARCHAR(40)  NOT NULL,
    Payload       NVARCHAR(MAX) NULL,
    StatusCode    INT           NULL,
    Succeeded     BIT           NOT NULL,
    Error         NVARCHAR(1000) NULL,
    DurationMs    INT           NULL,
    AttemptedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_WebhookDelivery_AttemptedAt DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_WebhookDelivery_Webhook ON core.WebhookDelivery (WebhookID, AttemptedAt DESC);
END
GO

-- =====================================================================
--  Form Designer (migration 008)
--  Staff-designed questions on the public registration form.
-- =====================================================================
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
END
GO

IF OBJECT_ID('core.FormTemplateVersion', 'U') IS NULL
BEGIN
CREATE TABLE core.FormTemplateVersion (
    FormTemplateVersionID INT       NOT NULL CONSTRAINT PK_FormTemplateVersion PRIMARY KEY,
    FormTemplateID        INT       NOT NULL
        CONSTRAINT FK_FormTemplateVersion_Template REFERENCES core.FormTemplate(FormTemplateID),
    VersionNumber         INT       NOT NULL,
    PublishedAt           DATETIME2 NULL,
    PublishedBy           NVARCHAR(200) NULL,
    CreatedBy             NVARCHAR(200) NOT NULL,
    CreatedAt             DATETIME2 NOT NULL CONSTRAINT DF_FormTemplateVersion_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_FormTemplateVersion UNIQUE (FormTemplateID, VersionNumber)
);
END
GO

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
        CHECK (FieldType IN ('text', 'longtext', 'number', 'select', 'radio', 'checkbox', 'agency'))
);
END
GO

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
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FormAnswer_Question' AND object_id = OBJECT_ID('core.FormAnswer'))
    CREATE INDEX IX_FormAnswer_Question ON core.FormAnswer(FormQuestionID);
GO