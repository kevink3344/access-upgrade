-- =====================================================================
--  032 - Per-form header image
--
--  Staff want a form to open with their own banner instead of the
--  standard Project Enlightenment lockup. The image is one combined
--  banner they make themselves, so the page renders a single <img> —
--  there is no compositing here.
--
--  The bytes reuse core.CertificateAsset rather than a second image
--  store: the upload path, the 2 MB ceiling, the content-type allowlist
--  and the SHA-256 de-duplication are already built and tested there.
--  Two forms sharing a banner therefore store the bytes once.
--
--  The image attaches to the TEMPLATE, not to a version. A banner is
--  branding, not content: pinning it per version would mean re-uploading
--  it every time someone fixed a typo in a question, and a form that
--  silently lost its banner on publish would look broken.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

SET QUOTED_IDENTIFIER ON;
GO

-- Widen the kind check to admit the new kind. The old constraint name is
-- stable (it comes from migration 003), but drop by name only when it is
-- still the narrow version, so a re-run is a no-op.
IF EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_CertificateAsset_Kind'
       AND parent_object_id = OBJECT_ID('core.CertificateAsset')
       AND definition NOT LIKE '%form-header%'
)
BEGIN
    ALTER TABLE core.CertificateAsset DROP CONSTRAINT CK_CertificateAsset_Kind;
    ALTER TABLE core.CertificateAsset ADD CONSTRAINT CK_CertificateAsset_Kind
        CHECK (AssetKind IN ('template-logo', 'participant-image', 'form-header'));
    PRINT 'CK_CertificateAsset_Kind widened to include form-header';
END
ELSE
    PRINT 'CK_CertificateAsset_Kind already admits form-header';
GO

-- One optional header per form. Deleting the form must not delete the
-- asset: another form may be using the same bytes.
IF COL_LENGTH('core.FormTemplate', 'HeaderAssetID') IS NULL
    ALTER TABLE core.FormTemplate
        ADD HeaderAssetID INT NULL
            CONSTRAINT FK_FormTemplate_HeaderAsset
            REFERENCES core.CertificateAsset (CertificateAssetID);
ELSE
    PRINT 'core.FormTemplate.HeaderAssetID already exists';
GO

-- Alt text travels with the image. The banner's heading is inside the
-- pixels, so a screen reader gets nothing from it without this.
IF COL_LENGTH('core.FormTemplate', 'HeaderAltText') IS NULL
    ALTER TABLE core.FormTemplate ADD HeaderAltText NVARCHAR(200) NULL;
ELSE
    PRINT 'core.FormTemplate.HeaderAltText already exists';
GO

-- The kind check must admit 'form-header' on a from-scratch build too.
IF EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_CertificateAsset_Kind'
       AND parent_object_id = OBJECT_ID('core.CertificateAsset')
       AND definition NOT LIKE '%form-header%'
)
BEGIN
    ALTER TABLE core.CertificateAsset DROP CONSTRAINT CK_CertificateAsset_Kind;
    ALTER TABLE core.CertificateAsset ADD CONSTRAINT CK_CertificateAsset_Kind
        CHECK (AssetKind IN ('template-logo', 'participant-image', 'form-header'));
END
GO
