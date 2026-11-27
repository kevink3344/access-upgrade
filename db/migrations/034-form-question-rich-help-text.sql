-- =====================================================================
--  034 - Rich help text on form questions
--
--  Staff want the help text under a question to carry a short list, a
--  couple of bold phrases, and a link — the kind of thing a plain 300
--  character input cannot express. It is now stored as a small subset of
--  HTML (bold, italic, underline, lists, links, line breaks), produced by
--  a rich-text editor in the Form Designer and sanitised again when the
--  public page renders it.
--
--  NVARCHAR(MAX) rather than a larger fixed size: the markup is roughly
--  five times the visible text, and a bulleted list of five lines already
--  passes 300 characters once tagged.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('core.FormQuestion', 'HelpText') IS NOT NULL
   AND EXISTS (
        SELECT 1 FROM sys.columns
         WHERE object_id = OBJECT_ID('core.FormQuestion')
           AND name = 'HelpText'
           AND max_length <> -1
   )
BEGIN
    ALTER TABLE core.FormQuestion ALTER COLUMN HelpText NVARCHAR(MAX) NULL;
    PRINT 'core.FormQuestion.HelpText widened to NVARCHAR(MAX)';
END
ELSE
    PRINT 'core.FormQuestion.HelpText is already NVARCHAR(MAX) (or the table is absent)';
GO
