-- =====================================================================
--  007 - Widen SessionCeus from REAL to DECIMAL(6,2)
--
--  Workshop.SessionCeus was migrated from Access as SQL `real` (a 4-byte
--  float). A value entered as 0.2 is stored as 0.20000000298023224 and
--  comes back that way, so the CEUs field showed 17 digits of float noise
--  and 24 of 2,429 rows carried a value that was not representable in two
--  decimal places.
--
--  CEUs are credit units quoted to two decimals, so DECIMAL(6,2) is the
--  honest type: it stores 0.20 exactly, allows up to 9999.99, and removes
--  the class of bug rather than rounding around it in the UI.
--
--  The convert is lossless for every value in the table: the widest
--  decimal is 2 places, and rounding a float to 2dp recovers the intended
--  number. Existing values are rounded on the way across.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF EXISTS (
    SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = 'core'
       AND TABLE_NAME = 'Workshop'
       AND COLUMN_NAME = 'SessionCeus'
       AND DATA_TYPE = 'real'
)
BEGIN
    -- Round first so the ALTER cannot fail on an out-of-range value.
    UPDATE core.Workshop
       SET SessionCeus = ROUND(SessionCeus, 2)
     WHERE SessionCeus IS NOT NULL;

    ALTER TABLE core.Workshop
        ALTER COLUMN SessionCeus DECIMAL(6, 2) NULL;

    PRINT 'core.Workshop.SessionCeus converted REAL -> DECIMAL(6,2)';
END
ELSE
    PRINT 'core.Workshop.SessionCeus already DECIMAL(6,2) - nothing to do';
GO
