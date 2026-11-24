-- =====================================================================
--  018 - Repair mojibake in stored School Cash match notes
--
--  An em dash in the "new purchaser" note was written as UTF-8 bytes that
--  were then read back as Latin-1, so the text stored in core.ScoRow is
--  "New purchaser a-euro-quote no participant..." instead of "New purchaser
--  - no participant...".
--
--  The source string is fixed, so this only repairs rows staged before that
--  fix. Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

-- The three bytes of a UTF-8 em dash, misread as Latin-1, appear as the
-- characters below. Replaced with a plain hyphen, which is what the note
-- says now.
UPDATE core.ScoRow
   SET MatchNote = REPLACE(MatchNote, NCHAR(0x00E2) + NCHAR(0x20AC) + NCHAR(0x201D), N'-')
 WHERE MatchNote LIKE N'%' + NCHAR(0x00E2) + NCHAR(0x20AC) + NCHAR(0x201D) + N'%';

PRINT 'core.ScoRow.MatchNote repaired: ' + CAST(@@ROWCOUNT AS NVARCHAR(10));
GO

-- The same corruption can appear in any other note written with a dash.
UPDATE core.ScoRow
   SET MatchNote = REPLACE(MatchNote, NCHAR(0x00E2) + NCHAR(0x20AC) + NCHAR(0x201C), N'-')
 WHERE MatchNote LIKE N'%' + NCHAR(0x00E2) + NCHAR(0x20AC) + NCHAR(0x201C) + N'%';
GO
