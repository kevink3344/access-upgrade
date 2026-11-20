-- =====================================================================
--  transform.sql — staging.RawRow -> ref.* / core.*
--
--  Applies the stakeholder decisions recorded 2026-11-19:
--
--    Q1  Duplicates: keep every participant row that has an email; where
--        (LastName, FirstName, Email) is an exact duplicate, keep the
--        lowest ParticipantID and skip the rest. Before skipping, any
--        registrations on the skipped row are REASSIGNED to the survivor
--        so no registration history is lost.
--
--    Q2  Negative PaidAmount: loaded as-is (negatives preserved) and
--        flagged in core.vw_NegativePayment for staff review.
--
--    Q3  Registrations with no workshop (78): attached to a real
--        core.Workshop row named 'Legacy workshop' so they appear in
--        reports instead of silently dropping out of joins.
--
--    Orphans (4 registrations, 18 presenters) are written to
--    staging.Quarantine with a reason; nothing is deleted silently.
--
--  Idempotent: clears core/ref/staging.Quarantine and reloads.
--  Legacy IDs are preserved via IDENTITY_INSERT-free explicit inserts.
-- =====================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

PRINT '=== TRANSFORM: staging -> core/ref ===';
GO

-- ---------------------------------------------------------------------
-- 0. Reset target tables (children first)
-- ---------------------------------------------------------------------
DECLARE @drop NVARCHAR(MAX) = N'';
SELECT @drop += N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name)
              + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(10)
FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id = fk.parent_object_id;
IF @drop <> N'' EXEC sp_executesql @drop;

DECLARE @trunc NVARCHAR(MAX) = N'';
SELECT @trunc += N'DELETE FROM ' + QUOTENAME(SCHEMA_NAME(schema_id)) + N'.' + QUOTENAME(name) + N';' + CHAR(10)
FROM sys.tables WHERE schema_id IN (SCHEMA_ID('core'), SCHEMA_ID('ref'), SCHEMA_ID('audit'));
IF @trunc <> N'' EXEC sp_executesql @trunc;

DELETE FROM staging.Quarantine;
GO

-- ---------------------------------------------------------------------
-- 1. ref.* — lookups (direct copies, legacy IDs preserved)
-- ---------------------------------------------------------------------
INSERT INTO ref.AgencyType (AgencyTypeID, TypeName)
SELECT CAST(JSON_VALUE(RawJson,'$.AgencyTypeID') AS INT), JSON_VALUE(RawJson,'$.TypeName')
FROM staging.RawRow WHERE SourceTable='lstAgencyTypes';

INSERT INTO ref.Age (AgesID, Ages, SortOrder)
SELECT CAST(JSON_VALUE(RawJson,'$.AgesID') AS INT), JSON_VALUE(RawJson,'$.Ages'),
       TRY_CAST(JSON_VALUE(RawJson,'$.Order') AS INT)
FROM staging.RawRow WHERE SourceTable='lstAges';

INSERT INTO ref.BackupTime (BackupTimeID, BackupTime)
SELECT CAST(JSON_VALUE(RawJson,'$.BackupTimeID') AS INT), JSON_VALUE(RawJson,'$.BackupTime')
FROM staging.RawRow WHERE SourceTable='lstBackupTimes';

INSERT INTO ref.Category (CategoryID, CategoryCode, CategoryType, IsInUse)
SELECT CAST(JSON_VALUE(RawJson,'$.CategoryID') AS INT), JSON_VALUE(RawJson,'$.CategoryCode'),
       JSON_VALUE(RawJson,'$.Type'), ISNULL(CAST(JSON_VALUE(RawJson,'$.InUse') AS BIT),0)
FROM staging.RawRow WHERE SourceTable='lstCategoryTypes';

INSERT INTO ref.City (CityID, RegionID, City)
SELECT CAST(JSON_VALUE(RawJson,'$.CityID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.RegionID') AS INT),
       JSON_VALUE(RawJson,'$.City')
FROM staging.RawRow WHERE SourceTable='lstCities';

INSERT INTO ref.Component (ComponentID, PrEComponent, PrECompAbbrev)
SELECT CAST(JSON_VALUE(RawJson,'$.ComponentID') AS INT), JSON_VALUE(RawJson,'$.PrEComponent'),
       JSON_VALUE(RawJson,'$.PrECompAbbrev')
FROM staging.RawRow WHERE SourceTable='lstComponents';

INSERT INTO ref.ContactType (ContactTypeID, ContactType)
SELECT CAST(JSON_VALUE(RawJson,'$.ContactTypeID') AS INT), JSON_VALUE(RawJson,'$.ContactType')
FROM staging.RawRow WHERE SourceTable='lstContactTypes';

INSERT INTO ref.County (CountyID, County)
SELECT CAST(JSON_VALUE(RawJson,'$.CountyID') AS INT), JSON_VALUE(RawJson,'$.County')
FROM staging.RawRow WHERE SourceTable='lstCounties';

INSERT INTO ref.CreditSlipCategory (CreditSlipsCategoryID, CreditSlipsCategory)
SELECT CAST(JSON_VALUE(RawJson,'$.CreditSlipsCategoryID') AS INT), JSON_VALUE(RawJson,'$.CreditSlipsCategory')
FROM staging.RawRow WHERE SourceTable='lstCreditSlipsCategories';

INSERT INTO ref.CreditType (CreditTypeID, CreditCode, CreditDescription)
SELECT CAST(JSON_VALUE(RawJson,'$.CreditTypeID') AS INT), JSON_VALUE(RawJson,'$.CreditCode'),
       JSON_VALUE(RawJson,'$.CreditDescription')
FROM staging.RawRow WHERE SourceTable='lstCreditTypes';

INSERT INTO ref.DesiredTopicCategory (DesiredTopicCategoryID, DesiredTopicCategory)
SELECT CAST(JSON_VALUE(RawJson,'$.DesiredTopicCategoryID') AS INT), JSON_VALUE(RawJson,'$.DesiredTopicCategory')
FROM staging.RawRow WHERE SourceTable='lstDesiredTopicCategories';

INSERT INTO ref.Equipment (EquipmentID, Equipment)
SELECT CAST(JSON_VALUE(RawJson,'$.EquipmentID') AS INT), JSON_VALUE(RawJson,'$.Equipment')
FROM staging.RawRow WHERE SourceTable='lstEquipment';

INSERT INTO ref.EvalQuestionType (EvalQuestTypeID, EvalQuestType)
SELECT CAST(JSON_VALUE(RawJson,'$.EvalQuestTypeID') AS INT), JSON_VALUE(RawJson,'$.EvalQuestType')
FROM staging.RawRow WHERE SourceTable='lstEvalQuestionTypes';

INSERT INTO ref.EvalType (EvalTypeID, WorkshopType)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopTypeID') AS INT), JSON_VALUE(RawJson,'$.WorkshopType')
FROM staging.RawRow WHERE SourceTable='lstEvalTypes';

INSERT INTO ref.EventType (EventTypeID, EventType)
SELECT CAST(JSON_VALUE(RawJson,'$.EventTypeID') AS INT), JSON_VALUE(RawJson,'$.EventType')
FROM staging.RawRow WHERE SourceTable='lstEventTypes';

INSERT INTO ref.FacilityType (FacilityTypeID, FacilityType)
SELECT CAST(JSON_VALUE(RawJson,'$.FacilityTypeID') AS INT), JSON_VALUE(RawJson,'$.FacilityType')
FROM staging.RawRow WHERE SourceTable='lstFacilityTypes';

INSERT INTO ref.MailingList (MailingListID, MailingList)
SELECT CAST(JSON_VALUE(RawJson,'$.MailingListID') AS INT), JSON_VALUE(RawJson,'$.MailingList')
FROM staging.RawRow WHERE SourceTable='lstMailingLists';

INSERT INTO ref.ZipCode (ZipCode, RegionID, City, County)
SELECT JSON_VALUE(RawJson,'$."Zip Code"'), TRY_CAST(JSON_VALUE(RawJson,'$.RegionID') AS INT),
       JSON_VALUE(RawJson,'$.City'), JSON_VALUE(RawJson,'$.County')
FROM staging.RawRow WHERE SourceTable='lstNCZipCodes';

INSERT INTO ref.Other (OtherID, OtherNickname, Description)
SELECT CAST(JSON_VALUE(RawJson,'$.OtherID') AS INT), JSON_VALUE(RawJson,'$.OtherNickname'),
       JSON_VALUE(RawJson,'$.Description')
FROM staging.RawRow WHERE SourceTable='lstOthersList';

INSERT INTO ref.PaymentMethod (PaymentMethodID, PaymentMethod)
SELECT CAST(JSON_VALUE(RawJson,'$.PaymentMethodID') AS INT), JSON_VALUE(RawJson,'$.PaymentMethod')
FROM staging.RawRow WHERE SourceTable='lstPaymentMethods';

INSERT INTO ref.PreferredTime (PreferredTimesID, PreferredTimes, PreferredTimesNotes)
SELECT CAST(JSON_VALUE(RawJson,'$.PreferredTimesID') AS INT), JSON_VALUE(RawJson,'$.PreferredTimes'),
       JSON_VALUE(RawJson,'$.PreferredTimesNotes')
FROM staging.RawRow WHERE SourceTable='lstPreferredTimes';

INSERT INTO ref.ReferralType (ReferralTypeID, ReferralType, ReferralAbrev)
SELECT CAST(JSON_VALUE(RawJson,'$.ReferralTypeID') AS INT), JSON_VALUE(RawJson,'$.ReferralType'),
       JSON_VALUE(RawJson,'$.ReferralAbrev')
FROM staging.RawRow WHERE SourceTable='lstReferralTypes';

INSERT INTO ref.Region (RegionID, Region)
SELECT CAST(JSON_VALUE(RawJson,'$.RegionID') AS INT), JSON_VALUE(RawJson,'$.Region')
FROM staging.RawRow WHERE SourceTable='lstRegions';

INSERT INTO ref.Salutation (SalutationID, Salutation)
SELECT CAST(JSON_VALUE(RawJson,'$.SalutationID') AS INT), JSON_VALUE(RawJson,'$.Salutation')
FROM staging.RawRow WHERE SourceTable='lstSalutations';

INSERT INTO ref.SchoolYear (SchoolYearID, SchoolYear, IsPastYear, BeginDate, EndDate)
SELECT CAST(JSON_VALUE(RawJson,'$.SYID') AS INT), JSON_VALUE(RawJson,'$.SchoolYear'),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.PastYear') AS BIT),0),
       TRY_CAST(JSON_VALUE(RawJson,'$.BeginDate') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.EndDate') AS DATETIME2(0))
FROM staging.RawRow WHERE SourceTable='lstSchoolYrs';

INSERT INTO ref.State (StateID, [State])
SELECT CAST(JSON_VALUE(RawJson,'$.StateID') AS INT), JSON_VALUE(RawJson,'$.State')
FROM staging.RawRow WHERE SourceTable='lstStates';

INSERT INTO ref.StreetType (StreetTypeID, StreetTypeName, StreetTypeAbbrev)
SELECT CAST(JSON_VALUE(RawJson,'$.StreetTypeID') AS INT), JSON_VALUE(RawJson,'$.StreetTypeName'),
       JSON_VALUE(RawJson,'$.StreetTypeAbbrev')
FROM staging.RawRow WHERE SourceTable='lstStreetTypes';

INSERT INTO ref.SummaryCountType (SummaryCountTypeID, CountType)
SELECT CAST(JSON_VALUE(RawJson,'$.CountyTypeID') AS INT), JSON_VALUE(RawJson,'$.CountType')
FROM staging.RawRow WHERE SourceTable='lstSummaryCountTypes';

PRINT '  ref.* loaded';
GO

-- ---------------------------------------------------------------------
-- 2. core — parent tables first
-- ---------------------------------------------------------------------

-- Agency
INSERT INTO core.Agency (AgencyID, WakeSitesFacilityID, CountyID, StreetTypeID, CityID, StateID,
    AgencyTypeID, FacilityTypeID, AgencyName, AgencyShortName, AgencyAddress1, AgencyAddress2,
    AgencyZip, AgencyPhone, AgencyFax, AgencyEmail, AgencyWebsite, DirectorFirstName, DirectorLastName,
    AltContactFirstName, AltContactLastName, IsOutOfBusiness, SchoolCode, Calendar, IsWorkshopSite,
    Notes, CreatedAt, UpdatedAt)
SELECT CAST(JSON_VALUE(RawJson,'$.AgencyID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.WakeSitesFacilityID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.CountyID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.StreetTypeID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.CityID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.StateID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.AgencyTypeID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.FacilityTypeID') AS INT),
       JSON_VALUE(RawJson,'$.AgencyName'), JSON_VALUE(RawJson,'$.AgencyShortName'),
       JSON_VALUE(RawJson,'$.AgencyAddress1'), JSON_VALUE(RawJson,'$.AgencyAddress2'),
       JSON_VALUE(RawJson,'$.AgencyZip'), JSON_VALUE(RawJson,'$.AgencyPhone'),
       JSON_VALUE(RawJson,'$.AgencyFax'), JSON_VALUE(RawJson,'$.AgencyEmail'),
       JSON_VALUE(RawJson,'$.AgencyWebsite'), JSON_VALUE(RawJson,'$.DirectorFName'),
       JSON_VALUE(RawJson,'$.DirectorLName'), JSON_VALUE(RawJson,'$.AltContactF'),
       JSON_VALUE(RawJson,'$.AltContactL'), ISNULL(CAST(JSON_VALUE(RawJson,'$.OutOfBusiness') AS BIT),0),
       JSON_VALUE(RawJson,'$.SchoolCode'), TRY_CAST(JSON_VALUE(RawJson,'$.Calendar') AS INT),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.WorkshopSite') AS BIT),0),
       JSON_VALUE(RawJson,'$.AgencyNotes'),
       TRY_CAST(JSON_VALUE(RawJson,'$.DateCreated') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.DateUpdated') AS DATETIME2(0))
FROM staging.RawRow WHERE SourceTable='tblAgencies';

-- Reserved agency for invalid references. ID 0 is free in the legacy range
-- (2..2483). Records pointing at a non-existent agency are re-pointed here
-- rather than nulled, so they remain visible in reports.
INSERT INTO core.Agency (AgencyID, AgencyName, AgencyShortName, IsOutOfBusiness, IsWorkshopSite, Notes)
VALUES (0, N'Unknown', N'Unknown', 0, 0, N'Placeholder for records referencing an agency that does not exist.');

INSERT INTO core.AgencyMailAddress (AgencyID, StreetTypeID, CityID, StateID, MailingAddressLine1, MailingAddressLine2, MailingZipCode)
SELECT CAST(JSON_VALUE(RawJson,'$.AgencyID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.StreetTypeID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.CityID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.StateID') AS INT),
       JSON_VALUE(RawJson,'$.MailingAddressLine1'), JSON_VALUE(RawJson,'$.MailingAddressLine2'),
       JSON_VALUE(RawJson,'$.MailingZipCode')
FROM staging.RawRow WHERE SourceTable='tblAgencyMailAddresses';

INSERT INTO core.BoardMember (BoardID, AgencyID, CityID, StateID, BoardFirstName, BoardLastName,
    BoardTitle, BoardAddress1, BoardAddress2, BoardZip, BoardPhone, BoardEmail)
SELECT CAST(JSON_VALUE(RawJson,'$.BoardID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.AgencyID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.CityID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.StateID') AS INT),
       JSON_VALUE(RawJson,'$.BoardFName'), JSON_VALUE(RawJson,'$.BoardLName'), JSON_VALUE(RawJson,'$.BoardTitle'),
       JSON_VALUE(RawJson,'$.BoardAddress1'), JSON_VALUE(RawJson,'$.BoardAddress2'),
       JSON_VALUE(RawJson,'$.BoardZip'), JSON_VALUE(RawJson,'$.BoardPhone'), JSON_VALUE(RawJson,'$.BoardEmail')
FROM staging.RawRow WHERE SourceTable='tblBoardMembers';

INSERT INTO core.Payee (PayeeID, Payee, IsDeleted)
SELECT CAST(JSON_VALUE(RawJson,'$.PayeeID') AS INT), JSON_VALUE(RawJson,'$.Payee'),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Delete') AS BIT),0)
FROM staging.RawRow WHERE SourceTable='tblPayees';
GO

-- ---------------------------------------------------------------------
-- 3. Participant — apply Q1 duplicate rule
--
--    Keep the lowest ParticipantID per exact (LastName, FirstName, Email).
--    Rows with no email are always kept (they cannot be matched).
-- ---------------------------------------------------------------------
CREATE TABLE #ParticipantMap (
    ParticipantID INT NOT NULL PRIMARY KEY,
    KeepID        INT NOT NULL,
    IsDuplicate   BIT NOT NULL
);

;WITH src AS (
    SELECT CAST(JSON_VALUE(RawJson,'$.ParticipantID') AS INT) AS ParticipantID,
           LTRIM(RTRIM(JSON_VALUE(RawJson,'$.LName')))  AS LastName,
           LTRIM(RTRIM(JSON_VALUE(RawJson,'$.FName')))  AS FirstName,
           LOWER(LTRIM(RTRIM(JSON_VALUE(RawJson,'$.ParticipantEmail')))) AS Email
    FROM staging.RawRow WHERE SourceTable='tblParticipants'
), keyed AS (
    SELECT ParticipantID, LastName, FirstName, Email,
           MIN(ParticipantID) OVER (PARTITION BY LastName, FirstName, Email) AS KeepID,
           COUNT(*)           OVER (PARTITION BY LastName, FirstName, Email) AS GrpCount
    FROM src
    WHERE Email IS NOT NULL AND Email <> ''
)
INSERT INTO #ParticipantMap (ParticipantID, KeepID, IsDuplicate)
SELECT ParticipantID, KeepID, CASE WHEN ParticipantID <> KeepID THEN 1 ELSE 0 END
FROM keyed
UNION ALL
SELECT CAST(JSON_VALUE(RawJson,'$.ParticipantID') AS INT),
       CAST(JSON_VALUE(RawJson,'$.ParticipantID') AS INT), 0
FROM staging.RawRow
WHERE SourceTable='tblParticipants'
  AND (JSON_VALUE(RawJson,'$.ParticipantEmail') IS NULL OR LTRIM(RTRIM(JSON_VALUE(RawJson,'$.ParticipantEmail'))) = '');

-- Registrations on a duplicate row are reassigned to the survivor.
-- Record each reassignment so the decision is auditable.
INSERT INTO audit.ChangeLog (SchemaName, TableName, RecordID, Action, ChangedBy, OldValues, NewValues)
SELECT 'core', 'Registration', JSON_VALUE(r.RawJson,'$.RegistrationID'), 'U', 'etl:dedupe',
       CONCAT('{"ParticipantID":', JSON_VALUE(r.RawJson,'$.ParticipantID'), '}'),
       CONCAT('{"ParticipantID":', m.KeepID, '}')
FROM staging.RawRow r
JOIN #ParticipantMap m
  ON m.ParticipantID = CAST(JSON_VALUE(r.RawJson,'$.ParticipantID') AS INT)
WHERE r.SourceTable='tblRegistrations'
  AND m.IsDuplicate = 1;

INSERT INTO core.Participant (ParticipantID, WebID, SalutationID, AgencyID, StreetTypeID, CityID, StateID,
    FirstName, LastName, MiddleName, HomePhone, HomeFax, WorkPhone, WorkPhoneExt, HomeAddress1, HomeAddress2,
    HomeZip, Email, Email2, Email3, Position, GradeLevel, IsParentMailingList, IsTeacherMailingList,
    IsDirectorMailingList, IsStaff, IsWcpss, HasCeuCertificate, HasChcCertificate, DateOfEntry, UpdatedAt)
SELECT CAST(JSON_VALUE(r.RawJson,'$.ParticipantID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.WebID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.SalutationID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.AgencyID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.StreetTypeID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.CityID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.StateID') AS INT),
       JSON_VALUE(r.RawJson,'$.FName'), JSON_VALUE(r.RawJson,'$.LName'), JSON_VALUE(r.RawJson,'$.MName'),
       JSON_VALUE(r.RawJson,'$.HomePhone'), JSON_VALUE(r.RawJson,'$.HomeFax'),
       JSON_VALUE(r.RawJson,'$.WorkPhoneOpt'), JSON_VALUE(r.RawJson,'$.WorkPhoneExt'),
       JSON_VALUE(r.RawJson,'$.HomeAddress1'), JSON_VALUE(r.RawJson,'$.HomeAddress2'),
       JSON_VALUE(r.RawJson,'$.HomeZip'), JSON_VALUE(r.RawJson,'$.ParticipantEmail'),
       JSON_VALUE(r.RawJson,'$.ParticipantEmail2'), JSON_VALUE(r.RawJson,'$.ParticipantEmail3'),
       JSON_VALUE(r.RawJson,'$.Position'), JSON_VALUE(r.RawJson,'$.GradeLvl'),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$."ParentMailingList?"') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$."TeacherMailingList?"') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$."DirectorMailingList?"') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$."Staff?"') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$."WCPSS?"') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$.CEUCertificate') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$.CHCCertificate') AS BIT),0),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.DateOfEntry') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.DateUpdated') AS DATETIME2(0))
FROM staging.RawRow r
JOIN #ParticipantMap m ON m.ParticipantID = CAST(JSON_VALUE(r.RawJson,'$.ParticipantID') AS INT)
WHERE r.SourceTable='tblParticipants' AND m.IsDuplicate = 0;
GO

-- ---------------------------------------------------------------------
-- 4. WorkshopName, Workshop (incl. the 'Legacy workshop' row for Q3)
-- ---------------------------------------------------------------------
INSERT INTO core.WorkshopName (WorkshopNameID, AgesID, WorkshopName, ShortName, ECourseNum, WLCourse,
    Prerequisites, Description, TopicNums, IsLiteracy)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopNameID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.AgesID') AS INT),
       JSON_VALUE(RawJson,'$.WorkshopName'), JSON_VALUE(RawJson,'$.WorkshopShortName'),
       TRY_CAST(JSON_VALUE(RawJson,'$.E_CourseNum') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WLCourse') AS INT),
       JSON_VALUE(RawJson,'$.Prerequisites'), JSON_VALUE(RawJson,'$.Description'),
       JSON_VALUE(RawJson,'$.TopicNums'), ISNULL(CAST(JSON_VALUE(RawJson,'$.Literacy') AS BIT),0)
FROM staging.RawRow WHERE SourceTable='tblWorkshopNames';

-- Q3 companion: a named catalog entry for the placeholder workshop, so the
-- label is visible in reports and pickers. ID 0 mirrors WorkshopID 0 and is
-- free in the legacy range (1..1798).
INSERT INTO core.WorkshopName (WorkshopNameID, WorkshopName, ShortName, Description, IsLiteracy)
VALUES (0, N'Legacy workshop', N'Legacy',
        N'Placeholder for legacy registrations that reference no workshop. Not a real offering.', 0);

-- Q3: the 78 workshop-less registrations get a real parent row.
-- ID 0 is reserved for it and does not collide with any legacy WorkshopID.
INSERT INTO core.Workshop (WorkshopID, WorkshopNameID, IsClosed, IsCancelled, IsBrochure, IsFolder,
    IsLabel, IsContracted, IsWcpc, IsStaffDev, IsFullyCodified, Notes)
VALUES (0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, N'Placeholder for legacy registrations that reference no workshop.');

INSERT INTO core.Workshop (WorkshopID, LegacyWorkshopID, WorkshopNameID, EvalTypeID, ComponentID, CategoryID,
    AgencyID, SchoolYearID, TorP, VorIP, WorkshopCode, ESessionNum, WLSession, StartDate, EndDate, StartTime, EndTime,
    DatesText, TimesText, MaxEnrollment, MinEnrollment, ESchoolSeats, Room, IsBrochure, IsFolder, IsLabel, IsClosed,
    IsCancelled, IsContracted, IsWcpc, IsStaffDev, ConsultFee, Cost1, Cost2, CreditPossible, SessionCount,
    SessionHours, SessionCeus, ESchoolRegistered, ESchoolAttended, ESchoolDropped, ESchoolLateDropped, ESchoolNoShow,
    EvaluationCount, NumPractices, Virtual, IsInPerson, InternetYes, InternetNo, PublicRegistrations, Notes,
    SpecialNotes, IsFullyCodified, CreatedAt, UpdatedAt)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID_Old') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopNameID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.EvalTypeID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.ComponenetID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.CategoryID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.AgencyID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.SYID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.TorP') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.VorIP') AS INT),
       JSON_VALUE(RawJson,'$.WorkshopCode'),
       TRY_CAST(JSON_VALUE(RawJson,'$.E_SessionNum') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.WLSession') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.StartDate') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.EndDate')   AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.StartTime') AS TIME(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.EndTime')   AS TIME(0)),
       JSON_VALUE(RawJson,'$.Dates'), JSON_VALUE(RawJson,'$.Times'),
       TRY_CAST(JSON_VALUE(RawJson,'$.Max') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.Min') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.eSchoolsSeats') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.Room') AS SMALLINT),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Brochure') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Folder') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Label') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Closed') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Cancelled') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Contracted') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.WCPC') AS BIT),0),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.StaffDev') AS BIT),0),
       TRY_CAST(JSON_VALUE(RawJson,'$.ConsultFee') AS DECIMAL(19,4)),
       TRY_CAST(JSON_VALUE(RawJson,'$.Cost1') AS DECIMAL(19,4)),
       TRY_CAST(JSON_VALUE(RawJson,'$.Cost2') AS DECIMAL(19,4)),
       JSON_VALUE(RawJson,'$.CreditPossible'),
       TRY_CAST(JSON_VALUE(RawJson,'$.Sessions') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.SessionHrs') AS DECIMAL(18,2)),
       TRY_CAST(JSON_VALUE(RawJson,'$.SessionCEUs') AS REAL),
       TRY_CAST(JSON_VALUE(RawJson,'$.eSchoolRegistered') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.eSchoolAttend') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.eSchoolDropped') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.eSchoolLateDropped') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.eSchoolNoShow') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.Evaluations') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.NumPractices') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.Virtual') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$."In-Person"') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.InternetYes') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.InternetNo') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.PublicRegistrations') AS INT),
       JSON_VALUE(RawJson,'$.WorkshopNotes'), JSON_VALUE(RawJson,'$.SpecialNotes'),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.FullyCodified') AS BIT),0),
       TRY_CAST(JSON_VALUE(RawJson,'$.DateCreated') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.DateUpdated') AS DATETIME2(0))
FROM staging.RawRow WHERE SourceTable='tblWorkshops';
GO

-- ---------------------------------------------------------------------
-- 5. Presenters, sessions
-- ---------------------------------------------------------------------
INSERT INTO core.PresenterStaff (PresenterStaffID, SalutationID, AgencyID, CityID, StateID, LastName, FirstName,
    MiddleName, WorkPhone, Extension, HomePhone, CellPhone, HomeEmail, Address, Zip, IsRetired, DateOfEntry, UpdatedAt)
SELECT CAST(JSON_VALUE(RawJson,'$.PresenterStaffID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.SalutationID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.AgencyID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.CityID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.StateID') AS INT), JSON_VALUE(RawJson,'$.StaffLName'),
       JSON_VALUE(RawJson,'$.StaffFName'), JSON_VALUE(RawJson,'$.StaffMName'), JSON_VALUE(RawJson,'$.StaffWPhone'),
       TRY_CAST(JSON_VALUE(RawJson,'$.StaffExtension') AS INT), JSON_VALUE(RawJson,'$.StaffHPhone'),
       JSON_VALUE(RawJson,'$.StaffCPhone'), JSON_VALUE(RawJson,'$.StaffHEmail'), JSON_VALUE(RawJson,'$.StaffAddress'),
       JSON_VALUE(RawJson,'$.StaffZip'), ISNULL(CAST(JSON_VALUE(RawJson,'$.Retired') AS BIT),0),
       TRY_CAST(JSON_VALUE(RawJson,'$.StaffDateOfEntry') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.PresenterDateUpdated') AS DATETIME2(0))
FROM staging.RawRow WHERE SourceTable='tblPresentersAndStaff';

INSERT INTO core.WorkshopSession (WorkshopSessionID, WorkshopID, StaffID, BackUpTimeID, SessionDate, RegAttend, ESchoolAttend)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopSessionID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.StaffID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.BackUpTimeID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.SessionDate') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.RegAttend') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.eSchoolAttend') AS INT)
FROM staging.RawRow WHERE SourceTable='tblWorkshopSessions';
GO

-- WorkshopPresenters: 18 rows reference a missing presenter -> quarantine
INSERT INTO staging.Quarantine (SourceTable, SourceRowID, Reason, RawJson)
SELECT 'tblWorkshopPresenters', JSON_VALUE(RawJson,'$.WorkshopPresenterID'),
       CONCAT('Orphan PresenterID ', JSON_VALUE(RawJson,'$.PresenterID'), ' not found in tblPresentersAndStaff'),
       RawJson
FROM staging.RawRow r
WHERE r.SourceTable='tblWorkshopPresenters'
  AND NOT EXISTS (SELECT 1 FROM core.PresenterStaff p
                  WHERE p.PresenterStaffID = TRY_CAST(JSON_VALUE(r.RawJson,'$.PresenterID') AS INT));

INSERT INTO core.WorkshopPresenter (WorkshopPresenterID, PresenterID, WorkshopID)
SELECT CAST(JSON_VALUE(r.RawJson,'$.WorkshopPresenterID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.PresenterID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.WorkshopID') AS INT)
FROM staging.RawRow r
WHERE r.SourceTable='tblWorkshopPresenters'
  AND EXISTS (SELECT 1 FROM core.PresenterStaff p
              WHERE p.PresenterStaffID = TRY_CAST(JSON_VALUE(r.RawJson,'$.PresenterID') AS INT));
GO

-- ---------------------------------------------------------------------
-- 6. Payments, then Registrations (Q1 reassignment + Q3 legacy workshop)
-- ---------------------------------------------------------------------
INSERT INTO core.Payment (PaymentID, PaymentMethodID, PayeeID, SchoolYearID, CheckNumber, ReceiptNumber,
    PaymentTotal, PaidDate, Notes)
SELECT CAST(JSON_VALUE(RawJson,'$.PaymentID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.PaymentMethodID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.PayeeID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.SYID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.CheckNumber') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.ReceiptNumber') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.PaymentTotal') AS DECIMAL(19,4)),
       TRY_CAST(JSON_VALUE(RawJson,'$.PaidDate') AS DATETIME2(0)), JSON_VALUE(RawJson,'$.PaymentNotes')
FROM staging.RawRow WHERE SourceTable='tblPayments';

-- Orphan registrations (participant or workshop genuinely missing) -> quarantine.
-- NOTE: the participant check must use the dedupe-resolved ID, otherwise the
-- 29 duplicate rows removed by Q1 look like orphans. Their registrations are
-- reassigned to the survivor and belong in core.Registration.
INSERT INTO staging.Quarantine (SourceTable, SourceRowID, Reason, RawJson)
SELECT 'tblRegistrations', JSON_VALUE(r.RawJson,'$.RegistrationID'),
       CASE
        WHEN NOT EXISTS (SELECT 1 FROM core.Participant p
                         WHERE p.ParticipantID = ISNULL(m.KeepID, TRY_CAST(JSON_VALUE(r.RawJson,'$.ParticipantID') AS INT)))
           THEN CONCAT('Orphan ParticipantID ', JSON_VALUE(r.RawJson,'$.ParticipantID'))
         ELSE CONCAT('Orphan WorkshopID ', JSON_VALUE(r.RawJson,'$.WorkshopID'))
       END,
       r.RawJson
FROM staging.RawRow r
LEFT JOIN #ParticipantMap m
      ON m.ParticipantID = TRY_CAST(JSON_VALUE(r.RawJson,'$.ParticipantID') AS INT)
WHERE r.SourceTable='tblRegistrations'
  AND (
       NOT EXISTS (SELECT 1 FROM core.Participant p
                   WHERE p.ParticipantID = ISNULL(m.KeepID, TRY_CAST(JSON_VALUE(r.RawJson,'$.ParticipantID') AS INT)))
     OR (JSON_VALUE(r.RawJson,'$.WorkshopID') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID = TRY_CAST(JSON_VALUE(r.RawJson,'$.WorkshopID') AS INT)))
     );

INSERT INTO core.Registration (RegistrationID, ParticipantID, CreditTypeID, WorkshopID, PaymentID, PaymentMethodID,
    PaidAmount, TicketCount, IsScholarship, RegistrationDate, IsCancelled, Notes, EmailConfirmation, PayeeID,
    ReceiptNumber, CheckNumber, CheckTotal, PaidDate, Attended, UpdatedAt, Source)
SELECT CAST(JSON_VALUE(r.RawJson,'$.RegistrationID') AS INT),
       -- Q1: duplicate participants are folded onto the survivor
       ISNULL(m.KeepID, TRY_CAST(JSON_VALUE(r.RawJson,'$.ParticipantID') AS INT)),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.CreditTypeID') AS INT),
       -- Q3: no workshop -> the 'Legacy workshop' row (ID 0)
       ISNULL(TRY_CAST(JSON_VALUE(r.RawJson,'$.WorkshopID') AS INT), 0),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.PaymentID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.PaymentMethodID') AS INT),
       -- Q2: negative amounts preserved verbatim
       TRY_CAST(JSON_VALUE(r.RawJson,'$.PaidAmt') AS DECIMAL(19,4)),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.Tickets') AS INT),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$.Scholarship') AS BIT),0),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.RegistrationDate') AS DATETIME2(0)),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$.Cancellation') AS BIT),0),
       JSON_VALUE(r.RawJson,'$.RegistrationNotes'),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$.EmailConfirmation') AS BIT),0),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.PayeeID') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$."Receipt#"') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.CheckNumber') AS INT),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.CheckTotal') AS DECIMAL(19,4)),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.PaidDate') AS DATETIME2(0)),
       ISNULL(CAST(JSON_VALUE(r.RawJson,'$.Attended') AS BIT),0),
       TRY_CAST(JSON_VALUE(r.RawJson,'$.RegistrationUpdated') AS DATETIME2(0)),
       'Manual'
FROM staging.RawRow r
LEFT JOIN #ParticipantMap m
       ON m.ParticipantID = TRY_CAST(JSON_VALUE(r.RawJson,'$.ParticipantID') AS INT)
WHERE r.SourceTable='tblRegistrations'
  AND EXISTS (SELECT 1 FROM core.Participant p WHERE p.ParticipantID = ISNULL(m.KeepID, TRY_CAST(JSON_VALUE(r.RawJson,'$.ParticipantID') AS INT)))
  AND (JSON_VALUE(r.RawJson,'$.WorkshopID') IS NULL
       OR EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID = TRY_CAST(JSON_VALUE(r.RawJson,'$.WorkshopID') AS INT)));
GO

-- ---------------------------------------------------------------------
-- 7. Remaining core tables
-- ---------------------------------------------------------------------
INSERT INTO core.SessionParticipant (ParticipantID, WorkshopSessionID, IsLate)
SELECT CAST(JSON_VALUE(RawJson,'$.ParticipantID') AS INT), CAST(JSON_VALUE(RawJson,'$.WorkshopSessionID') AS INT),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Late') AS BIT),0)
FROM staging.RawRow WHERE SourceTable='tblSessionParticipants';

INSERT INTO core.CreditSlip (CreditSlipID, CreditSlipsCategoryID, ParticipantID, WorkshopID, DateIssued, DateUsed,
    UsedWorkshopID, UsedParticipantID, Amount, TrackingYear, Email)
SELECT CAST(JSON_VALUE(RawJson,'$.CreditSlipID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.CreditSlipsCategoryID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.ParticipantID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.DateIssued') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.DateUsed') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.UsedWorkshopID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.UsedParticipantID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.Amount') AS DECIMAL(19,4)),
       TRY_CAST(JSON_VALUE(RawJson,'$.TrackingYear') AS INT),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Email') AS BIT),0)
FROM staging.RawRow WHERE SourceTable='tblCreditSlips';

INSERT INTO core.EvalQuestion (EvalQuestID, EvaluationTypeID, EvalQuestTypeID, EvalQuestion, EvalQuestNum, IsActive)
SELECT CAST(JSON_VALUE(RawJson,'$.EvalQuestID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.EvaluationTypeID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.EvalQuestTypeID') AS INT), JSON_VALUE(RawJson,'$.EvalQuestion'),
       TRY_CAST(JSON_VALUE(RawJson,'$.EvalQuestNum') AS INT), ISNULL(CAST(JSON_VALUE(RawJson,'$.Active') AS BIT),1)
FROM staging.RawRow WHERE SourceTable='tblEvalQuestions';

INSERT INTO core.WorkshopEvalQuestion (WorkshopEvaluationID, WorkshopID, EvalQuestID, WorkshopEvalRating, WorkshopEvalQty)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopEvaluations') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.EvalQuestID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopEvalRating') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopEvalQty') AS INT)
FROM staging.RawRow WHERE SourceTable='tblWorkshopEvalQuestions';

INSERT INTO core.WorkshopComment (WorkshopCommentID, WorkshopID, Comment)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopCommentID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       JSON_VALUE(RawJson,'$.Comment')
FROM staging.RawRow WHERE SourceTable='tblWorkshopComments';

INSERT INTO core.WorkshopPresenterComment (WorkshopPresenterCommentID, WorkshopID, PresenterComment)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopPresenterCommentID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       JSON_VALUE(RawJson,'$.PresenterComment')
FROM staging.RawRow WHERE SourceTable='tblWorkshopPresenterComments';

INSERT INTO core.WorkshopDesiredTopic (WorkshopDesiredTopicsID, WorkshopID, DesiredTopicCategoryID, WorkshopDesiredTopics)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopDesiredTopicsID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.DesiredTopicCategoryID') AS INT), JSON_VALUE(RawJson,'$.WorkshopDesiredTopics')
FROM staging.RawRow WHERE SourceTable='tblWorkshopDesiredTopics';

INSERT INTO core.WorkshopPreferredTime (WorkshopPreferredTime, WorkshopID, PreferredTimeID, WorkshopPreferredTimeQty)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopPreferredTime') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.PreferredTimeID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopPreferredTimeQty') AS INT)
FROM staging.RawRow WHERE SourceTable='tblWorkshopPreferredTimes';

INSERT INTO core.WorkshopReferral (WorkshopReferralID, WorkshopID, ReferralTypeID, ReferralNum, ReferralNotes)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopReferralID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.ReferralTypeID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.ReferralNum') AS INT),
       JSON_VALUE(RawJson,'$.ReferralNotes')
FROM staging.RawRow WHERE SourceTable='tblWorkshopReferrals';

INSERT INTO core.WorkshopLikedMost (LikedMostID, WorkshopID, LikedMost)
SELECT CAST(JSON_VALUE(RawJson,'$.LikedMostID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       JSON_VALUE(RawJson,'$.LikedMost')
FROM staging.RawRow WHERE SourceTable='tblWorkshopsLikedMost';

INSERT INTO core.WorkshopLikedLeast (LikedLeastID, WorkshopID, LikedLeast)
SELECT CAST(JSON_VALUE(RawJson,'$.LikedLeastID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       JSON_VALUE(RawJson,'$.LikedLeast')
FROM staging.RawRow WHERE SourceTable='tblWorkshopsLikedLeast';

INSERT INTO core.WorkshopPractice (WorkshopsPracticesID, WorkshopID, WorkshopPractice)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopsPracticesID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       JSON_VALUE(RawJson,'$.WorkshopPractice')
FROM staging.RawRow WHERE SourceTable='tblWorkshopsPractices';

INSERT INTO core.WorkshopSummaryCount (WorkshopSummaryCountsID, WorkshopID, CountTypeID, [Count], CountSessionNum)
SELECT CAST(JSON_VALUE(RawJson,'$.WorkshopSummaryCountsID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.CountTypeID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.Count') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.CountSessionNum') AS SMALLINT)
FROM staging.RawRow WHERE SourceTable='tblWorkshopSummaryCounts';

INSERT INTO core.OtherCount (OtherCountID, OtherID, WorkshopID, NumberParents)
SELECT CAST(JSON_VALUE(RawJson,'$.OtherCountID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.OtherID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.NumberParents') AS INT)
FROM staging.RawRow WHERE SourceTable='tblOtherCounts';

INSERT INTO core.CommunityEvent (EventID, ComponentID, EventTypeID, EventTitle, EventType, EventLocation,
    EventDate, EventTimes, EventAttendees, NumAdults, NumChildren, NumTeachers, EventDateEntered)
SELECT CAST(JSON_VALUE(RawJson,'$.EventID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.ComponentID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.EventTypeID') AS INT), JSON_VALUE(RawJson,'$.EventTitle'),
       JSON_VALUE(RawJson,'$.EventType'), JSON_VALUE(RawJson,'$.EventLocation'),
       TRY_CAST(JSON_VALUE(RawJson,'$.EventDate') AS DATETIME2(0)), JSON_VALUE(RawJson,'$.EventTimes'),
       TRY_CAST(JSON_VALUE(RawJson,'$.EventAttendees') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.NumAdults') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.NumChildren') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.NumTeachers') AS SMALLINT),
       TRY_CAST(JSON_VALUE(RawJson,'$.EventDateEntered') AS DATETIME2(0))
FROM staging.RawRow WHERE SourceTable='tblCommunityEvents';

INSERT INTO core.CommunityEventStaff (EventID, StaffID)
SELECT CAST(JSON_VALUE(RawJson,'$.EventID') AS INT), CAST(JSON_VALUE(RawJson,'$.StaffID') AS INT)
FROM staging.RawRow WHERE SourceTable='tblCommunityEventStaff';

INSERT INTO core.TrainingRequest (TrainingRequestID, AgencyID, RequestDate, RequestedBy, RequestPhone, RequestExt,
    RequestEmail, ParticipantCount, InvoiceNum, InvoiceDate, DueDate, AmtDue, IsActive)
SELECT CAST(JSON_VALUE(RawJson,'$.TrainingRequestID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.AgencyID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.RequestDate') AS DATETIME2(0)), JSON_VALUE(RawJson,'$.RequestedBy'),
       JSON_VALUE(RawJson,'$.RequestPhone'), TRY_CAST(JSON_VALUE(RawJson,'$.RequestExt') AS INT),
       JSON_VALUE(RawJson,'$.RequestEmail'), JSON_VALUE(RawJson,'$.NumParticpants'),
       JSON_VALUE(RawJson,'$.InvoiceNum'), TRY_CAST(JSON_VALUE(RawJson,'$.InvoiceDate') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.DueDate') AS DATETIME2(0)),
       TRY_CAST(JSON_VALUE(RawJson,'$.AmtDue') AS DECIMAL(19,4)),
       ISNULL(CAST(JSON_VALUE(RawJson,'$.Active') AS BIT),1)
FROM staging.RawRow WHERE SourceTable='tblTrainingRequests';

INSERT INTO core.TrainingRequestContact (TrainingRequestContactID, TrainingRequestID, ContactDate, Note)
SELECT CAST(JSON_VALUE(RawJson,'$.TrainingRequestContactID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.TrainingRequestID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.ContactDate') AS DATETIME2(0)), JSON_VALUE(RawJson,'$.Note')
FROM staging.RawRow WHERE SourceTable='tblTrainingRequestsContacts';

INSERT INTO core.TrainingRequestQuote (TrainingRequestQuoteID, TrainingRequestID, WorkshopTypeID, TopicRequested,
    Location, NumStudents, NumSessions, DatesRequested, TimesRequested, Duration, SpecialEquip, RequestAmt)
SELECT CAST(JSON_VALUE(RawJson,'$.TrainingRequestQuoteID') AS INT), TRY_CAST(JSON_VALUE(RawJson,'$.TrainingRequestID') AS INT),
       TRY_CAST(JSON_VALUE(RawJson,'$.WorkshopTypeID') AS INT), JSON_VALUE(RawJson,'$.TopicRequested'),
       JSON_VALUE(RawJson,'$.Location'), JSON_VALUE(RawJson,'$.NumStudents'),
       TRY_CAST(JSON_VALUE(RawJson,'$.NumSessions') AS INT), JSON_VALUE(RawJson,'$.DatesRequested'),
       JSON_VALUE(RawJson,'$.TimesRequested'), JSON_VALUE(RawJson,'$.Duration'),
       JSON_VALUE(RawJson,'$.SpecialEquip'), TRY_CAST(JSON_VALUE(RawJson,'$.RequestAmt') AS DECIMAL(19,4))
FROM staging.RawRow WHERE SourceTable='tblTrainingRequestsQuotes';

INSERT INTO core.TrainingRequestPayment (TrainingRequestID, PaymentID)
SELECT CAST(JSON_VALUE(RawJson,'$.TrainingRequestID') AS INT), CAST(JSON_VALUE(RawJson,'$.PaymentID') AS INT)
FROM staging.RawRow WHERE SourceTable='tblTrainingRequestsPayments';

-- Scheduled: 3 duplicate (TrainingRequestID, WorkshopID) pairs -> keep first, quarantine rest
;WITH s AS (
    SELECT RawRowID, JSON_VALUE(RawJson,'$.TrainingRequestID') AS TRID,
           JSON_VALUE(RawJson,'$.WorkshopID') AS WID,
           ROW_NUMBER() OVER (PARTITION BY JSON_VALUE(RawJson,'$.TrainingRequestID'),
                                           JSON_VALUE(RawJson,'$.WorkshopID')
                              ORDER BY RawRowID) AS rn,
           RawJson
    FROM staging.RawRow WHERE SourceTable='tblTrainingRequestsScheduled'
)
INSERT INTO staging.Quarantine (SourceTable, SourceRowID, Reason, RawJson)
SELECT 'tblTrainingRequestsScheduled', TRID, CONCAT('Duplicate (TrainingRequestID,WorkshopID) = (', TRID, ',', WID, ')'), RawJson
FROM s WHERE rn > 1;

;WITH s AS (
    SELECT JSON_VALUE(RawJson,'$.TrainingRequestID') AS TRID,
           JSON_VALUE(RawJson,'$.WorkshopID') AS WID,
           JSON_VALUE(RawJson,'$.ScheduledOn') AS OnDate,
           ROW_NUMBER() OVER (PARTITION BY JSON_VALUE(RawJson,'$.TrainingRequestID'),
                                           JSON_VALUE(RawJson,'$.WorkshopID')
                              ORDER BY RawRowID) AS rn
    FROM staging.RawRow WHERE SourceTable='tblTrainingRequestsScheduled'
)
INSERT INTO core.TrainingRequestScheduled (TrainingRequestID, WorkshopID, ScheduledOn)
SELECT TRY_CAST(TRID AS INT), TRY_CAST(WID AS INT), TRY_CAST(OnDate AS DATETIME2(0))
FROM s WHERE rn = 1;
GO

-- ---------------------------------------------------------------------
-- 8. Repair dangling references found during load.
--
--    The plan's integrity table (§2.5) only checked a handful of
--    relationships. The full load surfaced more, all of them genuine
--    missing parents in the SOURCE data (verified: the parent IDs do not
--    exist in the Access tables either).
--
--    Policy: keep the row, NULL the dangling FK, and record it in
--    staging.Quarantine so nothing disappears silently and staff can
--    review the affected records.
-- ---------------------------------------------------------------------

-- 8a. BoardMember -> Agency (36 rows, agency ids 5 and 31 do not exist)
--     These are re-pointed at the 'Unknown' agency (ID 0) rather than
--     nulled, so the board member stays attributable and shows up in
--     reports under a visible heading.
INSERT INTO staging.Quarantine (SourceTable, SourceRowID, Reason, RawJson)
SELECT 'tblBoardMembers', CAST(BoardID AS NVARCHAR(20)),
       CONCAT('Invalid AgencyID ', AgencyID, ' not found in tblAgencies; re-pointed to Unknown agency (0)'),
       (SELECT RawJson FROM staging.RawRow r
        WHERE r.SourceTable='tblBoardMembers'
          AND JSON_VALUE(r.RawJson,'$.BoardID') = CAST(core.BoardMember.BoardID AS NVARCHAR(20)))
FROM core.BoardMember
WHERE AgencyID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Agency a WHERE a.AgencyID = core.BoardMember.AgencyID);

UPDATE b SET AgencyID = 0
FROM core.BoardMember b
WHERE b.AgencyID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Agency a WHERE a.AgencyID = b.AgencyID);

-- 8b. Registration -> Payee (184 rows, 95 payee ids do not exist)
INSERT INTO staging.Quarantine (SourceTable, SourceRowID, Reason, RawJson)
SELECT 'tblRegistrations', CAST(r.RegistrationID AS NVARCHAR(20)),
       CONCAT('Orphan PayeeID ', r.PayeeID, ' not found in tblPayees; PayeeID nulled'),
       s.RawJson
FROM core.Registration r
JOIN staging.RawRow s ON s.SourceTable='tblRegistrations'
                     AND JSON_VALUE(s.RawJson,'$.RegistrationID') = CAST(r.RegistrationID AS NVARCHAR(20))
WHERE r.PayeeID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Payee p WHERE p.PayeeID = r.PayeeID);

UPDATE r SET PayeeID = NULL
FROM core.Registration r
WHERE r.PayeeID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Payee p WHERE p.PayeeID = r.PayeeID);

-- 8c. WorkshopSession -> Workshop (10 rows, 8 workshop ids do not exist)
INSERT INTO staging.Quarantine (SourceTable, SourceRowID, Reason, RawJson)
SELECT 'tblWorkshopSessions', CAST(s.WorkshopSessionID AS NVARCHAR(20)),
       CONCAT('Orphan WorkshopID ', s.WorkshopID, ' not found in tblWorkshops; WorkshopID nulled'),
       r.RawJson
FROM core.WorkshopSession s
JOIN staging.RawRow r ON r.SourceTable='tblWorkshopSessions'
                     AND JSON_VALUE(r.RawJson,'$.WorkshopSessionID') = CAST(s.WorkshopSessionID AS NVARCHAR(20))
WHERE s.WorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID = s.WorkshopID);

UPDATE s SET WorkshopID = NULL
FROM core.WorkshopSession s
WHERE s.WorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID = s.WorkshopID);

-- 8d. WorkshopPresenter -> Workshop (4 rows)
INSERT INTO staging.Quarantine (SourceTable, SourceRowID, Reason, RawJson)
SELECT 'tblWorkshopPresenters', CAST(p.WorkshopPresenterID AS NVARCHAR(20)),
       CONCAT('Orphan WorkshopID ', p.WorkshopID, ' not found in tblWorkshops; WorkshopID nulled'),
       r.RawJson
FROM core.WorkshopPresenter p
JOIN staging.RawRow r ON r.SourceTable='tblWorkshopPresenters'
                     AND JSON_VALUE(r.RawJson,'$.WorkshopPresenterID') = CAST(p.WorkshopPresenterID AS NVARCHAR(20))
WHERE p.WorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID = p.WorkshopID);

UPDATE p SET WorkshopID = NULL
FROM core.WorkshopPresenter p
WHERE p.WorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID = p.WorkshopID);

-- 8e. CreditSlip -> Participant / Workshop (2 + 1 + 2 rows)
INSERT INTO staging.Quarantine (SourceTable, SourceRowID, Reason, RawJson)
SELECT 'tblCreditSlips', CAST(c.CreditSlipID AS NVARCHAR(20)),
       CONCAT('Dangling reference(s) nulled: ',
              CASE WHEN c.ParticipantID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Participant p WHERE p.ParticipantID=c.ParticipantID) THEN 'ParticipantID ' ELSE '' END,
              CASE WHEN c.WorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID=c.WorkshopID) THEN 'WorkshopID ' ELSE '' END,
              CASE WHEN c.UsedWorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID=c.UsedWorkshopID) THEN 'UsedWorkshopID ' ELSE '' END,
              CASE WHEN c.UsedParticipantID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Participant p WHERE p.ParticipantID=c.UsedParticipantID) THEN 'UsedParticipantID' ELSE '' END),
       r.RawJson
FROM core.CreditSlip c
JOIN staging.RawRow r ON r.SourceTable='tblCreditSlips'
                     AND JSON_VALUE(r.RawJson,'$.CreditSlipID') = CAST(c.CreditSlipID AS NVARCHAR(20))
WHERE (c.ParticipantID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Participant p WHERE p.ParticipantID=c.ParticipantID))
   OR (c.WorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID=c.WorkshopID))
   OR (c.UsedWorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID=c.UsedWorkshopID))
   OR (c.UsedParticipantID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Participant p WHERE p.ParticipantID=c.UsedParticipantID));

UPDATE c SET
    ParticipantID     = CASE WHEN c.ParticipantID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Participant p WHERE p.ParticipantID=c.ParticipantID) THEN NULL ELSE c.ParticipantID END,
    WorkshopID        = CASE WHEN c.WorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID=c.WorkshopID) THEN NULL ELSE c.WorkshopID END,
    UsedWorkshopID    = CASE WHEN c.UsedWorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID=c.UsedWorkshopID) THEN NULL ELSE c.UsedWorkshopID END,
    UsedParticipantID = CASE WHEN c.UsedParticipantID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Participant p WHERE p.ParticipantID=c.UsedParticipantID) THEN NULL ELSE c.UsedParticipantID END
FROM core.CreditSlip c
WHERE (c.ParticipantID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Participant p WHERE p.ParticipantID=c.ParticipantID))
   OR (c.WorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID=c.WorkshopID))
   OR (c.UsedWorkshopID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopID=c.UsedWorkshopID))
   OR (c.UsedParticipantID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.Participant p WHERE p.ParticipantID=c.UsedParticipantID));
GO

-- 8f. Inverted workshop date ranges (9 rows: StartDate > EndDate).
--
--     Corrected from the authoritative source: the actual session dates in
--     core.WorkshopSession. Each row is fixed individually because the
--     errors are not uniform — some have a wrong EndDate, some a wrong
--     StartDate, and two have a year typo.
--
--     The original values are preserved in audit.ChangeLog.
-- ---------------------------------------------------------------------
INSERT INTO audit.ChangeLog (SchemaName, TableName, RecordID, Action, ChangedBy, OldValues, NewValues)
SELECT 'core', 'Workshop', CAST(WorkshopID AS NVARCHAR(20)), 'U', 'etl:date-fix',
       CONCAT('{"StartDate":"', CONVERT(NVARCHAR(30), StartDate, 126), '","EndDate":"', CONVERT(NVARCHAR(30), EndDate, 126), '"}'),
       '{"fixed":"session-derived"}'
FROM core.Workshop
WHERE StartDate IS NOT NULL AND EndDate IS NOT NULL AND StartDate > EndDate;

-- ID 62:    Start 10/25, End 10/24 (same year, End off by one day).
--           Session on 10/27 -> both dates should bracket it.
UPDATE core.Workshop SET StartDate='2010-10-27', EndDate='2010-10-27' WHERE WorkshopID=62;

-- ID 143:   End 2008-05-21 is missing the year (sessions run to 2009-05-21).
UPDATE core.Workshop SET EndDate='2009-05-21' WHERE WorkshopID=143;

-- ID 803:   End 2010-10-25 is a year typo; sessions are 10/18 and 10/25 2012.
UPDATE core.Workshop SET EndDate='2012-10-25' WHERE WorkshopID=803;

-- ID 1588:  End 10/13 vs session 10/17 -> End should be the session date.
UPDATE core.Workshop SET EndDate='2013-10-17' WHERE WorkshopID=1588;

-- ID 1879:  Start 10/27 vs session 10/23 -> Start should be the session date.
UPDATE core.Workshop SET StartDate='2015-10-23' WHERE WorkshopID=1879;

-- ID 1919:  Start 4/5, End 3/8 (End is an earlier session in the series).
--           Single recorded session is 4/5/2017.
UPDATE core.Workshop SET EndDate='2017-04-05' WHERE WorkshopID=1919;

-- ID 1942:  Start 2/8, End 1/11 -> End should be the session date.
UPDATE core.Workshop SET EndDate='2017-02-08' WHERE WorkshopID=1942;

-- ID 1950:  Start 3/8, End 2/8 -> End should be the session date.
UPDATE core.Workshop SET EndDate='2017-03-08' WHERE WorkshopID=1950;

-- ID 2933:  End 2026-04-26 is a year typo; last session is 2027-04-27.
UPDATE core.Workshop SET EndDate='2027-04-27' WHERE WorkshopID=2933;

-- With all 9 ranges corrected, the constraint the plan called for can be
-- added and enforced from here on.
ALTER TABLE core.Workshop
    ADD CONSTRAINT CK_Workshop_Dates CHECK (EndDate IS NULL OR StartDate IS NULL OR EndDate >= StartDate);
GO

-- ---------------------------------------------------------------------
-- 9. Foreign keys (the reset at the top drops them; all are re-added here)
--
--    The two Registration FKs were deferred in schema.sql because of the
--    4 orphan rows. Those are quarantined, and the dangling PayeeID
--    references are nulled above, so every FK can now be enforced.
-- ---------------------------------------------------------------------
ALTER TABLE core.AgencyMailAddress
    ADD CONSTRAINT FK_AgencyMailAddress_Agency FOREIGN KEY (AgencyID) REFERENCES core.Agency(AgencyID);
ALTER TABLE core.BoardMember
    ADD CONSTRAINT FK_BoardMember_Agency FOREIGN KEY (AgencyID) REFERENCES core.Agency(AgencyID);
ALTER TABLE core.Registration
    ADD CONSTRAINT FK_Registration_Participant FOREIGN KEY (ParticipantID) REFERENCES core.Participant(ParticipantID);
ALTER TABLE core.Registration
    ADD CONSTRAINT FK_Registration_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);

-- The rest mirror the inline REFERENCES clauses in schema.sql.
ALTER TABLE core.Agency ADD CONSTRAINT FK_Agency_County        FOREIGN KEY (CountyID)      REFERENCES ref.County(CountyID);
ALTER TABLE core.Agency ADD CONSTRAINT FK_Agency_StreetType    FOREIGN KEY (StreetTypeID)  REFERENCES ref.StreetType(StreetTypeID);
ALTER TABLE core.Agency ADD CONSTRAINT FK_Agency_City          FOREIGN KEY (CityID)        REFERENCES ref.City(CityID);
ALTER TABLE core.Agency ADD CONSTRAINT FK_Agency_State         FOREIGN KEY (StateID)       REFERENCES ref.State(StateID);
ALTER TABLE core.Agency ADD CONSTRAINT FK_Agency_AgencyType    FOREIGN KEY (AgencyTypeID)  REFERENCES ref.AgencyType(AgencyTypeID);
ALTER TABLE core.Agency ADD CONSTRAINT FK_Agency_FacilityType  FOREIGN KEY (FacilityTypeID) REFERENCES ref.FacilityType(FacilityTypeID);

ALTER TABLE core.AgencyMailAddress ADD CONSTRAINT FK_AgencyMailAddress_StreetType FOREIGN KEY (StreetTypeID) REFERENCES ref.StreetType(StreetTypeID);
ALTER TABLE core.AgencyMailAddress ADD CONSTRAINT FK_AgencyMailAddress_City       FOREIGN KEY (CityID)       REFERENCES ref.City(CityID);
ALTER TABLE core.AgencyMailAddress ADD CONSTRAINT FK_AgencyMailAddress_State      FOREIGN KEY (StateID)      REFERENCES ref.State(StateID);

ALTER TABLE core.Participant ADD CONSTRAINT FK_Participant_Salutation FOREIGN KEY (SalutationID) REFERENCES ref.Salutation(SalutationID);
ALTER TABLE core.Participant ADD CONSTRAINT FK_Participant_Agency     FOREIGN KEY (AgencyID)     REFERENCES core.Agency(AgencyID);
ALTER TABLE core.Participant ADD CONSTRAINT FK_Participant_StreetType FOREIGN KEY (StreetTypeID) REFERENCES ref.StreetType(StreetTypeID);
ALTER TABLE core.Participant ADD CONSTRAINT FK_Participant_City       FOREIGN KEY (CityID)       REFERENCES ref.City(CityID);
ALTER TABLE core.Participant ADD CONSTRAINT FK_Participant_State      FOREIGN KEY (StateID)      REFERENCES ref.State(StateID);

ALTER TABLE core.Payment ADD CONSTRAINT FK_Payment_PaymentMethod FOREIGN KEY (PaymentMethodID) REFERENCES ref.PaymentMethod(PaymentMethodID);
ALTER TABLE core.Payment ADD CONSTRAINT FK_Payment_Payee         FOREIGN KEY (PayeeID)         REFERENCES core.Payee(PayeeID);
ALTER TABLE core.Payment ADD CONSTRAINT FK_Payment_SchoolYear    FOREIGN KEY (SchoolYearID)    REFERENCES ref.SchoolYear(SchoolYearID);

ALTER TABLE core.WorkshopName ADD CONSTRAINT FK_WorkshopName_Age FOREIGN KEY (AgesID) REFERENCES ref.Age(AgesID);

ALTER TABLE core.Workshop ADD CONSTRAINT FK_Workshop_WorkshopName FOREIGN KEY (WorkshopNameID) REFERENCES core.WorkshopName(WorkshopNameID);
ALTER TABLE core.Workshop ADD CONSTRAINT FK_Workshop_EvalType     FOREIGN KEY (EvalTypeID)     REFERENCES ref.EvalType(EvalTypeID);
ALTER TABLE core.Workshop ADD CONSTRAINT FK_Workshop_Component    FOREIGN KEY (ComponentID)    REFERENCES ref.Component(ComponentID);
ALTER TABLE core.Workshop ADD CONSTRAINT FK_Workshop_Category     FOREIGN KEY (CategoryID)     REFERENCES ref.Category(CategoryID);
ALTER TABLE core.Workshop ADD CONSTRAINT FK_Workshop_Agency       FOREIGN KEY (AgencyID)       REFERENCES core.Agency(AgencyID);
ALTER TABLE core.Workshop ADD CONSTRAINT FK_Workshop_SchoolYear   FOREIGN KEY (SchoolYearID)   REFERENCES ref.SchoolYear(SchoolYearID);

ALTER TABLE core.WorkshopSession ADD CONSTRAINT FK_WorkshopSession_Workshop   FOREIGN KEY (WorkshopID)   REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopSession ADD CONSTRAINT FK_WorkshopSession_BackUpTime FOREIGN KEY (BackUpTimeID) REFERENCES ref.BackupTime(BackupTimeID);

ALTER TABLE core.PresenterStaff ADD CONSTRAINT FK_PresenterStaff_Salutation FOREIGN KEY (SalutationID) REFERENCES ref.Salutation(SalutationID);
ALTER TABLE core.PresenterStaff ADD CONSTRAINT FK_PresenterStaff_Agency     FOREIGN KEY (AgencyID)     REFERENCES core.Agency(AgencyID);
ALTER TABLE core.PresenterStaff ADD CONSTRAINT FK_PresenterStaff_City       FOREIGN KEY (CityID)       REFERENCES ref.City(CityID);
ALTER TABLE core.PresenterStaff ADD CONSTRAINT FK_PresenterStaff_State      FOREIGN KEY (StateID)      REFERENCES ref.State(StateID);

ALTER TABLE core.WorkshopPresenter ADD CONSTRAINT FK_WorkshopPresenter_Presenter FOREIGN KEY (PresenterID) REFERENCES core.PresenterStaff(PresenterStaffID);
ALTER TABLE core.WorkshopPresenter ADD CONSTRAINT FK_WorkshopPresenter_Workshop  FOREIGN KEY (WorkshopID)  REFERENCES core.Workshop(WorkshopID);

ALTER TABLE core.Registration ADD CONSTRAINT FK_Registration_CreditType      FOREIGN KEY (CreditTypeID)      REFERENCES ref.CreditType(CreditTypeID);
ALTER TABLE core.Registration ADD CONSTRAINT FK_Registration_Payment         FOREIGN KEY (PaymentID)         REFERENCES core.Payment(PaymentID);
ALTER TABLE core.Registration ADD CONSTRAINT FK_Registration_PaymentMethod   FOREIGN KEY (PaymentMethodID)   REFERENCES ref.PaymentMethod(PaymentMethodID);
ALTER TABLE core.Registration ADD CONSTRAINT FK_Registration_Payee           FOREIGN KEY (PayeeID)           REFERENCES core.Payee(PayeeID);

ALTER TABLE core.CreditSlip ADD CONSTRAINT FK_CreditSlip_Category        FOREIGN KEY (CreditSlipsCategoryID) REFERENCES ref.CreditSlipCategory(CreditSlipsCategoryID);
ALTER TABLE core.CreditSlip ADD CONSTRAINT FK_CreditSlip_Participant     FOREIGN KEY (ParticipantID)         REFERENCES core.Participant(ParticipantID);
ALTER TABLE core.CreditSlip ADD CONSTRAINT FK_CreditSlip_Workshop        FOREIGN KEY (WorkshopID)            REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.CreditSlip ADD CONSTRAINT FK_CreditSlip_UsedWorkshop    FOREIGN KEY (UsedWorkshopID)        REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.CreditSlip ADD CONSTRAINT FK_CreditSlip_UsedParticipant FOREIGN KEY (UsedParticipantID)     REFERENCES core.Participant(ParticipantID);

ALTER TABLE core.EvalQuestion ADD CONSTRAINT FK_EvalQuestion_EvalType     FOREIGN KEY (EvaluationTypeID) REFERENCES ref.EvalType(EvalTypeID);
ALTER TABLE core.EvalQuestion ADD CONSTRAINT FK_EvalQuestion_QuestionType FOREIGN KEY (EvalQuestTypeID)  REFERENCES ref.EvalQuestionType(EvalQuestTypeID);

ALTER TABLE core.WorkshopEvalQuestion ADD CONSTRAINT FK_WEQ_Workshop  FOREIGN KEY (WorkshopID)  REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopEvalQuestion ADD CONSTRAINT FK_WEQ_Question  FOREIGN KEY (EvalQuestID) REFERENCES core.EvalQuestion(EvalQuestID);

ALTER TABLE core.WorkshopComment ADD CONSTRAINT FK_WorkshopComment_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopPresenterComment ADD CONSTRAINT FK_WPC_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopDesiredTopic ADD CONSTRAINT FK_WDT_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopDesiredTopic ADD CONSTRAINT FK_WDT_Category FOREIGN KEY (DesiredTopicCategoryID) REFERENCES ref.DesiredTopicCategory(DesiredTopicCategoryID);
ALTER TABLE core.WorkshopPreferredTime ADD CONSTRAINT FK_WPT_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopPreferredTime ADD CONSTRAINT FK_WPT_PreferredTime FOREIGN KEY (PreferredTimeID) REFERENCES ref.PreferredTime(PreferredTimesID);
ALTER TABLE core.WorkshopReferral ADD CONSTRAINT FK_WR_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopReferral ADD CONSTRAINT FK_WR_ReferralType FOREIGN KEY (ReferralTypeID) REFERENCES ref.ReferralType(ReferralTypeID);
ALTER TABLE core.WorkshopLikedMost ADD CONSTRAINT FK_WLM_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopLikedLeast ADD CONSTRAINT FK_WLL_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopPractice ADD CONSTRAINT FK_WP_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopSummaryCount ADD CONSTRAINT FK_WSC_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.WorkshopSummaryCount ADD CONSTRAINT FK_WSC_CountType FOREIGN KEY (CountTypeID) REFERENCES ref.SummaryCountType(SummaryCountTypeID);
ALTER TABLE core.OtherCount ADD CONSTRAINT FK_OtherCount_Other FOREIGN KEY (OtherID) REFERENCES ref.Other(OtherID);
ALTER TABLE core.OtherCount ADD CONSTRAINT FK_OtherCount_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);

ALTER TABLE core.CommunityEvent ADD CONSTRAINT FK_CommunityEvent_Component FOREIGN KEY (ComponentID) REFERENCES ref.Component(ComponentID);
ALTER TABLE core.CommunityEvent ADD CONSTRAINT FK_CommunityEvent_EventType FOREIGN KEY (EventTypeID) REFERENCES ref.EventType(EventTypeID);
ALTER TABLE core.CommunityEventStaff ADD CONSTRAINT FK_CommunityEventStaff_Event FOREIGN KEY (EventID) REFERENCES core.CommunityEvent(EventID);

ALTER TABLE core.TrainingRequest ADD CONSTRAINT FK_TrainingRequest_Agency FOREIGN KEY (AgencyID) REFERENCES core.Agency(AgencyID);
ALTER TABLE core.TrainingRequestContact ADD CONSTRAINT FK_TRC_Request FOREIGN KEY (TrainingRequestID) REFERENCES core.TrainingRequest(TrainingRequestID);
ALTER TABLE core.TrainingRequestQuote ADD CONSTRAINT FK_TRQ_Request FOREIGN KEY (TrainingRequestID) REFERENCES core.TrainingRequest(TrainingRequestID);
ALTER TABLE core.TrainingRequestQuote ADD CONSTRAINT FK_TRQ_WorkshopType FOREIGN KEY (WorkshopTypeID) REFERENCES ref.EvalType(EvalTypeID);
ALTER TABLE core.TrainingRequestScheduled ADD CONSTRAINT FK_TRS_Request FOREIGN KEY (TrainingRequestID) REFERENCES core.TrainingRequest(TrainingRequestID);
ALTER TABLE core.TrainingRequestScheduled ADD CONSTRAINT FK_TRS_Workshop FOREIGN KEY (WorkshopID) REFERENCES core.Workshop(WorkshopID);
ALTER TABLE core.TrainingRequestPayment ADD CONSTRAINT FK_TRP_Request FOREIGN KEY (TrainingRequestID) REFERENCES core.TrainingRequest(TrainingRequestID);
ALTER TABLE core.TrainingRequestPayment ADD CONSTRAINT FK_TRP_Payment FOREIGN KEY (PaymentID) REFERENCES core.Payment(PaymentID);
GO

-- ---------------------------------------------------------------------
-- 9. Review view for Q2 (negative payments)
-- ---------------------------------------------------------------------
CREATE OR ALTER VIEW core.vw_NegativePayment
AS
SELECT r.RegistrationID, r.ParticipantID, p.LastName, p.FirstName,
       r.WorkshopID, w.WorkshopCode, r.PaidAmount, r.RegistrationDate, r.IsCancelled
FROM core.Registration r
JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
WHERE r.PaidAmount < 0;
GO

PRINT '=== TRANSFORM COMPLETE ===';
GO
