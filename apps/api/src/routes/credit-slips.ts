import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

/**
 * Credit slips: internal vouchers issued when a workshop is cancelled or a
 * participant overpaid, redeemable against a future registration.
 *
 * Two things about the legacy data shape drive this module:
 *
 *  - A slip has an *issuer* (`ParticipantID`) and an optional *redeemer*
 *    (`UsedParticipantID`). 121 of 846 slips were redeemed by someone other
 *    than the person they were issued to, so the two must never be conflated.
 *  - "Used" is `DateUsed IS NOT NULL`, not a status column. The legacy table
 *    never had one, and deriving it keeps the two facts from drifting.
 */
export const creditSlipsRouter = Router();

const EDIT_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'] as const;

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  status: z.enum(['all', 'unused', 'used']).default('all'),
  categoryId: z.coerce.number().int().positive().optional(),
  trackingYear: z.coerce.number().int().optional(),
  sort: z.enum(['recent', 'oldest', 'amount', 'participant']).default('recent'),
});

const writeSchema = z.object({
  categoryId: z.number().int().positive().nullable().optional(),
  participantId: z.number().int().positive().nullable().optional(),
  workshopId: z.number().int().positive().nullable().optional(),
  dateIssued: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  amount: z.number().nullable().optional(),
  trackingYear: z.number().int().min(1900).max(2200).nullable().optional(),
  email: z.boolean().optional(),
});

/** Redeeming is its own action, so it gets its own schema. */
const redeemSchema = z.object({
  usedParticipantId: z.number().int().positive().nullable().optional(),
  usedWorkshopId: z.number().int().positive().nullable().optional(),
  dateUsed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
});

const SORTS: Record<string, string> = {
  recent: 'cs.DateIssued DESC, cs.CreditSlipID DESC',
  oldest: 'cs.DateIssued ASC, cs.CreditSlipID ASC',
  amount: 'cs.Amount DESC',
  participant: 'p.LastName ASC, p.FirstName ASC',
};

const STATUS_FILTERS: Record<string, string> = {
  all: '',
  unused: 'AND cs.DateUsed IS NULL',
  used: 'AND cs.DateUsed IS NOT NULL',
};

/**
 * @openapi
 * /api/credit-slips:
 *   get:
 *     tags: [Credit slips]
 *     summary: List credit slips
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25, maximum: 200 } }
 *       - { in: query, name: q, schema: { type: string }, description: Participant name or email }
 *       - { in: query, name: status, schema: { type: string, enum: [all, unused, used] } }
 *       - { in: query, name: categoryId, schema: { type: integer } }
 *       - { in: query, name: trackingYear, schema: { type: integer } }
 *       - { in: query, name: sort, schema: { type: string, enum: [recent, oldest, amount, participant] } }
 *     responses:
 *       200:
 *         description: Paginated slips with counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/CreditSlipSummary' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 *                 counts: { type: object }
 */
creditSlipsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = listQuery.safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid query parameters',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { page, pageSize, q, status, categoryId, trackingYear, sort } = parsed.data;

    const where: string[] = ['1 = 1'];
    const params: Record<string, SqlParam> = {};

    if (q) {
      where.push(
        '(p.FirstName LIKE @q OR p.LastName LIKE @q OR p.Email LIKE @q OR up.FirstName LIKE @q OR up.LastName LIKE @q)',
      );
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    if (STATUS_FILTERS[status]) where.push(STATUS_FILTERS[status].replace(/^AND /, ''));
    if (categoryId) {
      where.push('cs.CreditSlipsCategoryID = @cat');
      params.cat = { type: sql.Int, value: categoryId };
    }
    if (trackingYear) {
      where.push('cs.TrackingYear = @year');
      params.year = { type: sql.Int, value: trackingYear };
    }

    const from = `
      FROM core.CreditSlip cs
      LEFT JOIN core.Participant p  ON p.ParticipantID  = cs.ParticipantID
      LEFT JOIN core.Participant up ON up.ParticipantID = cs.UsedParticipantID
      LEFT JOIN ref.CreditSlipCategory cat ON cat.CreditSlipsCategoryID = cs.CreditSlipsCategoryID
      LEFT JOIN core.Workshop w ON w.WorkshopID = cs.WorkshopID
      LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID`;

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const count = await query<{ n: number }>(
      `SELECT COUNT(*) AS n ${from} ${whereSql}`,
      params,
    );

    // Counts ignore the status filter so the chips describe the whole set,
    // but honour the search and category/year filters.
    const countWhere = where.filter((w) => !w.startsWith('cs.DateUsed'));
    const counts = await query<{ all: number; unused: number; used: number; totalAmount: number }>(
      `SELECT COUNT(*) AS [all],
              SUM(CASE WHEN cs.DateUsed IS NULL THEN 1 ELSE 0 END) AS unused,
              SUM(CASE WHEN cs.DateUsed IS NOT NULL THEN 1 ELSE 0 END) AS used,
              ISNULL(SUM(CASE WHEN cs.DateUsed IS NULL THEN cs.Amount ELSE 0 END), 0) AS totalAmount
         ${from}
        WHERE ${countWhere.join(' AND ')}`,
      params,
    );

    const rows = await query(
      `SELECT cs.CreditSlipID, cs.CreditSlipsCategoryID, cat.CreditSlipsCategory,
              cs.ParticipantID,
              CONCAT(p.FirstName, ' ', p.LastName) AS ParticipantName,
              p.Email AS ParticipantEmail,
              cs.WorkshopID, n.WorkshopName,
              cs.DateIssued, cs.DateUsed,
              cs.UsedParticipantID,
              CONCAT(up.FirstName, ' ', up.LastName) AS UsedParticipantName,
              cs.UsedWorkshopID,
              cs.Amount, cs.TrackingYear, cs.Email
         ${from}
         ${whereSql}
        ORDER BY ${SORTS[sort]}
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        ...params,
        offset: { type: sql.Int, value: (page - 1) * pageSize },
        limit: { type: sql.Int, value: pageSize },
      },
    );

    res.json({
      data: rows.recordset,
      page,
      pageSize,
      total: count.recordset[0]?.n ?? 0,
      counts: counts.recordset[0] ?? { all: 0, unused: 0, used: 0, totalAmount: 0 },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/credit-slips/{id}:
 *   get:
 *     tags: [Credit slips]
 *     summary: Get a credit slip
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Credit slip }
 *       404: { description: Not found }
 */
creditSlipsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const r = await query(
      `SELECT cs.*, cat.CreditSlipsCategory,
              CONCAT(p.FirstName, ' ', p.LastName) AS ParticipantName,
              p.Email AS ParticipantEmail,
              n.WorkshopName, w.WorkshopCode,
              CONCAT(up.FirstName, ' ', up.LastName) AS UsedParticipantName,
              uw.WorkshopCode AS UsedWorkshopCode,
              un.WorkshopName AS UsedWorkshopName
         FROM core.CreditSlip cs
         LEFT JOIN ref.CreditSlipCategory cat ON cat.CreditSlipsCategoryID = cs.CreditSlipsCategoryID
         LEFT JOIN core.Participant p  ON p.ParticipantID  = cs.ParticipantID
         LEFT JOIN core.Participant up ON up.ParticipantID = cs.UsedParticipantID
         LEFT JOIN core.Workshop w  ON w.WorkshopID  = cs.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
         LEFT JOIN core.Workshop uw ON uw.WorkshopID = cs.UsedWorkshopID
         LEFT JOIN core.WorkshopName un ON un.WorkshopNameID = uw.WorkshopNameID
        WHERE cs.CreditSlipID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = r.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Credit slip not found' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/credit-slips:
 *   post:
 *     tags: [Credit slips]
 *     summary: Issue a credit slip
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Created }
 *       422: { description: Validation failed }
 */
creditSlipsRouter.post('/', requireAuth, requireRole(...EDIT_ROLES), async (req, res, next) => {
  try {
    const parsed = writeSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid credit slip',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    // A slip without an owner or an amount is not a voucher anyone can
    // redeem, so both are required at issue time even though the legacy
    // columns are nullable.
    const d = parsed.data;
    if (!d.participantId) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Choose the participant the slip is issued to',
        details: [{ path: 'participantId', message: 'Required' }],
      });
      return;
    }
    if (d.amount === null || d.amount === undefined) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Enter the slip amount',
        details: [{ path: 'amount', message: 'Required' }],
      });
      return;
    }
    if (d.amount <= 0) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'The amount must be greater than zero',
        details: [{ path: 'amount', message: 'Must be positive' }],
      });
      return;
    }

    const next = await query<{ NextId: number }>(
      'SELECT ISNULL(MAX(CreditSlipID), 0) + 1 AS NextId FROM core.CreditSlip',
    );

    const created = await query<{ CreditSlipID: number }>(
      `INSERT INTO core.CreditSlip
              (CreditSlipID, CreditSlipsCategoryID, ParticipantID, WorkshopID,
               DateIssued, Amount, TrackingYear, Email)
       OUTPUT INSERTED.CreditSlipID
       VALUES (@id, @cat, @pid, @wid, @issued, @amount, @year, @email)`,
      {
        id: { type: sql.Int, value: next.recordset[0]!.NextId },
        cat: { type: sql.Int, value: d.categoryId ?? null },
        pid: { type: sql.Int, value: d.participantId },
        wid: { type: sql.Int, value: d.workshopId ?? null },
        issued: { type: sql.Date, value: d.dateIssued ?? new Date().toISOString().slice(0, 10) },
        amount: { type: sql.Decimal(19, 4), value: d.amount },
        year: { type: sql.Int, value: d.trackingYear ?? null },
        email: { type: sql.Bit, value: d.email ?? false },
      },
    );

    res.status(201).json({ creditSlipId: created.recordset[0]!.CreditSlipID });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/credit-slips/{id}:
 *   patch:
 *     tags: [Credit slips]
 *     summary: Update a credit slip
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Updated }
 *       404: { description: Not found }
 */
creditSlipsRouter.patch(
  '/:id',
  requireAuth,
  requireRole(...EDIT_ROLES),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const parsed = writeSchema.partial().safeParse(req.body);

      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid credit slip',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const d = parsed.data;
      if (d.amount !== undefined && d.amount !== null && d.amount <= 0) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'The amount must be greater than zero',
          details: [{ path: 'amount', message: 'Must be positive' }],
        });
        return;
      }

      const sets: string[] = [];
      const params: Record<string, SqlParam> = { id: { type: sql.Int, value: id } };
      const map: Array<[keyof typeof d, string, () => SqlParam['type']]> = [
        ['categoryId', 'CreditSlipsCategoryID', () => sql.Int],
        ['participantId', 'ParticipantID', () => sql.Int],
        ['workshopId', 'WorkshopID', () => sql.Int],
        ['dateIssued', 'DateIssued', () => sql.Date],
        ['amount', 'Amount', () => sql.Decimal(19, 4)],
        ['trackingYear', 'TrackingYear', () => sql.Int],
        ['email', 'Email', () => sql.Bit],
      ];

      for (const [key, column, type] of map) {
        if (d[key] === undefined) continue;
        sets.push(`${column} = @${key}`);
        params[key] = { type: type(), value: d[key] ?? null };
      }

      if (sets.length === 0) {
        res.status(422).json({ error: 'validation_failed', message: 'No fields supplied' });
        return;
      }

      const r = await query(
        `UPDATE core.CreditSlip SET ${sets.join(', ')} WHERE CreditSlipID = @id`,
        params,
      );

      if ((r.rowsAffected[0] ?? 0) === 0) {
        res.status(404).json({ error: 'not_found', message: 'Credit slip not found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/credit-slips/{id}/redeem:
 *   post:
 *     tags: [Credit slips]
 *     summary: Redeem a credit slip
 *     description: >
 *       Records when and by whom the slip was used. The redeemer may differ
 *       from the participant the slip was issued to — 121 of the legacy slips
 *       were transferred — so `usedParticipantId` defaults to the issuer but
 *       can be changed.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Redeemed }
 *       409: { description: Already used }
 */
creditSlipsRouter.post(
  '/:id/redeem',
  requireAuth,
  requireRole(...EDIT_ROLES),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const parsed = redeemSchema.safeParse(req.body);

      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid redemption',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const existing = await query<{ DateUsed: Date | null; ParticipantID: number | null }>(
        'SELECT DateUsed, ParticipantID FROM core.CreditSlip WHERE CreditSlipID = @id',
        { id: { type: sql.Int, value: id } },
      );

      const row = existing.recordset[0];
      if (!row) {
        res.status(404).json({ error: 'not_found', message: 'Credit slip not found' });
        return;
      }
      if (row.DateUsed) {
        res.status(409).json({
          error: 'conflict',
          message: 'This slip has already been redeemed. Undo the redemption first.',
        });
        return;
      }

      const d = parsed.data;
      await query(
        `UPDATE core.CreditSlip
            SET DateUsed = @used,
                UsedParticipantID = @upid,
                UsedWorkshopID = @uwid
          WHERE CreditSlipID = @id`,
        {
          id: { type: sql.Int, value: id },
          used: { type: sql.Date, value: d.dateUsed ?? new Date().toISOString().slice(0, 10) },
          // Default to the issuer, not the stored UsedParticipantID: 299 of
          // 300 unused legacy slips carry a stale value there, so inheriting
          // it would record a redeemer nobody chose.
          upid: { type: sql.Int, value: d.usedParticipantId ?? row.ParticipantID },
          uwid: { type: sql.Int, value: d.usedWorkshopId ?? null },
        },
      );

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/credit-slips/{id}/redeem:
 *   delete:
 *     tags: [Credit slips]
 *     summary: Undo a redemption
 *     description: Clears the used fields, returning the slip to unused.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Undone }
 */
creditSlipsRouter.delete(
  '/:id/redeem',
  requireAuth,
  requireRole(...EDIT_ROLES),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const r = await query(
        `UPDATE core.CreditSlip
            SET DateUsed = NULL, UsedParticipantID = NULL, UsedWorkshopID = NULL
          WHERE CreditSlipID = @id`,
        { id: { type: sql.Int, value: id } },
      );

      if ((r.rowsAffected[0] ?? 0) === 0) {
        res.status(404).json({ error: 'not_found', message: 'Credit slip not found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/credit-slips/{id}:
 *   delete:
 *     tags: [Credit slips]
 *     summary: Delete a credit slip
 *     description: >
 *       Refuses to delete a redeemed slip — the redemption is a financial
 *       record, so undo it first if the slip was genuinely created in error.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       409: { description: Slip has been redeemed }
 */
creditSlipsRouter.delete(
  '/:id',
  requireAuth,
  requireRole(...EDIT_ROLES),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const existing = await query<{ DateUsed: Date | null }>(
        'SELECT DateUsed FROM core.CreditSlip WHERE CreditSlipID = @id',
        { id: { type: sql.Int, value: id } },
      );

      const row = existing.recordset[0];
      if (!row) {
        res.status(404).json({ error: 'not_found', message: 'Credit slip not found' });
        return;
      }
      if (row.DateUsed) {
        res.status(409).json({
          error: 'conflict',
          message: 'This slip has been redeemed. Undo the redemption before deleting it.',
        });
        return;
      }

      await query('DELETE FROM core.CreditSlip WHERE CreditSlipID = @id', {
        id: { type: sql.Int, value: id },
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);
