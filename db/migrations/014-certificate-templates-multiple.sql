-- =====================================================================
--  014 - Certificate templates: several per school year
--
--  A school year had exactly one CEU and one CHC certificate, enforced by
--  UQ_CertificateTemplate (SchoolYearID, CertificateType). Staff need more
--  than one of each in a year - a director's certificate and a teacher's,
--  say - so the pair is no longer unique.
--
--  A Name is added to tell them apart. It is nullable because the existing
--  rows have no natural name; they are backfilled from the year and type so
--  the list is readable rather than showing blanks.
--
--  The year tie stays: a certificate is still issued for a school year, and
--  the template still belongs to one. Only the "exactly one per type" rule
--  goes away.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF COL_LENGTH('core.CertificateTemplate', 'Name') IS NULL
    ALTER TABLE core.CertificateTemplate ADD Name NVARCHAR(100) NULL;
ELSE
    PRINT 'core.CertificateTemplate.Name already exists';
GO

-- Backfill a readable name for the rows that predate the column. SQL Server
-- does not allow an alias on the UPDATE target, so the table is named and the
-- join aliased instead.
UPDATE core.CertificateTemplate
   SET Name = CONCAT(t.CertificateType, ' ', sy.SchoolYear)
  FROM core.CertificateTemplate t
  JOIN ref.SchoolYear sy ON sy.SchoolYearID = t.SchoolYearID
 WHERE t.CertificateTemplateID = core.CertificateTemplate.CertificateTemplateID
   AND t.Name IS NULL;

PRINT 'template names backfilled: ' + CAST(@@ROWCOUNT AS NVARCHAR(10));
GO

-- Drop the one-per-type rule. The constraint name is looked up rather than
-- assumed, because it was created inline and may carry a generated name.
DECLARE @uq sysname;
SELECT @uq = kc.name
  FROM sys.key_constraints kc
 WHERE kc.parent_object_id = OBJECT_ID('core.CertificateTemplate')
   AND kc.type = 'UQ'
   AND kc.name = 'UQ_CertificateTemplate';

IF @uq IS NOT NULL
BEGIN
    EXEC('ALTER TABLE core.CertificateTemplate DROP CONSTRAINT ' + @uq);
    PRINT 'dropped UQ_CertificateTemplate';
END
ELSE
    PRINT 'UQ_CertificateTemplate already dropped';
GO

-- A plain index replaces it: the lookup is still "templates for this year and
-- type", it just may now return several.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_CertificateTemplate_Year_Type'
       AND object_id = OBJECT_ID('core.CertificateTemplate')
)
    CREATE INDEX IX_CertificateTemplate_Year_Type
        ON core.CertificateTemplate(SchoolYearID, CertificateType);
GO
