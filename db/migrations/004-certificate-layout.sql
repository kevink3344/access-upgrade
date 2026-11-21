-- =====================================================================
--  004 - Certificate layout: portrait or landscape
--
--  Staff asked to toggle the certificate between portrait and landscape.
--  The original Access template was landscape; the rebuild was portrait.
--  Storing the choice per template means a school year can have either,
--  and a reissued certificate keeps the orientation it was issued with.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF COL_LENGTH('core.CertificateTemplate', 'Layout') IS NULL
BEGIN
    ALTER TABLE core.CertificateTemplate
        ADD Layout NVARCHAR(10) NOT NULL
            CONSTRAINT DF_CertificateTemplate_Layout DEFAULT 'portrait';
    PRINT 'Added core.CertificateTemplate.Layout';
END
ELSE PRINT 'core.CertificateTemplate.Layout already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_CertificateTemplate_Layout'
       AND parent_object_id = OBJECT_ID('core.CertificateTemplate')
)
BEGIN
    ALTER TABLE core.CertificateTemplate
        ADD CONSTRAINT CK_CertificateTemplate_Layout
        CHECK (Layout IN ('portrait', 'landscape'));
    PRINT 'Added CK_CertificateTemplate_Layout';
END
ELSE PRINT 'CK_CertificateTemplate_Layout already exists';
GO

SELECT Layout, COUNT(*) AS Templates
  FROM core.CertificateTemplate
 GROUP BY Layout;
GO
