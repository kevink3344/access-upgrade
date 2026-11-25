-- =====================================================================
--  022 - Classify School Cash items: workshop vs site booking vs discount
--
--  The Item Order Report mixes three kinds of line under one "Item Name":
--
--    - a workshop the programme runs, e.g. "Handwriting: The Building Blocks"
--    - a site booking, "<Site> - Group Registration" — a school buying a day
--    - a discount, "<Workshop> - Classroom Discount" — a second teacher from
--      the same school
--
--  Only the first can resolve to a workshop. The other two can never match,
--  so they sat in the review queue looking like items nobody had got to,
--  inflating the "unresolved" count and hiding the ones that genuinely need
--  a workshop chosen.
--
--  ItemKind records the classification at upload time. It is advisory: an
--  admin can still resolve any item by hand. It exists so the screen can say
--  "12 workshops to choose, 3 site bookings" instead of one number.
--
--  Existing rows default to 'Workshop', which is the safe reading — they are
--  treated as needing attention rather than being written off.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF COL_LENGTH('core.ScoItem', 'ItemKind') IS NULL
BEGIN
    ALTER TABLE core.ScoItem ADD ItemKind NVARCHAR(20) NOT NULL
        CONSTRAINT DF_ScoItem_ItemKind DEFAULT 'Workshop';
    PRINT 'core.ScoItem.ItemKind added';
END
ELSE
    PRINT 'core.ScoItem.ItemKind already exists';
GO

-- Backfill by the same rules the application uses (classifyItem), so a
-- historical import reads the same as a new one.
UPDATE core.ScoItem
   SET ItemKind = CASE
        WHEN ItemName LIKE '%Group Registration%' THEN 'SiteBooking'
        WHEN ItemName LIKE '%Discount%'          THEN 'Discount'
        ELSE 'Workshop'
   END
 WHERE ItemKind = 'Workshop'
   AND (ItemName LIKE '%Group Registration%' OR ItemName LIKE '%Discount%');

PRINT 'core.ScoItem.ItemKind backfilled: ' + CAST(@@ROWCOUNT AS NVARCHAR(10)) + ' rows';
GO

SELECT ItemKind, COUNT(*) AS Items
  FROM core.ScoItem
 GROUP BY ItemKind;
GO
