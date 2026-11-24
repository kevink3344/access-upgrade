import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getPool, query, sql, txQuery, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  matchRow,
  parseMoney,
  parseScoCsv,
  type MatchCandidate,
  type ScoCsvRow,
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
 *    income. See docs/plans/school-cash-matching.md §11.2.
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

/** The vendor's stable identity for a row, used for the idempotency index. */
function externalKeys(row: ScoCsvRow): { receipt: string | null; paymentId: string | null } {
  const receipt = row.raw['Receipt Number']?.trim() || null;
  const paymentId = row.raw['Payment Id']?.trim() || row.raw['Transaction Id']?.trim() || null;
  return { receipt, paymentId };
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
 * "Owed" is the workshop price less whatever has already been paid. Where the
 * price is unknown the registration still counts as a candidate — an admin
 * can match it by hand — but it cannot win the amount rule.
 */
async function unpaidCandidates(participantId: number): Promise<MatchCandidate[]> {
  const r = await query<{ RegistrationID: number; Owed: number | null }>(
    `SELECT r.RegistrationID,
            CASE WHEN w.Price IS NULL THEN NULL
                 ELSE w.Price - ISNULL(r.PaidAmount, 0)
            END AS Owed
       FROM core.Registration r
       JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
      WHERE r.ParticipantID = @pid
        AND r.IsCancelled = 0
        AND ISNULL(r.PaidAmount, 0) <= 0
      ORDER BY r.RegistrationID`,
    { pid: { type: sql.Int, value: participantId } },
  );
  return r.recordset.map((row) => ({ registrationId: row.RegistrationID, owed: row.Owed }));
}

/** True when this vendor row already produced a payment. */
async function alreadyApplied(row: ScoCsvRow): Promise<boolean> {
  const { receipt, paymentId } = externalKeys(row);
  if (!receipt && !paymentId) return false;

  const r = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM core.Payment
      WHERE (@receipt IS NOT NULL AND ExternalReceipt = @receipt)
         OR (@paymentId IS NOT NULL AND ExternalPaymentId = @paymentId)`,
    {
      receipt: { type: sql.NVarChar(100), value: receipt },
      paymentId: { type: sql.NVarChar(100), value: paymentId },
    },
  );
  return (r.recordset[0]?.n ?? 0) > 0;
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
 * Matches one parsed row and returns the staging columns to persist.
 *
 * Kept separate from the insert so the same logic can be reused when an admin
 * re-runs matching on an import.
 */
async function evaluateRow(row: ScoCsvRow): Promise<{
  matchedRegistrationId: number | null;
  confidence: string;
  method: string;
  note: string | null;
}> {
  if (await alreadyApplied(row)) {
    return {
      matchedRegistrationId: null,
      confidence: 'Duplicate',
      method: 'duplicate',
      note: 'This receipt already produced a payment.',
    };
  }

  const email = row.purchaserEmail;
  const itemBalance = parseMoney(row.itemBalance);

  if (!email) {
    return {
      matchedRegistrationId: null,
      confidence: 'None',
      method: 'none',
      note: 'No purchaser email on this row.',
    };
  }

  const participantId = await participantForEmail(email);
  if (participantId === null) {
    return {
      matchedRegistrationId: null,
      confidence: 'None',
      method: 'none',
      note: 'No participant uses this email address.',
    };
  }

  const candidates = await unpaidCandidates(participantId);
  const outcome = matchRow({ purchaserEmail: email, itemBalance, alreadyApplied: false }, candidates);

  return {
    matchedRegistrationId: outcome.registrationId,
    confidence: outcome.confidence,
    method: outcome.method,
    note: outcome.note,
  };
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
 *       The file name goes in the X-File-Name header. Nothing is applied —
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

      const existing = await query<{ ScoImportID: number; FileName: string; UploadedAt: string }>(
        `SELECT ScoImportID, FileName, CONVERT(NVARCHAR(30), UploadedAt, 126) AS UploadedAt
           FROM core.ScoImport WHERE FileHash = @hash`,
        { hash: { type: sql.VarBinary(32), value: hash } },
      );
      if (existing.recordset[0]) {
        const prior = existing.recordset[0];
        res.status(409).json({
          error: 'already_imported',
          message: `This exact file was already uploaded on ${prior.UploadedAt}.`,
          importId: prior.ScoImportID,
        });
        return;
      }

      // Evaluate first, then write. The matcher issues several queries per
      // row, and holding a transaction open across ~100 round trips would
      // risk a timeout; nothing is visible until the insert below commits.
      const evaluated: Array<{
        row: ScoCsvRow;
        matchedRegistrationId: number | null;
        confidence: string;
        method: string;
        note: string | null;
      }> = [];
      for (const row of parsed.rows) {
        evaluated.push({ row, ...(await evaluateRow(row)) });
      }

      const matched = evaluated.filter((e) => e.confidence === 'High').length;
      const review = evaluated.filter((e) => e.confidence === 'Low' || e.confidence === 'None').length;
      const ignored = evaluated.filter((e) => e.confidence === 'Duplicate').length;

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
           VALUES (@fileName, @hash, @totalRows, @matched, @review, @ignored, 'Staged', @by)`,
          {
            fileName: { type: sql.NVarChar(260), value: fileName },
            hash: { type: sql.VarBinary(32), value: hash },
            totalRows: { type: sql.Int, value: evaluated.length },
            matched: { type: sql.Int, value: matched },
            review: { type: sql.Int, value: review },
            ignored: { type: sql.Int, value: ignored },
            by: { type: sql.NVarChar(200), value: req.user!.email },
          },
        );
        const importId = header.recordset[0]!.id;

        for (const e of evaluated) {
          await txQuery(
            tx,
            `INSERT INTO core.ScoRow
                    (ScoImportID, RowNumber, PurchaserEmail, PurchaserName, RecipientName,
                     ItemId, ItemName, PaidAmount, ItemBalance, TransactionFee,
                     PurchasedDate, Owing, Refunded, RawJson,
                     MatchedRegistrationID, MatchConfidence, MatchMethod, MatchNote)
             VALUES (@importId, @rowNumber, @email, @purchaser, @recipient,
                     @itemId, @itemName, @paid, @balance, @fee,
                     @purchased, @owing, @refunded, @raw,
                     @regId, @confidence, @method, @note)`,
            {
              importId: { type: sql.Int, value: importId },
              rowNumber: { type: sql.Int, value: e.row.rowNumber },
              email: { type: sql.NVarChar(255), value: e.row.purchaserEmail },
              purchaser: { type: sql.NVarChar(255), value: e.row.purchaserName },
              recipient: { type: sql.NVarChar(255), value: e.row.recipientName },
              itemId: { type: sql.NVarChar(50), value: e.row.itemId },
              itemName: { type: sql.NVarChar(255), value: e.row.itemName },
              paid: { type: sql.NVarChar(50), value: e.row.paidAmount },
              balance: { type: sql.NVarChar(50), value: e.row.itemBalance },
              fee: { type: sql.NVarChar(50), value: e.row.transactionFee },
              purchased: { type: sql.NVarChar(50), value: e.row.purchasedDate },
              owing: { type: sql.NVarChar(50), value: e.row.owing },
              refunded: { type: sql.NVarChar(50), value: e.row.refunded },
              raw: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(e.row.raw) },
              regId: { type: sql.Int, value: e.matchedRegistrationId },
              confidence: { type: sql.NVarChar(10), value: e.confidence },
              method: { type: sql.NVarChar(20), value: e.method },
              note: { type: sql.NVarChar(255), value: e.note },
            },
          );
        }

        await tx.commit();
        res.status(201).json({
          importId,
          fileName,
          TotalRows: evaluated.length,          matched,
          review,
          ignored,
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
                CASE WHEN w.Price IS NULL THEN NULL
                     ELSE w.Price - ISNULL(r.PaidAmount, 0) END AS RegistrationOwed
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
                w.Price AS WorkshopPrice,
                r.PaidAmount,
                CASE WHEN w.Price IS NULL THEN NULL
                     ELSE w.Price - ISNULL(r.PaidAmount, 0) END AS Owed
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

      const header = await query<{ Status: string }>(
        'SELECT Status FROM core.ScoImport WHERE ScoImportID = @id',
        { id: { type: sql.Int, value: importId } },
      );
      if (!header.recordset[0]) {
        res.status(404).json({ error: 'not_found', message: 'No such import.' });
        return;
      }
      if (header.recordset[0].Status === 'Discarded') {
        res.status(409).json({ error: 'discarded', message: 'This import was discarded.' });
        return;
      }

      const ready = await query<{
        ScoRowID: number;
        RowNumber: number;
        ItemName: string | null;
        ItemBalance: string | null;
        TransactionFee: string | null;
        PurchasedDate: string | null;
        MatchedRegistrationID: number;
        ParticipantName: string | null;
        WorkshopName: string | null;
      }>(
        `SELECT s.ScoRowID, s.RowNumber, s.ItemName, s.ItemBalance, s.TransactionFee,
                s.PurchasedDate, s.MatchedRegistrationID,
                CONCAT(pt.FirstName, ' ', pt.LastName) AS ParticipantName,
                n.WorkshopName
           FROM core.ScoRow s
           LEFT JOIN core.Registration r ON r.RegistrationID = s.MatchedRegistrationID
           LEFT JOIN core.Participant  pt ON pt.ParticipantID = r.ParticipantID
           LEFT JOIN core.Workshop    w  ON w.WorkshopID = r.WorkshopID
           LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
          WHERE s.ScoImportID = @id
            AND s.MatchConfidence = 'High'
            AND s.MatchedRegistrationID IS NOT NULL
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
          // Re-check inside the transaction: the registration may have been
          // paid by someone else between staging and apply.
          const reg = await txQuery<{ PaidAmount: number | null; IsCancelled: boolean; PaymentID: number | null }>(
            tx,
            `SELECT PaidAmount, IsCancelled, PaymentID
               FROM core.Registration WITH (UPDLOCK) WHERE RegistrationID = @id`,
            { id: { type: sql.Int, value: row.MatchedRegistrationID } },
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

          const amount = parseMoney(row.ItemBalance) ?? 0;
          const fee = parseMoney(row.TransactionFee) ?? 0;

          const raw = await txQuery<{ RawJson: string | null }>(
            tx,
            `SELECT RawJson FROM core.ScoRow WHERE ScoRowID = @rowId`,
            { rowId: { type: sql.BigInt, value: row.ScoRowID } },
          );
          let receipt: string | null = null;
          let externalId: string | null = null;
          try {
            const rawObj = JSON.parse(raw.recordset[0]?.RawJson ?? '{}') as Record<string, string>;
            receipt = rawObj['Receipt Number']?.trim() || null;
            externalId = rawObj['Payment Id']?.trim() || rawObj['Transaction Id']?.trim() || null;
          } catch {
            // A row whose raw JSON will not parse still applies; it just
            // loses its vendor identity, and the unique index tolerates nulls.
          }

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
        res.json({ importId, applied, skipped: conflicts.length, conflicts });
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
 *     summary: Discard a staged import without applying anything
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Discarded }
 *       409: { description: Already applied }
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
          message: 'Some rows from this import have already produced payments, so it cannot be discarded.',
        });
        return;
      }

      await query(
        `UPDATE core.ScoImport SET Status = 'Discarded' WHERE ScoImportID = @id`,
        { id: { type: sql.Int, value: importId } },
      );
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
