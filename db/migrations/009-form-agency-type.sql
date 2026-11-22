-- =====================================================================
--  009 - Form Designer: "agency" field type
--
--  The built-in "School or agency" question is not a static option list: its
--  choices come from core.Agency, searched live as the registrant types. That
--  made it impossible to model as a plain `select` in the designer - staff
--  could not add or remove the values, and the options editor was meaningless
--  for it.
--
--  `agency` is now its own field type. A question of this type renders the
--  existing type-ahead picker and stores the chosen core.Agency.AgencyID.
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
       AND definition NOT LIKE '%agency%'
)
BEGIN
    ALTER TABLE core.FormQuestion DROP CONSTRAINT CK_FormQuestion_FieldType;

    ALTER TABLE core.FormQuestion
        ADD CONSTRAINT CK_FormQuestion_FieldType
        CHECK (FieldType IN ('text', 'longtext', 'number', 'select', 'radio', 'checkbox', 'agency'));

    PRINT 'widened CK_FormQuestion_FieldType to include agency';
END
ELSE
    PRINT 'CK_FormQuestion_FieldType already allows agency - nothing to do';
GO

-- The built-in agency question was seeded as `select`. Move any existing
-- built-in row onto the new type so the editor shows the right control.
UPDATE core.FormQuestion
   SET FieldType = 'agency'
 WHERE QuestionKey = 'agency'
   AND MapsToColumn = 'Participant.AgencyID'
   AND FieldType = 'select';

PRINT 'agency questions retyped: ' + CAST(@@ROWCOUNT AS NVARCHAR(10));
GO
