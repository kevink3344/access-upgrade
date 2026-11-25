-- =====================================================================
--  026 - Widen core.Payment.ExternalPaymentId
--
--  Migration 016 sized this column at NVARCHAR(100) on the assumption that
--  it would hold the vendor's own payment id. The vendor export has no such
--  id — ExternalId1 is blank on every row — so the matcher builds one from
--  the row's content instead (rowIdentity in services/schoolcash.ts) and
--  stores it here.
--
--  That identity is deliberately long: email, item, date, both amounts and
--  the payment line, plus an occurrence suffix for exact repeats. Real rows
--  run to 124 characters, and 38 of the 106 rows in the November 2025 export
--  exceed 100. Applying an import therefore failed with
--  "String or binary data would be truncated" and no payment was written.
--
--  400 matches core.ScoRow.RowIdentity, which is the value actually inserted,
--  so the two can never disagree about what fits.
--
--  Guarded and safe to re-run. Apply to BOTH databases.
-- =====================================================================

SET NOCOUNT ON;
GO

IF COL_LENGTH('core.Payment', 'ExternalPaymentId') IS NULL
BEGIN
    PRINT 'core.Payment.ExternalPaymentId does not exist - run 016 first';
END
ELSE
BEGIN
    -- Widening only: no data is rewritten, and the unique index on
    -- (ExternalReceipt, ExternalPaymentId) is rebuilt automatically.
    ALTER TABLE core.Payment ALTER COLUMN ExternalPaymentId NVARCHAR(400) NULL;
    PRINT 'core.Payment.ExternalPaymentId widened to NVARCHAR(400)';
END
GO
