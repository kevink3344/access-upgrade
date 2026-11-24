import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getPool, query, sql, txQuery, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  bestWorkshop,
  identitiesFor,
  matchRow,
  normaliseItemName,
  parseMoney,
  parseScoCsv,
  NAME_MATCH_THRESHOLD,
  type MatchCandidate,
  type ScoCsvRow,
  type WorkshopOption,
} from '../services/schoolcash.js';

/**
 * School Cash Online matching.
 *
 * Admins upload the district's daily Item Order Report, review what matched
 * to registrations, resolve the remainder by hand, then apply. Applying is
 * the only step that writes money.
 *
 * Three rules shape this module:
 *
 *  - Uploads are staged, never applied directly. A parsing mistake costs a
 *    re-upload rather than a corrupted payment table.
 *  - Applying is idempotent. `core.Payment` carries a unique index on the
 *    vendor's receipt/payment pair, and an applied row records the payment it
 *    produced, so re-uploading the same file cannot pay twice.
 *  - `PaidAmount` gets the item price, not the gross charge. The online fee is
 *    stored separately on the payment so revenue reports do not overstate
 *    income. See docs/plans/school-cash-matching.md Â§11.2.
 */

export const schoolCashRouter = Router();

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

/**
 * The Item Order Report is a few hundred KB. The cap is generous enough for a
 * month of accumulated orders and small enough that a mistaken upload of
 * something else fails fast.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** School Cash's own payment method, so these payments are distinguishable. */
const SCHOOL_CASH_METHOD_NAME = 'School Cash Online';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const historyQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().optional(),
  importId: z.coerce.number().int().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const rowPatch = z
  .object({
    /** Set to a registration id to match by hand. */
    registrationId: z.number().int().positive().nullable().optional(),
    /** Set true to dismiss the row; it will never be applied. */
    ignore: z.boolean().optional(),
    ignoreReason: z.string().trim().max(255).nullable().optional(),
  })
  .refine(
    (v) => v.registrationId !== undefined || v.ignore !== undefined,
    'Provide registrationId or ignore.',
  );

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Reads the request body as text.
 *
 * The client sends the file as `text/plain` rather than multipart: the report
 * is a single text file, and avoiding a multipart dependency keeps the
 * upload path to the same `express.json`-style body handling as the rest of
 * the API. The route is mounted with `express.text` for this reason.
 */
function readBody(req: { body: unknown }): string | null {
  if (typeof req.body === 'string' && req.body.trim() !== '') return req.body;
  if (Buffer.isBuffer(req.body) && req.body.length > 0) return req.body.toString('utf8');
  return null;
}

/**
 * Matches every staged row whose item has a resolved workshop, writing the
 * result back to `core.ScoRow`. Rows whose item is unresolved are left alone.
 *
 * Runs inside the caller's transaction so an import is never half-matched.
 * Returns the counts the upload response reports.
 */
async function matchImportRows(
  tx: sql.Transaction,
  importId: number,
): Promise<{ matched: number; review: number; ignored: number }> {
  const rows = await txQuery<{
    ScoRowID: number;
    PurchaserEmail: string | null;
    ItemBalance: string | null;
    PurchasedDate: string | null;
    RowIdentity: string | null;
    WorkshopID: number | null;
  }>(
    tx,
    `SELECT s.ScoRowID, s.PurchaserEmail, s.ItemBalance, s.PurchasedDate,
            s.RowIdentity, i.WorkshopID
       FROM core.ScoRow s
       JOIN core.ScoItem i ON i.ScoItemID = s.ScoItemID
      WHERE s.ScoImportID = @id AND s.AppliedPaymentID IS NULL`,
    { id: { type: sql.Int, value: importId } },
  );

  let matched = 0;
  let review = 0;
  let ignored = 0;

  for (const row of rows.recordset) {
    let outcome: { matchedRegistrationId: number | null; confidence: string; method: string; note: string | null };

    if (!row.WorkshopID) {
      outcome = {
        matchedRegistrationId: null,
        confidence: 'None',
        method: 'none',
        note: 'This item has no workshop resolved yet.',
      };
    } else {
      outcome = await evaluateRowInTx(tx, row);
    }

    if (outcome.confidence === 'High') matched += 1;
    else if (outcome.confidence === 'Duplicate') ignored += 1;
    else review += 1;

    await txQuery(
      tx,
      `UPDATE core.ScoRow
          SET MatchedRegistrationID = @regId, MatchConfidence = @confidence,
              MatchMethod = @method, MatchNote = @note
        WHERE ScoRowID = @rowId`,
      {
        rowId: { type: sql.BigInt, value: row.ScoRowID },
        regId: { type: sql.Int, value: outcome.matchedRegistrationId },
        confidence: { type: sql.NVarChar(10), value: outcome.confidence },
        method: { type: sql.NVarChar(20), value: outcome.method },
        note: { type: sql.NVarChar(255), value: outcome.note },
      },
    );
  }

  await txQuery(
    tx,
    `UPDATE core.ScoImport
        SET MatchedCount = @matched, ReviewCount = @review, IgnoredCount = @ignored
      WHERE ScoImportID = @id`,
    {
      id: { type: sql.Int, value: importId },
      matched: { type: sql.Int, value: matched },
      review: { type: sql.Int, value: review },
      ignored: { type: sql.Int, value: ignored },
    },
  );

  return { matched, review, ignored };
}

/**
 * Matches one row inside an open transaction.
 *
 * The same rules as `evaluateRow`, but reading through `tx` so it sees rows
 * inserted moments ago in the same transaction.
 */
async function evaluateRowInTx(
  tx: sql.Transaction,
  row: {
    ScoRowID: number;
    PurchaserEmail: string | null;
    ItemBalance: string | null;
    PurchasedDate: string | null;
    RowIdentity: string | null;
    WorkshopID: number | null;
  },
): Promise<{ matchedRegistrationId: number | null; confidence: string; method: string; note: string | null }> {
  const identity = row.RowIdentity;
  if (identity) {
    // Checked inside the transaction so a repeat within the same file is also
    // caught: the first occurrence is already staged by the time the second
    // is evaluated.
    const dup = await txQuery<{ n: number }>(
      tx,
      `SELECT
          (SELECT COUNT(*) FROM core.Payment WHERE ExternalPaymentId = @identity) +
          (SELECT COUNT(*) FROM core.ScoRow
            WHERE RowIdentity = @identity AND ScoRowID <> @rowId
              AND AppliedPaymentID IS NULL) AS n`,
      {
        identity: { type: sql.NVarChar(400), value: identity },
        rowId: { type: sql.BigInt, value: row.ScoRowID },
      },
    );
    if ((dup.recordset[0]?.n ?? 0) > 0) {
      return {
        matchedRegistrationId: null,
        confidence: 'Duplicate',
        method: 'duplicate',
        note: 'This purchase is already in another upload, or already paid.',
      };
    }
  }

  const email = row.PurchaserEmail;
  if (!email) {
    return {
      matchedRegistrationId: null,
      confidence: 'None',
      method: 'none',
      note: 'No purchaser email on this row.',
    };
  }

  const who = await txQuery<{ ParticipantID: number }>(
    tx,
    `SELECT TOP 1 ParticipantID FROM core.Participant
      WHERE LOWER(LTRIM(RTRIM(Email))) = @email ORDER BY ParticipantID`,
    { email: { type: sql.NVarChar(255), value: email.toLowerCase() } },
  );

  if (!who.recordset[0]) {
    return {
      matchedRegistrationId: null,
      confidence: 'Low',
      method: 'none',
      note: 'New purchaser - no participant uses this email. Applying will create one.',
    };
  }

  const candidates = await txQuery<{ RegistrationID: number; Owed: number | null; RegisteredOn: string | null }>(
    tx,
    `SELECT r.RegistrationID,
            CASE WHEN w.Cost1 IS NULL THEN NULL
                 ELSE w.Cost1 - ISNULL(r.PaidAmount, 0) END AS Owed,
            CONVERT(NVARCHAR(10), COALESCE(r.RegistrationDate, w.StartDate), 23) AS RegisteredOn
       FROM core.Registration r
       JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
      WHERE r.ParticipantID = @pid AND r.WorkshopID = @wid
        AND r.IsCancelled = 0 AND ISNULL(r.PaidAmount, 0) <= 0
      ORDER BY r.RegistrationID`,
    {
      pid: { type: sql.Int, value: who.recordset[0].ParticipantID },
      wid: { type: sql.Int, value: row.WorkshopID },
    },
  );

  const outcome = matchRow(
    {
      purchaserEmail: email,
      itemBalance: parseMoney(row.ItemBalance),
      alreadyApplied: false,
      purchasedOn: isoDate(row.PurchasedDate),
    },
    candidates.recordset.map((c) => ({
      registrationId: c.RegistrationID,
      owed: c.Owed,
      registeredOn: c.RegisteredOn,
    })),
  );

  return {
    matchedRegistrationId: outcome.registrationId,
    confidence: outcome.confidence,
    method: outcome.method,
    note: outcome.note,
  };
}

/**
 * Every workshop an admin can pick from, for the resolution screen. */
async function allWorkshops(): Promise<Omit<WorkshopOption, 'score'>[]> {
  const r = await query<{
    WorkshopID: number;
    WorkshopName: string | null;
    WorkshopCode: string | null;
    StartDate: string | null;
    Price: number | null;
  }>(
    `SELECT w.WorkshopID, n.WorkshopName, w.WorkshopCode,
            CONVERT(NVARCHAR(10), w.StartDate, 23) AS StartDate,
            w.Cost1 AS Price
       FROM core.Workshop w
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      WHERE n.WorkshopName IS NOT NULL
      ORDER BY w.StartDate DESC, w.WorkshopID DESC`,
  );
  return r.recordset.map((row) => ({
    workshopId: row.WorkshopID,
    workshopName: row.WorkshopName ?? '',
    workshopCode: row.WorkshopCode,
    startDate: row.StartDate,
    price: row.Price,
  }));
}

/**
 * Splits an upload's rows into one record per distinct item name.
 *
 * Called at upload time. The item name is normalised first so the vendor's
 * date suffix does not create a separate entry for every session.
 */
async function buildItems(tx: sql.Transaction, importId: number): Promise<void> {
  const rows = await txQuery<{ ScoRowID: number; ItemName: string | null; ItemBalance: string | null }>(
    tx,
    `SELECT ScoRowID, ItemName, ItemBalance FROM core.ScoRow WHERE ScoImportID = @id`,
    { id: { type: sql.Int, value: importId } },
  );

  const grouped = new Map<
    string,
    { rowIds: number[]; balance: string | null }
  >();
  for (const r of rows.recordset) {
    const name = normaliseItemName(r.ItemName);
    if (!name) continue;
    const cur = grouped.get(name);
    if (cur) cur.rowIds.push(r.ScoRowID);
    else grouped.set(name, { rowIds: [r.ScoRowID], balance: r.ItemBalance });
  }

  const workshops = await allWorkshops();

  for (const [name, info] of grouped) {
    const suggestion = bestWorkshop(name, workshops);
    // A suggestion at or above the auto-match threshold is accepted outright;
    // anything lower is offered for an admin to confirm.
    const autoResolve = suggestion !== null && suggestion.score >= NAME_MATCH_THRESHOLD;

    const created = await txQuery<{ ScoItemID: number }>(
      tx,
      `INSERT INTO core.ScoItem
              (ScoImportID, ItemName, TotalRows, ItemBalance,
               WorkshopID, ResolvedBy, SuggestedWorkshopID, SuggestionScore,
               ResolvedAt, ResolvedByUser)
       OUTPUT INSERTED.ScoItemID AS ScoItemID
       VALUES (@importId, @name, @total, @balance,
               @workshopId, @resolvedBy, @suggestedId, @score,
               @resolvedAt, NULL)`,
      {
        importId: { type: sql.Int, value: importId },
        name: { type: sql.NVarChar(255), value: name },
        total: { type: sql.Int, value: info.rowIds.length },
        balance: { type: sql.NVarChar(50), value: info.balance },
        workshopId: { type: sql.Int, value: autoResolve ? suggestion!.workshopId : null },
        resolvedBy: { type: sql.NVarChar(20), value: autoResolve ? 'Auto' : null },
        suggestedId: { type: sql.Int, value: suggestion?.workshopId ?? null },
        score: { type: sql.Decimal(5, 4), value: suggestion?.score ?? null },
        resolvedAt: { type: sql.DateTime2, value: autoResolve ? new Date() : null },
      },
    );

    // Point the rows at their item so payment matching can read the workshop.
    const itemId = created.recordset[0]!.ScoItemID;
    for (const rowId of info.rowIds) {
      await txQuery(tx, `UPDATE core.ScoRow SET ScoItemID = @itemId WHERE ScoRowID = @rowId`, {
        itemId: { type: sql.Int, value: itemId },
        rowId: { type: sql.BigInt, value: rowId },
      });
    }
  }
}

/**
 * Finds the participant behind a purchaser email.
 *
 * Emails are stored on `core.Participant` in mixed case and occasionally with
 * surrounding whitespace, so the comparison is case-insensitive. A duplicate
 * participant record is possible in the legacy data; taking the lowest id is
 * arbitrary but stable, and the review screen shows the name so an admin can
 * catch a wrong pick before applying.
 */
async function participantForEmail(email: string): Promise<number | null> {
  const r = await query<{ ParticipantID: number }>(
    `SELECT TOP 1 ParticipantID
       FROM core.Participant
      WHERE LOWER(LTRIM(RTRIM(Email))) = @email
      ORDER BY ParticipantID`,
    { email: { type: sql.NVarChar(255), value: email.toLowerCase() } },
  );
  return r.recordset[0]?.ParticipantID ?? null;
}

/**
 * Every unpaid, uncancelled registration for a participant, with what is
 * still owed on each.
 *
 * "Owed" is the workshop price less whatever has already been paid. The price
 * is `core.Workshop.Cost1` - the same column the public registration form
 * quotes as the cost. There is no `Price` column on Workshop.
 *
 * Where the price is unknown the registration still counts as a candidate -
 * an admin can match it by hand - but it cannot win the amount rule.
 */
/**
 * Every unpaid, uncancelled registration for a participant **for one
 * workshop**, with what is still owed on each.
 *
 * Scoped to the workshop on purpose. An earlier version looked at every
 * unpaid registration the participant had, which put payments against
 * workshops from 2011 because nothing tied them to the right one.
 *
 * The price is `core.Workshop.Cost1` - the same column the public
 * registration form quotes as the cost. There is no `Price` column.
 */
async function unpaidCandidates(
  participantId: number,
  workshopId: number,
): Promise<MatchCandidate[]> {
  const r = await query<{
    RegistrationID: number;
    Owed: number | null;
    RegisteredOn: string | null;
  }>(
    `SELECT r.RegistrationID,
            CASE WHEN w.Cost1 IS NULL THEN NULL
                 ELSE w.Cost1 - ISNULL(r.PaidAmount, 0)
            END AS Owed,
            CONVERT(NVARCHAR(10), COALESCE(r.RegistrationDate, w.StartDate), 23) AS RegisteredOn
       FROM core.Registration r
       JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
      WHERE r.ParticipantID = @pid
        AND r.WorkshopID = @wid
        AND r.IsCancelled = 0
        AND ISNULL(r.PaidAmount, 0) <= 0
      ORDER BY r.RegistrationID`,
    {
      pid: { type: sql.Int, value: participantId },
      wid: { type: sql.Int, value: workshopId },
    },
  );
  return r.recordset.map((row) => ({
    registrationId: row.RegistrationID,
    owed: row.Owed,
    registeredOn: row.RegisteredOn,
  }));
}

/**
 * Creates the participant and registration a School Cash row needs when the
 * purchaser has never registered before.
 *
 * Follows the same shapes the public registration form uses: ids allocated
 * from the current maximum (the legacy tables are not IDENTITY), and the
 * participant carrying the purchaser's email so the row can be matched by it.
 *
 * The workshop is the one the upload resolved for this item - already
 * confirmed by an admin - so there is no guessing here. That is the whole
 * point of resolving workshops first.
 */
async function createRegistrationFor(
  row: {
    PurchaserEmail: string | null;
    PurchaserName: string | null;
    PurchasedDate: string | null;
    WorkshopID: number | null;
  },
  tx: sql.Transaction,
): Promise<{ ok: true; registrationId: number } | { ok: false; reason: string }> {
  const email = row.PurchaserEmail;
  if (!email) return { ok: false, reason: 'No purchaser email, so no participant can be created.' };

  const workshopId = row.WorkshopID;
  if (!workshopId) {
    return { ok: false, reason: 'This item has no workshop resolved, so no registration can be created.' };
  }

  // Reuse a participant created by an earlier row in the same file.
  const existing = await txQuery<{ ParticipantID: number }>(
    tx,
    `SELECT TOP 1 ParticipantID FROM core.Participant
      WHERE LOWER(LTRIM(RTRIM(Email))) = @email ORDER BY ParticipantID`,
    { email: { type: sql.NVarChar(100), value: email.toLowerCase() } },
  );

  let participantId = existing.recordset[0]?.ParticipantID ?? null;

  if (participantId === null) {
    const name = splitName(row.PurchaserName);
    const seq = await txQuery<{ NextId: number }>(
      tx,
      'SELECT ISNULL(MAX(ParticipantID), 0) + 1 AS NextId FROM core.Participant WITH (TABLOCKX)',
    );
    const created = await txQuery<{ ParticipantID: number }>(
      tx,
      `INSERT INTO core.Participant
              (ParticipantID, FirstName, LastName, Email, DateOfEntry)
       OUTPUT INSERTED.ParticipantID AS ParticipantID
       VALUES (@id, @fn, @ln, @email, SYSUTCDATETIME())`,
      {
        id: { type: sql.Int, value: seq.recordset[0]!.NextId },
        fn: { type: sql.NVarChar(30), value: name.first },
        ln: { type: sql.NVarChar(30), value: name.last },
        email: { type: sql.NVarChar(100), value: email },
      },
    );
    participantId = created.recordset[0]!.ParticipantID;
  }

  const seq = await txQuery<{ NextId: number }>(
    tx,
    'SELECT ISNULL(MAX(RegistrationID), 0) + 1 AS NextId FROM core.Registration WITH (TABLOCKX)',
  );

  const created = await txQuery<{ RegistrationID: number }>(
    tx,
    `INSERT INTO core.Registration
            (RegistrationID, ParticipantID, WorkshopID, RegistrationDate, IsCancelled,
             Attended, EmailConfirmation, Source)
     OUTPUT INSERTED.RegistrationID AS RegistrationID
     VALUES (@id, @pid, @wid, @date, 0, 0, 0, 'SchoolCash')`,
    {
      id: { type: sql.Int, value: seq.recordset[0]!.NextId },
      pid: { type: sql.Int, value: participantId },
      wid: { type: sql.Int, value: workshopId },
      date: { type: sql.Date, value: isoDate(row.PurchasedDate) },
    },
  );

  return { ok: true, registrationId: created.recordset[0]!.RegistrationID };
}

/** "Barber, Bria" -> { last: 'Barber', first: 'Bria' }; both capped to the column width. */
function splitName(name: string | null): { first: string | null; last: string | null } {
  if (!name) return { first: null, last: null };
  const trimmed = name.trim();
  const comma = trimmed.indexOf(',');
  const parts =
    comma >= 0
      ? { last: trimmed.slice(0, comma).trim(), first: trimmed.slice(comma + 1).trim() }
      : (() => {
          const bits = trimmed.split(/\s+/);
          return { first: bits[0] ?? '', last: bits.slice(1).join(' ') };
        })();
  const cap = (s: string) => (s === '' ? null : s.slice(0, 30));
  return { first: cap(parts.first), last: cap(parts.last) };
}

/** The School Cash payment method, created on first use so a fresh database works. */
async function schoolCashMethodId(): Promise<number | null> {
  const found = await query<{ PaymentMethodID: number }>(
    `SELECT TOP 1 PaymentMethodID FROM ref.PaymentMethod
      WHERE PaymentMethod = @name ORDER BY PaymentMethodID`,
    { name: { type: sql.NVarChar(100), value: SCHOOL_CASH_METHOD_NAME } },
  );
  if (found.recordset[0]) return found.recordset[0].PaymentMethodID;

  const next = await query<{ NextId: number }>(
    'SELECT ISNULL(MAX(PaymentMethodID), 0) + 1 AS NextId FROM ref.PaymentMethod',
  );
  const id = next.recordset[0]!.NextId;
  await query(
    `INSERT INTO ref.PaymentMethod (PaymentMethodID, PaymentMethod)
     VALUES (@id, @name)`,
    {
      id: { type: sql.Int, value: id },
      name: { type: sql.NVarChar(100), value: SCHOOL_CASH_METHOD_NAME },
    },
  );
  return id;
}


/**
 * "09/15/2026" -> "2026-09-15". Returns null when the text is not a date.
 *
 * The vendor export uses US month-first dates, which `new Date()` parses
 * inconsistently across engines, so the parts are read explicitly.
 */
function isoDate(text: string | null): string | null {
  if (!text) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text.trim());
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
  }
  // Some exports use ISO already.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  return iso ? iso[0] : null;
}

/* ------------------------------------------------------------------ */
/*  Upload                                                             */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/school-cash/imports:
 *   post:
 *     tags: [School Cash]
 *     summary: Upload an Item Order Report and stage the matches
 *     description: >
 *       Send the CSV as the raw request body with Content-Type text/plain.
 *       The file name goes in the X-File-Name header. Nothing is applied -
 *       the result is a staged import for review.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Staged }
 *       409: { description: This file has already been uploaded }
 *       422: { description: Not an Item Order Report }
 */
schoolCashRouter.post(
  '/imports',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const text = readBody(req);
      if (text === null) {
        res.status(400).json({ error: 'bad_request', message: 'The request body is empty.' });
        return;
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_UPLOAD_BYTES) {
        res.status(413).json({
          error: 'too_large',
          message: 'That file is larger than 8 MB. Upload a single day of orders.',
        });
        return;
      }

      const parsed = parseScoCsv(text);
      if (!parsed.ok) {
        res.status(422).json({ error: 'not_item_order_report', message: parsed.error, missing: parsed.missing });
        return;
      }
      if (parsed.rows.length === 0) {
        res.status(422).json({ error: 'empty_report', message: 'The file has a header but no orders.' });
        return;
      }

      const fileName = String(req.header('x-file-name') ?? 'ItemOrderReport.csv').slice(0, 260);
      const hash = crypto.createHash('sha256').update(text, 'utf8').digest();

      const existing = await query<{ ScoImportID: number; FileName: string; UploadedAt: string; UploadedBy: string }>(
        `SELECT ScoImportID, FileName, UploadedBy,
                CONVERT(NVARCHAR(30), UploadedAt, 126) AS UploadedAt
           FROM core.ScoImport WHERE FileHash = @hash`,
        { hash: { type: sql.VarBinary(32), value: hash } },
      );
      if (existing.recordset[0]) {
        // Byte-identical file. Say who has it and when, so a second staff
        // member knows it is already in hand rather than thinking it failed.
        const prior = existing.recordset[0];
        res.status(409).json({
          error: 'already_imported',
          message: `This exact file was already uploaded by ${prior.UploadedBy} on ${prior.UploadedAt}. Nothing has been duplicated.`,
          importId: prior.ScoImportID,
        });
        return;
      }

      // Evaluate first, then write. The matcher issues several queries per
      // row, and holding a transaction open across ~100 round trips would
      // risk a timeout; nothing is visible until the insert below commits.
      //
      // Identities are computed for the whole file up front, because exact
      // repeats are numbered by occurrence and that needs the full row list.
      const identities = identitiesFor(parsed.rows);

      const pool = await getPool();
      const tx = pool.transaction();
      await tx.begin();

      try {
        const header = await txQuery<{ id: number }>(
          tx,
          `INSERT INTO core.ScoImport
                  (FileName, FileHash, TotalRows, MatchedCount, ReviewCount, IgnoredCount,
                   Status, UploadedBy)
           OUTPUT INSERTED.ScoImportID AS id
           VALUES (@fileName, @hash, @totalRows, 0, 0, 0, 'Staged', @by)`,
          {
            fileName: { type: sql.NVarChar(260), value: fileName },
            hash: { type: sql.VarBinary(32), value: hash },
            totalRows: { type: sql.Int, value: parsed.rows.length },
            by: { type: sql.NVarChar(200), value: req.user!.email },
          },
        );
        const importId = header.recordset[0]!.id;

        // Rows first, then items, then matching - in that order. Matching
        // needs the resolved workshop, so it cannot run until the items exist.
        for (let i = 0; i < parsed.rows.length; i += 1) {
          const row = parsed.rows[i]!;
          await txQuery(
            tx,
            `INSERT INTO core.ScoRow
                    (ScoImportID, RowNumber, PurchaserEmail, PurchaserName, RecipientName,
                     ItemId, ItemName, PaidAmount, ItemBalance, TransactionFee,
                     PurchasedDate, Owing, Refunded, RawJson, RowIdentity,
                     MatchConfidence, MatchMethod, MatchNote)
             VALUES (@importId, @rowNumber, @email, @purchaser, @recipient,
                     @itemId, @itemName, @paid, @balance, @fee,
                     @purchased, @owing, @refunded, @raw, @identity,
                     'None', 'none', 'Workshops not resolved yet.')`,
            {
              importId: { type: sql.Int, value: importId },
              rowNumber: { type: sql.Int, value: row.rowNumber },
              email: { type: sql.NVarChar(255), value: row.purchaserEmail },
              purchaser: { type: sql.NVarChar(255), value: row.purchaserName },
              recipient: { type: sql.NVarChar(255), value: row.recipientName },
              itemId: { type: sql.NVarChar(50), value: row.itemId },
              itemName: { type: sql.NVarChar(255), value: row.itemName },
              paid: { type: sql.NVarChar(50), value: row.paidAmount },
              balance: { type: sql.NVarChar(50), value: row.itemBalance },
              fee: { type: sql.NVarChar(50), value: row.transactionFee },
              purchased: { type: sql.NVarChar(50), value: row.purchasedDate },
              owing: { type: sql.NVarChar(50), value: row.owing },
              refunded: { type: sql.NVarChar(50), value: row.refunded },
              raw: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(row.raw) },
              identity: { type: sql.NVarChar(400), value: identities[i]! },
            },
          );
        }

        // Group the rows into distinct items and suggest a workshop for each.
        // Payments are not matched yet: the workshop has to be settled first,
        // or a payment lands on whichever registration happened to be unpaid.
        await buildItems(tx, importId);

        // Match payments only where the workshop is already known. Items an
        // admin still has to resolve stay at 'None' until they do.
        const matched = await matchImportRows(tx, importId);

        const itemStats = await txQuery<{ total: number; resolved: number }>(
          tx,
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN WorkshopID IS NOT NULL THEN 1 ELSE 0 END) AS resolved
             FROM core.ScoItem WHERE ScoImportID = @id`,
          { id: { type: sql.Int, value: importId } },
        );

        await tx.commit();
        res.status(201).json({
          importId,
          fileName,
          TotalRows: parsed.rows.length,
          items: itemStats.recordset[0]!.total,
          itemsResolved: itemStats.recordset[0]!.resolved ?? 0,
          matched: matched.matched,
          review: matched.review,
          ignored: matched.ignored,
        });
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------ */
/*  Imports list and detail                                            */
/* ------------------------------------------------------------------ */

const IMPORT_COLUMNS = `
  ScoImportID, FileName, TotalRows, MatchedCount, ReviewCount, IgnoredCount, AppliedCount,
  Status, UploadedBy, CONVERT(NVARCHAR(30), UploadedAt, 126) AS UploadedAt,
  AppliedBy, CONVERT(NVARCHAR(30), AppliedAt, 126) AS AppliedAt`;

/**
 * @openapi
 * /api/school-cash/imports:
 *   get:
 *     tags: [School Cash]
 *     summary: List uploaded Item Order Reports
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Paged list }
 */
schoolCashRouter.get('/imports', requireAuth, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', details: parsed.error.issues });
      return;
    }
    const { page, pageSize } = parsed.data;

    const total = await query<{ n: number }>('SELECT COUNT(*) AS n FROM core.ScoImport');
    const rows = await query(
      `SELECT ${IMPORT_COLUMNS}
         FROM core.ScoImport
        ORDER BY UploadedAt DESC, ScoImportID DESC
        OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY`,
      {
        offset: { type: sql.Int, value: (page - 1) * pageSize },
        take: { type: sql.Int, value: pageSize },
      },
    );

    res.json({ rows: rows.recordset, total: total.recordset[0]!.n, page, pageSize });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/school-cash/imports/{id}:
 *   get:
 *     tags: [School Cash]
 *     summary: One import with every staged row
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Import detail }
 *       404: { description: Not found }
 */
schoolCashRouter.get(
  '/imports/:id',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid import id.' });
        return;
      }

      const header = await query(
        `SELECT ${IMPORT_COLUMNS} FROM core.ScoImport WHERE ScoImportID = @id`,
        { id: { type: sql.Int, value: id } },
      );
      if (!header.recordset[0]) {
        res.status(404).json({ error: 'not_found', message: 'No such import.' });
        return;
      }

      const rows = await query<Record<string, unknown>>(
        `SELECT s.ScoRowID, s.ScoImportID, s.RowNumber, s.PurchaserEmail, s.PurchaserName,
                s.ItemId, s.ItemName, s.PaidAmount, s.ItemBalance, s.TransactionFee,
                s.PurchasedDate, s.Owing, s.Refunded,
                s.MatchedRegistrationID, s.MatchConfidence, s.MatchMethod, s.MatchNote,
                s.IgnoreReason, s.AppliedPaymentID,
                r.ParticipantID,
                CONCAT(pt.FirstName, ' ', pt.LastName) AS ParticipantName,
                r.WorkshopID,
                n.WorkshopName,
                w.WorkshopCode,
                CONVERT(NVARCHAR(10), w.StartDate, 23) AS WorkshopDate,
                CASE WHEN w.Cost1 IS NULL THEN NULL
                     ELSE w.Cost1 - ISNULL(r.PaidAmount, 0) END AS RegistrationOwed
           FROM core.ScoRow s
           LEFT JOIN core.Registration r ON r.RegistrationID = s.MatchedRegistrationID
           LEFT JOIN core.Participant  pt ON pt.ParticipantID = r.ParticipantID
           LEFT JOIN core.Workshop    w  ON w.WorkshopID = r.WorkshopID
           LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
          WHERE s.ScoImportID = @id
          ORDER BY s.RowNumber`,
        { id: { type: sql.Int, value: id } },
      );

      const mapped = rows.recordset.map((r) => ({
        ...r,
        ItemBalance: parseMoney(r.ItemBalance as string | null),
        PaidAmount: parseMoney(r.PaidAmount as string | null),
        TransactionFee: parseMoney(r.TransactionFee as string | null),
        Owing: parseMoney(r.Owing as string | null),
        Refunded: parseMoney(r.Refunded as string | null),
      }));

      const counts: Record<string, number> = { High: 0, Low: 0, None: 0, Duplicate: 0, Ignored: 0 };
      for (const r of rows.recordset) {
        const c = r.MatchConfidence as string | null;
        if (c && c in counts) counts[c] = (counts[c] ?? 0) + 1;
      }

      res.json({ ...header.recordset[0], rows: mapped, counts });
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------ */
/*  Workshop resolution                                                */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/school-cash/imports/{id}/items:
 *   get:
 *     tags: [School Cash]
 *     summary: The distinct items in an upload, with their workshop
 *     description: >
 *       Step one of an upload. Each distinct item name is listed once with the
 *       workshop it resolves to, so an admin can confirm, choose, or create.
 *       Payment matching does not run until every item is resolved.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Items and whether the upload is ready }
 */
schoolCashRouter.get(
  '/imports/:id/items',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const importId = Number(req.params.id);
      if (!Number.isInteger(importId) || importId <= 0) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid import id.' });
        return;
      }

      const items = await query<Record<string, unknown>>(
        `SELECT i.ScoItemID, i.ItemName, i.TotalRows, i.ItemBalance,
                i.WorkshopID, i.ResolvedBy, i.SuggestionScore,
                i.SuggestedWorkshopID,
                w.WorkshopCode, CONVERT(NVARCHAR(10), w.StartDate, 23) AS WorkshopDate,
                n.WorkshopName,
                sn.WorkshopName AS SuggestedWorkshopName,
                sw.WorkshopCode AS SuggestedWorkshopCode
           FROM core.ScoItem i
           LEFT JOIN core.Workshop w ON w.WorkshopID = i.WorkshopID
           LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
           LEFT JOIN core.Workshop sw ON sw.WorkshopID = i.SuggestedWorkshopID
           LEFT JOIN core.WorkshopName sn ON sn.WorkshopNameID = sw.WorkshopNameID
          WHERE i.ScoImportID = @id
          ORDER BY i.TotalRows DESC, i.ItemName`,
        { id: { type: sql.Int, value: importId } },
      );

      const unresolved = items.recordset.filter((i) => i.WorkshopID === null).length;

      res.json({
        rows: items.recordset.map((i) => ({
          ...i,
          ItemBalance: parseMoney(i.ItemBalance as string | null),
          SuggestionScore: i.SuggestionScore === null ? null : Number(i.SuggestionScore),
        })),
        total: items.recordset.length,
        unresolved,
        ready: unresolved === 0 && items.recordset.length > 0,
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Every workshop, for the picker. */
schoolCashRouter.get('/workshops', requireAuth, requireRole(...ADMIN_ROLES), async (_req, res, next) => {
  try {
    const rows = await allWorkshops();
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

const itemResolve = z.object({
  /** An existing workshop to use. */
  workshopId: z.number().int().positive().optional(),
  /** Or create one from these details. */
  create: z
    .object({
      workshopNameId: z.number().int().positive().optional(),
      newWorkshopName: z.string().trim().min(1).max(255).optional(),
      workshopCode: z.string().trim().max(10).nullable().optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      price: z.number().nullable().optional(),
    })
    .optional(),
});

/**
 * @openapi
 * /api/school-cash/items/{itemId}:
 *   patch:
 *     tags: [School Cash]
 *     summary: Resolve one item to a workshop, or create the workshop
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: itemId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Resolved }
 *       409: { description: The upload has already been applied }
 */
schoolCashRouter.patch(
  '/items/:itemId',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const itemId = Number(req.params.itemId);
      const parsed = itemResolve.safeParse(req.body);
      if (!Number.isInteger(itemId) || itemId <= 0) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid item id.' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({ error: 'validation_failed', details: parsed.error.issues });
        return;
      }
      if (parsed.data.workshopId === undefined && parsed.data.create === undefined) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Provide workshopId to use an existing workshop, or create to make one.',
        });
        return;
      }

      const current = await query<{ ScoImportID: number; AppliedCount: number }>(
        `SELECT i.ScoImportID, im.AppliedCount
           FROM core.ScoItem i
           JOIN core.ScoImport im ON im.ScoImportID = i.ScoImportID
          WHERE i.ScoItemID = @itemId`,
        { itemId: { type: sql.Int, value: itemId } },
      );
      const row = current.recordset[0];
      if (!row) {
        res.status(404).json({ error: 'not_found', message: 'No such item.' });
        return;
      }
      if (row.AppliedCount > 0) {
        res.status(409).json({
          error: 'already_applied',
          message: 'Payments have already been applied from this upload, so its workshops cannot change.',
        });
        return;
      }

      let workshopId: number;
      let resolvedBy: 'Manual' | 'Created';

      if (parsed.data.workshopId !== undefined) {
        const exists = await query<{ WorkshopID: number }>(
          'SELECT WorkshopID FROM core.Workshop WHERE WorkshopID = @id',
          { id: { type: sql.Int, value: parsed.data.workshopId } },
        );
        if (!exists.recordset[0]) {
          res.status(422).json({ error: 'not_found', message: 'No such workshop.' });
          return;
        }
        workshopId = parsed.data.workshopId;
        resolvedBy = 'Manual';
      } else {
        const c = parsed.data.create!;
        let nameId = c.workshopNameId ?? null;

        if (nameId === null) {
          if (!c.newWorkshopName) {
            res.status(422).json({
              error: 'validation_failed',
              message: 'Provide workshopNameId or newWorkshopName to create a workshop.',
            });
            return;
          }
          // Reuse an existing name rather than creating a near-duplicate.
          const existing = await query<{ WorkshopNameID: number }>(
            `SELECT TOP 1 WorkshopNameID FROM core.WorkshopName
              WHERE LTRIM(RTRIM(WorkshopName)) = @name`,
            { name: { type: sql.NVarChar(255), value: c.newWorkshopName } },
          );
          if (existing.recordset[0]) {
            nameId = existing.recordset[0].WorkshopNameID;
          } else {
            const seq = await query<{ NextId: number }>(
              'SELECT ISNULL(MAX(WorkshopNameID), 0) + 1 AS NextId FROM core.WorkshopName',
            );
            const created = await query<{ WorkshopNameID: number }>(
              `INSERT INTO core.WorkshopName (WorkshopNameID, WorkshopName)
               OUTPUT INSERTED.WorkshopNameID AS WorkshopNameID
               VALUES (@id, @name)`,
              {
                id: { type: sql.Int, value: seq.recordset[0]!.NextId },
                name: { type: sql.NVarChar(255), value: c.newWorkshopName },
              },
            );
            nameId = created.recordset[0]!.WorkshopNameID;
          }
        }

        const seq = await query<{ NextId: number }>(
          'SELECT ISNULL(MAX(WorkshopID), 0) + 1 AS NextId FROM core.Workshop',
        );
        const created = await query<{ WorkshopID: number }>(
          `INSERT INTO core.Workshop
                  (WorkshopID, WorkshopNameID, WorkshopCode, StartDate, Cost1,
                   IsBrochure, IsFolder, IsLabel, IsClosed, IsCancelled, IsContracted,
                   IsWcpc, IsStaffDev, IsFullyCodified)
           OUTPUT INSERTED.WorkshopID AS WorkshopID
           VALUES (@id, @nameId, @code, @start, @price,
                   0, 0, 0, 0, 0, 0, 0, 0, 0)`,
          {
            id: { type: sql.Int, value: seq.recordset[0]!.NextId },
            nameId: { type: sql.Int, value: nameId },
            code: { type: sql.NVarChar(10), value: c.workshopCode ?? null },
            start: { type: sql.Date, value: c.startDate ?? null },
            price: { type: sql.Decimal(19, 4), value: c.price ?? null },
          },
        );
        workshopId = created.recordset[0]!.WorkshopID;
        resolvedBy = 'Created';
      }

      await query(
        `UPDATE core.ScoItem
            SET WorkshopID = @wid, ResolvedBy = @by,
                ResolvedAt = SYSUTCDATETIME(), ResolvedByUser = @user
          WHERE ScoItemID = @itemId`,
        {
          itemId: { type: sql.Int, value: itemId },
          wid: { type: sql.Int, value: workshopId },
          by: { type: sql.NVarChar(20), value: resolvedBy },
          user: { type: sql.NVarChar(200), value: req.user!.email },
        },
      );

      res.json({ ScoItemID: itemId, WorkshopID: workshopId, ResolvedBy: resolvedBy });
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------ */
/*  Manual matching                                                    */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/school-cash/rows/{rowId}:
 *   patch:
 *     tags: [School Cash]
 *     summary: Match a staged row by hand, or dismiss it
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: rowId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Updated row }
 *       409: { description: The import has already been applied }
 *       422: { description: That registration is not unpaid }
 */
schoolCashRouter.patch(
  '/rows/:rowId',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const rowId = Number(req.params.rowId);
      const parsed = rowPatch.safeParse(req.body);
      if (!Number.isInteger(rowId) || rowId <= 0) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid row id.' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({ error: 'validation_failed', details: parsed.error.issues });
        return;
      }

      const current = await query<{
        ScoImportID: number;
        Status: string;
        AppliedPaymentID: number | null;
      }>(
        `SELECT s.ScoImportID, i.Status, s.AppliedPaymentID
           FROM core.ScoRow s
           JOIN core.ScoImport i ON i.ScoImportID = s.ScoImportID
          WHERE s.ScoRowID = @rowId`,
        { rowId: { type: sql.Int, value: rowId } },
      );
      const row = current.recordset[0];
      if (!row) {
        res.status(404).json({ error: 'not_found', message: 'No such row.' });
        return;
      }
      if (row.Status !== 'Staged') {
        res.status(409).json({
          error: 'import_not_staged',
          message: `This import is ${row.Status.toLowerCase()} and can no longer be edited.`,
        });
        return;
      }
      if (row.AppliedPaymentID !== null) {
        res.status(409).json({ error: 'row_applied', message: 'This row has already produced a payment.' });
        return;
      }

      if (parsed.data.ignore === true) {
        await query(
          `UPDATE core.ScoRow
              SET MatchedRegistrationID = NULL,
                  MatchConfidence = 'Ignored',
                  MatchMethod = 'none',
                  MatchNote = NULL,
                  IgnoreReason = @reason
            WHERE ScoRowID = @rowId`,
          {
            rowId: { type: sql.Int, value: rowId },
            reason: { type: sql.NVarChar(255), value: parsed.data.ignoreReason ?? 'Dismissed by an admin.' },
          },
        );
      } else if (parsed.data.registrationId === undefined || parsed.data.registrationId === null) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Provide registrationId to match, or ignore: true to dismiss.',
        });
        return;
      } else {
        const registrationId = parsed.data.registrationId;

        // Only an unpaid, uncancelled registration can receive a payment.
        // Checking here rather than at apply time means the admin sees the
        // problem while they are still looking at the row.
        const target = await query<{ RegistrationID: number; PaidAmount: number | null; IsCancelled: boolean }>(
          `SELECT RegistrationID, PaidAmount, IsCancelled
             FROM core.Registration WHERE RegistrationID = @id`,
          { id: { type: sql.Int, value: registrationId } },
        );
        const reg = target.recordset[0];
        if (!reg) {
          res.status(422).json({ error: 'not_found', message: 'No such registration.' });
          return;
        }
        if (reg.IsCancelled) {
          res.status(422).json({ error: 'cancelled', message: 'That registration is cancelled.' });
          return;
        }
        if ((reg.PaidAmount ?? 0) > 0) {
          res.status(422).json({
            error: 'already_paid',
            message: 'That registration has already been paid. Pick a different one.',
          });
          return;
        }

        await query(
          `UPDATE core.ScoRow
              SET MatchedRegistrationID = @regId,
                  MatchConfidence = 'High',
                  MatchMethod = 'manual',
                  MatchNote = @note,
                  IgnoreReason = NULL
            WHERE ScoRowID = @rowId`,
          {
            rowId: { type: sql.Int, value: rowId },
            regId: { type: sql.Int, value: registrationId },
            note: { type: sql.NVarChar(255), value: `Matched by ${req.user!.email}.` },
          },
        );
      }

      const updated = await query(
        `SELECT ScoRowID, ScoImportID, RowNumber, MatchedRegistrationID, MatchConfidence,
                MatchMethod, MatchNote, IgnoreReason
           FROM core.ScoRow WHERE ScoRowID = @rowId`,
        { rowId: { type: sql.Int, value: rowId } },
      );
      res.json(updated.recordset[0]);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/school-cash/imports/{id}/candidates:
 *   get:
 *     tags: [School Cash]
 *     summary: Unpaid registrations an admin can match a row to
 *     description: >
 *       Defaults to the purchaser's own registrations. Pass `q` to search any
 *       participant by name or email, for the case where the purchaser is a
 *       parent paying on someone else's behalf.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: query, name: rowId, schema: { type: integer } }
 *       - { in: query, name: q, schema: { type: string } }
 *     responses:
 *       200: { description: Candidate registrations }
 */
schoolCashRouter.get(
  '/imports/:id/candidates',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const importId = Number(req.params.id);
      const rowId = req.query.rowId ? Number(req.query.rowId) : null;
      const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';

      if (!Number.isInteger(importId) || importId <= 0) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid import id.' });
        return;
      }

      let email: string | null = null;
      if (rowId !== null) {
        const r = await query<{ PurchaserEmail: string | null }>(
          `SELECT PurchaserEmail FROM core.ScoRow
            WHERE ScoRowID = @rowId AND ScoImportID = @importId`,
          {
            rowId: { type: sql.Int, value: rowId },
            importId: { type: sql.Int, value: importId },
          },
        );
        email = r.recordset[0]?.PurchaserEmail ?? null;
      }

      const params: Record<string, SqlParam> = {};
      const where: string[] = ['r.IsCancelled = 0', 'ISNULL(r.PaidAmount, 0) <= 0'];

      if (search !== '') {
        where.push(
          `(pt.FirstName LIKE @q OR pt.LastName LIKE @q
            OR CONCAT(pt.FirstName, ' ', pt.LastName) LIKE @q
            OR pt.Email LIKE @q)`,
        );
        params.q = { type: sql.NVarChar(260), value: `%${search}%` };
      } else if (email) {
        where.push('LOWER(LTRIM(RTRIM(pt.Email))) = @email');
        params.email = { type: sql.NVarChar(255), value: email.toLowerCase() };
      } else {
        // No row and no search: there is nothing to narrow by, so return
        // nothing rather than every unpaid registration in the database.
        res.json({ rows: [] });
        return;
      }

      const rows = await query<Record<string, unknown>>(
        `SELECT TOP 50
                r.RegistrationID, r.ParticipantID,
                CONCAT(pt.FirstName, ' ', pt.LastName) AS ParticipantName,
                r.WorkshopID, n.WorkshopName, w.WorkshopCode,
                CONVERT(NVARCHAR(10), w.StartDate, 23) AS WorkshopDate,
                w.Cost1 AS WorkshopPrice,
                r.PaidAmount,
                CASE WHEN w.Cost1 IS NULL THEN NULL
                     ELSE w.Cost1 - ISNULL(r.PaidAmount, 0) END AS Owed
           FROM core.Registration r
           JOIN core.Participant  pt ON pt.ParticipantID = r.ParticipantID
           JOIN core.Workshop    w  ON w.WorkshopID = r.WorkshopID
           LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
          WHERE ${where.join(' AND ')}
          ORDER BY w.StartDate DESC, r.RegistrationID DESC`,
        params,
      );

      res.json({ rows: rows.recordset.map((r) => ({ ...r, isCurrent: false })) });
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------ */
/*  Apply                                                              */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/school-cash/imports/{id}/apply:
 *   post:
 *     tags: [School Cash]
 *     summary: Turn the staged matches into payments
 *     description: >
 *       Every High-confidence row becomes a core.Payment and its registration
 *       is marked paid. Rows still needing review are left untouched and
 *       reported back; the import stays Staged so the remainder can be
 *       resolved and applied later.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Applied, with counts }
 *       409: { description: Already applied, or nothing left to apply }
 */
schoolCashRouter.post(
  '/imports/:id/apply',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const importId = Number(req.params.id);
      if (!Number.isInteger(importId) || importId <= 0) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid import id.' });
        return;
      }

      const header = await query<{ Status: string; Unresolved: number }>(
        `SELECT im.Status,
                (SELECT COUNT(*) FROM core.ScoItem i
                  WHERE i.ScoImportID = im.ScoImportID AND i.WorkshopID IS NULL) AS Unresolved
           FROM core.ScoImport im WHERE im.ScoImportID = @id`,
        { id: { type: sql.Int, value: importId } },
      );
      if (!header.recordset[0]) {
        res.status(404).json({ error: 'not_found', message: 'No such import.' });
        return;
      }

      // Unresolved items are reported, not blocking. An admin can continue and
      // apply what is matched, then come back and resolve the rest — the rows
      // for those items stay unmatched and are picked up on the next apply.
      const unresolved = header.recordset[0].Unresolved;

      const ready = await query<{
        ScoRowID: number;
        RowNumber: number;
        PurchaserEmail: string | null;
        PurchaserName: string | null;
        ItemId: string | null;
        ItemName: string | null;
        PaidAmount: string | null;
        ItemBalance: string | null;
        TransactionFee: string | null;
        PurchasedDate: string | null;
        MatchedRegistrationID: number | null;
        ParticipantName: string | null;
        WorkshopName: string | null;
        WorkshopID: number | null;
      }>(
        `SELECT s.ScoRowID, s.RowNumber, s.PurchaserEmail, s.PurchaserName, s.ItemId, s.ItemName,
                s.PaidAmount, s.ItemBalance, s.TransactionFee,
                s.PurchasedDate, s.MatchedRegistrationID,
                CONCAT(pt.FirstName, ' ', pt.LastName) AS ParticipantName,
                n.WorkshopName, i.WorkshopID
           FROM core.ScoRow s
           JOIN core.ScoItem i ON i.ScoItemID = s.ScoItemID
           LEFT JOIN core.Registration r ON r.RegistrationID = s.MatchedRegistrationID
           LEFT JOIN core.Participant  pt ON pt.ParticipantID = r.ParticipantID
           LEFT JOIN core.Workshop    w  ON w.WorkshopID = r.WorkshopID
           LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
          WHERE s.ScoImportID = @id
            AND s.MatchConfidence = 'High'
            AND s.AppliedPaymentID IS NULL
          ORDER BY s.RowNumber`,
        { id: { type: sql.Int, value: importId } },
      );

      if (ready.recordset.length === 0) {
        res.status(409).json({
          error: 'nothing_to_apply',
          message: 'No matched rows are waiting to be applied.',
        });
        return;
      }

      const methodId = await schoolCashMethodId();
      const pool = await getPool();
      const tx = pool.transaction();
      await tx.begin();

      let applied = 0;
      const conflicts: { rowNumber: number; itemName: string | null; reason: string }[] = [];

      try {
        const seq = await txQuery<{ NextPayment: number }>(
          tx,
          `SELECT ISNULL(MAX(PaymentID), 0) + 1 AS NextPayment FROM core.Payment WITH (TABLOCKX)`,
        );
        let nextPaymentId = seq.recordset[0]!.NextPayment;

        for (const row of ready.recordset) {
          const amount = parseMoney(row.ItemBalance) ?? 0;
          const fee = parseMoney(row.TransactionFee) ?? 0;

          // A row whose purchaser had no participant at upload time is
          // matched by email and needs its participant and registration
          // created here. Done inside the transaction so a failure leaves
          // nothing behind.
          let registrationId = row.MatchedRegistrationID;
          if (registrationId === null) {
            const created = await createRegistrationFor(row, tx);
            if (!created.ok) {
              conflicts.push({ rowNumber: row.RowNumber, itemName: row.ItemName, reason: created.reason });
              continue;
            }
            registrationId = created.registrationId;
            await txQuery(
              tx,
              `UPDATE core.ScoRow SET MatchedRegistrationID = @regId WHERE ScoRowID = @rowId`,
              {
                rowId: { type: sql.BigInt, value: row.ScoRowID },
                regId: { type: sql.Int, value: registrationId },
              },
            );
          } else {
            // Re-check inside the transaction: the registration may have been
            // paid by someone else between staging and apply.
            const reg = await txQuery<{ PaidAmount: number | null; IsCancelled: boolean; PaymentID: number | null }>(
              tx,
              `SELECT PaidAmount, IsCancelled, PaymentID
                 FROM core.Registration WITH (UPDLOCK) WHERE RegistrationID = @id`,
              { id: { type: sql.Int, value: registrationId } },
            );
            const current = reg.recordset[0];
            if (!current) {
              conflicts.push({ rowNumber: row.RowNumber, itemName: row.ItemName, reason: 'Registration no longer exists.' });
              continue;
            }
            if (current.IsCancelled) {
              conflicts.push({ rowNumber: row.RowNumber, itemName: row.ItemName, reason: 'Registration is cancelled.' });
              continue;
            }
            if ((current.PaidAmount ?? 0) > 0) {
              conflicts.push({ rowNumber: row.RowNumber, itemName: row.ItemName, reason: 'Registration has already been paid.' });
              continue;
            }
          }

          // Read the identity computed at upload, so apply writes exactly what
          // the duplicate check compared against.
          const staged = await txQuery<{ RowIdentity: string | null }>(
            tx,
            `SELECT RowIdentity FROM core.ScoRow WHERE ScoRowID = @rowId`,
            { rowId: { type: sql.BigInt, value: row.ScoRowID } },
          );
          const externalId = staged.recordset[0]?.RowIdentity ?? null;

          // Two uploads can both be staged before either is applied, so the
          // duplicate check has to run again here — the unique index would
          // reject the insert anyway, but a conflict reads better than a
          // constraint error.
          if (externalId) {
            const paid = await txQuery<{ n: number }>(
              tx,
              `SELECT COUNT(*) AS n FROM core.Payment WHERE ExternalPaymentId = @identity`,
              { identity: { type: sql.NVarChar(400), value: externalId } },
            );
            if ((paid.recordset[0]?.n ?? 0) > 0) {
              conflicts.push({
                rowNumber: row.RowNumber,
                itemName: row.ItemName,
                reason: 'This purchase was already paid from another upload.',
              });
              continue;
            }
          }

          const receipt: string | null = null;

          const payment = await txQuery<{ PaymentID: number }>(
            tx,
            `INSERT INTO core.Payment
                    (PaymentID, PaymentMethodID, PaymentTotal, PaidDate, Notes,
                     Source, ExternalReceipt, ExternalPaymentId, FeeAmount)
             OUTPUT INSERTED.PaymentID AS PaymentID
             VALUES (@id, @method, @total, @paidDate, @notes,
                     'SchoolCash', @receipt, @externalId, @fee)`,
            {
              id: { type: sql.Int, value: nextPaymentId },
              method: { type: sql.Int, value: methodId },
              total: { type: sql.Decimal(19, 4), value: amount },
              paidDate: { type: sql.Date, value: parseVendorDate(row.PurchasedDate) },
              notes: { type: sql.NVarChar(255), value: truncate(row.ItemName, 255) },
              receipt: { type: sql.NVarChar(100), value: receipt },
              externalId: { type: sql.NVarChar(100), value: externalId },
              fee: { type: sql.Decimal(19, 4), value: fee },
            },
          );
          const paymentId = payment.recordset[0]!.PaymentID;

          // PaidAmount is the item price. The fee lives on the payment only.
          await txQuery(
            tx,
            `UPDATE core.Registration
                SET PaidAmount = @amount,
                    PaymentID = @paymentId,
                    PaymentMethodID = @method,
                    PaidDate = @paidDate,
                    UpdatedAt = SYSUTCDATETIME()
              WHERE RegistrationID = @regId`,
            {
              regId: { type: sql.Int, value: row.MatchedRegistrationID },
              amount: { type: sql.Decimal(19, 4), value: amount },
              paymentId: { type: sql.Int, value: paymentId },
              method: { type: sql.Int, value: methodId },
              paidDate: { type: sql.Date, value: parseVendorDate(row.PurchasedDate) },
            },
          );

          await txQuery(
            tx,
            `UPDATE core.ScoRow SET AppliedPaymentID = @paymentId WHERE ScoRowID = @rowId`,
            {
              rowId: { type: sql.BigInt, value: row.ScoRowID },
              paymentId: { type: sql.Int, value: paymentId },
            },
          );

          nextPaymentId += 1;
          applied += 1;
        }

        // The import stays Staged while rows still need review, so an admin
        // can resolve them and apply again without re-uploading.
        const remaining = await txQuery<{ n: number }>(
          tx,
          `SELECT COUNT(*) AS n FROM core.ScoRow
            WHERE ScoImportID = @id AND AppliedPaymentID IS NULL
              AND MatchConfidence IN ('High','Low','None')`,
          { id: { type: sql.Int, value: importId } },
        );
        const stillStaged = (remaining.recordset[0]?.n ?? 0) > 0;

        await txQuery(
          tx,
          `UPDATE core.ScoImport
              SET AppliedCount = AppliedCount + @applied,
                  Status = @status,
                  AppliedBy = @by,
                  AppliedAt = SYSUTCDATETIME()
            WHERE ScoImportID = @id`,
          {
            id: { type: sql.Int, value: importId },
            applied: { type: sql.Int, value: applied },
            status: { type: sql.NVarChar(20), value: stillStaged ? 'Staged' : 'Applied' },
            by: { type: sql.NVarChar(200), value: req.user!.email },
          },
        );

        await tx.commit();
        res.json({ importId, applied, skipped: conflicts.length, conflicts, unresolved });
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/school-cash/imports/{id}/discard:
 *   post:
 *     tags: [School Cash]
 *     summary: Delete a staged import and its rows
 *     description: >
 *       Removes the upload entirely, so it no longer appears in the list. The
 *       staged rows go with it (cascade). An import that produced payments
 *       cannot be discarded - those payments are real and the history must
 *       keep pointing at the file they came from.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       409: { description: Already produced payments }
 */
schoolCashRouter.post(
  '/imports/:id/discard',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const importId = Number(req.params.id);
      const header = await query<{ Status: string; AppliedCount: number }>(
        'SELECT Status, AppliedCount FROM core.ScoImport WHERE ScoImportID = @id',
        { id: { type: sql.Int, value: importId } },
      );
      const row = header.recordset[0];
      if (!row) {
        res.status(404).json({ error: 'not_found', message: 'No such import.' });
        return;
      }
      if (row.AppliedCount > 0) {
        res.status(409).json({
          error: 'already_applied',
          message:
            'Some rows from this upload have already produced payments, so it cannot be discarded. ' +
            'Those payments are recorded against it.',
        });
        return;
      }

      // The row count is checked rather than assumed: if the cascade is ever
      // dropped, deleting the header would orphan every staged row.
      await query('DELETE FROM core.ScoRow WHERE ScoImportID = @id', {
        id: { type: sql.Int, value: importId },
      });
      await query('DELETE FROM core.ScoImport WHERE ScoImportID = @id', {
        id: { type: sql.Int, value: importId },
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------ */
/*  History                                                            */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/school-cash/history:
 *   get:
 *     tags: [School Cash]
 *     summary: Permanent record of every applied payment
 *     description: >
 *       Readable by every signed-in role, because staff review this. Only
 *       admins can upload, match, or apply.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Paged history }
 */
schoolCashRouter.get('/history', requireAuth, async (req, res, next) => {
  try {
    const parsed = historyQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', details: parsed.error.issues });
      return;
    }
    const { page, pageSize, q, importId, from, to } = parsed.data;

    const where: string[] = ['s.AppliedPaymentID IS NOT NULL'];
    const params: Record<string, SqlParam> = {};

    if (importId !== undefined) {
      where.push('s.ScoImportID = @importId');
      params.importId = { type: sql.Int, value: importId };
    }
    if (q) {
      where.push(
        `(s.PurchaserEmail LIKE @q OR s.PurchaserName LIKE @q OR s.ItemName LIKE @q
          OR CONCAT(pt.FirstName, ' ', pt.LastName) LIKE @q OR n.WorkshopName LIKE @q)`,
      );
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    if (from) {
      where.push('i.UploadedAt >= @from');
      params.from = { type: sql.Date, value: from };
    }
    if (to) {
      where.push('i.UploadedAt < DATEADD(DAY, 1, @to)');
      params.to = { type: sql.Date, value: to };
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const totals = await query<{ total: number; amount: number | null; fees: number | null }>(
      `SELECT COUNT(*) AS total,
              SUM(pay.PaymentTotal) AS amount,
              SUM(ISNULL(pay.FeeAmount, 0)) AS fees
         FROM core.ScoRow s
         JOIN core.ScoImport i ON i.ScoImportID = s.ScoImportID
         LEFT JOIN core.Payment pay ON pay.PaymentID = s.AppliedPaymentID
         LEFT JOIN core.Registration r ON r.RegistrationID = s.MatchedRegistrationID
         LEFT JOIN core.Participant pt ON pt.ParticipantID = r.ParticipantID
         LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
         ${whereSql}`,
      params,
    );

    const rows = await query<Record<string, unknown>>(
      `SELECT s.ScoRowID, s.ScoImportID, i.FileName,
              CONVERT(NVARCHAR(30), i.AppliedAt, 126) AS AppliedAt,
              i.AppliedBy,
              s.RowNumber, s.PurchaserEmail, s.PurchaserName, s.ItemName,
              s.ItemBalance, s.TransactionFee, s.PurchasedDate,
              CONCAT(pt.FirstName, ' ', pt.LastName) AS ParticipantName,
              n.WorkshopName, w.WorkshopCode,
              s.AppliedPaymentID AS PaymentID, s.MatchMethod
         FROM core.ScoRow s
         JOIN core.ScoImport i ON i.ScoImportID = s.ScoImportID
         LEFT JOIN core.Registration r ON r.RegistrationID = s.MatchedRegistrationID
         LEFT JOIN core.Participant pt ON pt.ParticipantID = r.ParticipantID
         LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
         ${whereSql}
         ORDER BY i.UploadedAt DESC, s.RowNumber ASC
         OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY`,
      {
        ...params,
        offset: { type: sql.Int, value: (page - 1) * pageSize },
        take: { type: sql.Int, value: pageSize },
      },
    );

    res.json({
      rows: rows.recordset.map((r) => ({
        ...r,
        ItemBalance: parseMoney(r.ItemBalance as string | null),
        TransactionFee: parseMoney(r.TransactionFee as string | null),
      })),
      total: totals.recordset[0]!.total,
      page,
      pageSize,
      totalAmount: totals.recordset[0]!.amount ?? 0,
      totalFees: totals.recordset[0]!.fees ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

/** "09/15/2026 10:22 AM" -> a Date, or null when the text is not a date. */
function parseVendorDate(text: string | null): Date | null {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function truncate(text: string | null, max: number): string | null {
  if (!text) return null;
  return text.length <= max ? text : text.slice(0, max);
}
