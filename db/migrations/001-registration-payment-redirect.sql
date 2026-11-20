-- =====================================================================
--  001 - Redirect to payment link after public registration
--
--  Staff can send a registrant straight to a payment page after they
--  submit the public form. Both columns are nullable/off by default, so
--  existing links are unaffected.
--
--  Guarded and safe to re-run. Apply to BOTH databases:
--    production: project-enlightenment
--    test:       project-enlightenment-test
-- =====================================================================

SET NOCOUNT ON;
GO

IF COL_LENGTH('core.WorkshopRegistrationLink', 'RedirectToPayment') IS NULL
BEGIN
    ALTER TABLE core.WorkshopRegistrationLink
        ADD RedirectToPayment BIT NOT NULL
            CONSTRAINT DF_RegistrationLink_Redirect DEFAULT 0;
    PRINT 'core.WorkshopRegistrationLink.RedirectToPayment added';
END
ELSE PRINT 'core.WorkshopRegistrationLink.RedirectToPayment already exists';
GO

IF COL_LENGTH('core.WorkshopRegistrationLink', 'PaymentUrl') IS NULL
BEGIN
    ALTER TABLE core.WorkshopRegistrationLink
        ADD PaymentUrl NVARCHAR(500) NULL;
    PRINT 'core.WorkshopRegistrationLink.PaymentUrl added';
END
ELSE PRINT 'core.WorkshopRegistrationLink.PaymentUrl already exists';
GO

-- A redirect is only meaningful with a destination. Enforced in the API as
-- well, but the database should not accept a half-configured link.
IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints WHERE name = 'CK_RegistrationLink_PaymentUrl'
)
BEGIN
    ALTER TABLE core.WorkshopRegistrationLink
        ADD CONSTRAINT CK_RegistrationLink_PaymentUrl
            CHECK (RedirectToPayment = 0 OR PaymentUrl IS NOT NULL);
    PRINT 'CK_RegistrationLink_PaymentUrl added';
END
ELSE PRINT 'CK_RegistrationLink_PaymentUrl already exists';
GO
