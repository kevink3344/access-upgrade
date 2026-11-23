-- =====================================================================
--  013 - Form Designer: "session" field type
--
--  A form can now ask which of the workshop's sessions the registrant will
--  attend. The choices are not a static list: they are the rows on the
--  workshop's Sessions tab, resolved when the public page loads.
--
--  `session` is therefore its own field type, like `agency` in 009. The
--  chosen session's label (e.g. "10:00 AM – 11:00 AM") is stored as the
--  answer text, so it stays readable after a session is edited or deleted.
--
--  Widens the CHECK constraint only; no data change.
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_FormQuestion_FieldType'
       AND parent_object_id = OBJECT_ID('core.FormQuestion')
       AND definition NOT LIKE '%session%'
)
BEGIN
    ALTER TABLE core.FormQuestion DROP CONSTRAINT CK_FormQuestion_FieldType;

    ALTER TABLE core.FormQuestion
        ADD CONSTRAINT CK_FormQuestion_FieldType
        CHECK (FieldType IN ('text', 'longtext', 'number', 'select', 'radio', 'checkbox', 'agency', 'session'));

    PRINT 'widened CK_FormQuestion_FieldType to include session';
END
ELSE
    PRINT 'CK_FormQuestion_FieldType already allows session - nothing to do';
GO
