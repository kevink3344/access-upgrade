-- =====================================================================
--  002 - Remove the duplicate Maddi Abrams presenter record
--
--  Staff confirmed that Maddi Abrams is a real staff member and that the
--  record with the email address is the one to keep.
--
--  PresenterStaffID 152: no email, no phone, zero references anywhere.
--  PresenterStaffID 154: mabrams@wcpss.net, and the one WorkshopSession
--                        row that points at either record.
--
--  Only 152 is removed. 154 is untouched.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF EXISTS (
    SELECT 1 FROM core.PresenterStaff
     WHERE PresenterStaffID = 152
       AND FirstName = 'Maddi'
       AND LastName = 'Abrams'
       AND HomeEmail IS NULL
)
BEGIN
    -- Refuse if anything still points at it, rather than relying on the FK
    -- to fail. A presenter that taught workshops should be retired, not
    -- deleted, because the workshop history would lose its presenter.
    IF EXISTS (SELECT 1 FROM core.WorkshopPresenter WHERE PresenterID = 152)
    BEGIN
        PRINT 'ABORT: PresenterStaffID 152 is attached to workshops; retiring instead is required';
    END
    ELSE
    BEGIN
        DELETE FROM core.PresenterStaff WHERE PresenterStaffID = 152;
        PRINT 'Deleted PresenterStaffID 152 (duplicate Maddi Abrams, no email)';
    END
END
ELSE PRINT 'PresenterStaffID 152 is not present or is no longer the expected duplicate';
GO

-- Confirm exactly one Maddi Abrams remains, and it is the one with an email.
IF (SELECT COUNT(*) FROM core.PresenterStaff WHERE FirstName = 'Maddi' AND LastName = 'Abrams') <> 1
    PRINT 'WARNING: expected exactly one Maddi Abrams record';
ELSE PRINT 'Verified: one Maddi Abrams record remains';
GO
