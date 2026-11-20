import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

export const registrationsRouter = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  workshopId: z.coerce.number().int().optional(),
  participantId: z.coerce.number().int().optional(),
  source: z.enum(['Manual', 'Web', 'ESchools']).optional(),
  status: z.enum(['all', 'active', 'cancelled', 'attended', 'unpaid']).default('all'),
});

/**
 * Writable registration fields. `Source` is deliberately excluded — it is
 * set by the system (Manual here, Web by the public form) and must not be
 * forged through this endpoint.
 */
const registrationWriteSchema = z.object({
  participantId: z.number().int().positive(),
  workshopId: z.number().int().min(0).nullable().optional(),
  creditTypeId: z.number().int().nullable().optional(),
  paymentMethodId: z.number().int().nullable().optional(),
  payeeId: z.number().int().nullable().optional(),
  paymentId: z.number().int().nullable().optional(),
  paidAmount: z.number().nullable().optional(),
  ticketCount: z.number().int().min(0).nullable().optional(),
  isScholarship: z.boolean().optional(),
  registrationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  isCancelled: z.boolean().optional(),
  attended: z.boolean().optional(),
  emailConfirmation: z.boolean().optional(),
  receiptNumber: z.number().int().nullable().optional(),
  checkNumber: z.number().int().nullable().optional(),
  checkTotal: z.number().nullable().optional(),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  notes: z.string().max(255).nullable().optional(),
});

const COLUMN_MAP: Record<string, string> = {
  participantId: 'ParticipantID',
  workshopId: 'WorkshopID',
  creditTypeId: 'CreditTypeID',
  paymentMethodId: 'PaymentMethodID',
  payeeId: 'PayeeID',
  paymentId: 'PaymentID',
  paidAmount: 'PaidAmount',
  ticketCount: 'TicketCount',
  isScholarship: 'IsScholarship',
  registrationDate: 'RegistrationDate',
  isCancelled: 'IsCancelled',
  attended: 'Attended',
  emailConfirmation: 'EmailConfirmation',
  receiptNumber: 'ReceiptNumber',
  checkNumber: 'CheckNumber',
  checkTotal: 'CheckTotal',
  paidDate: 'PaidDate',
  notes: 'Notes',
};

function paramType(column: string) {
  if (column.endsWith('ID')) return sql.Int;
  if (column === 'PaidAmount' || column === 'CheckTotal') return sql.Decimal(19, 4);
  if (column === 'RegistrationDate' || column === 'PaidDate') return sql.Date;
  if (column === 'TicketCount' || column === 'ReceiptNumber' || column === 'CheckNumber') return sql.Int;
  if (column === 'Notes') return sql.NVarChar(255);
  if (column.startsWith('Is') || column === 'Attended' || column === 'EmailConfirmation') return sql.Bit;
  return sql.NVarChar(255);
}

/**
 * @openapi
 * /api/registrations:
 *   get:
 *     tags: [Registrations]
 *     summary: List registrations
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25, maximum: 200 } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: workshopId, schema: { type: integer } }
 *       - { in: query, name: participantId, schema: { type: integer } }
 *       - { in: query, name: source, schema: { type: string, enum: [Manual, Web, ESchools] } }
 *       - { in: query, name: status, schema: { type: string, enum: [all, active, cancelled, attended] } }
 *     responses:
 *       200:
 *         description: Paginated registrations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/RegistrationSummary' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 */
registrationsRouter.get('/', requireAuth, async (req, res, next) => {
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

    const { page, pageSize, q, workshopId, participantId, source, status } = parsed.data;

    const where: string[] = [];
    const params: Record<string, SqlParam> = {};

    if (q) {
      where.push('(p.FirstName LIKE @q OR p.LastName LIKE @q OR p.Email LIKE @q OR n.WorkshopName LIKE @q)');
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    if (workshopId) {
      where.push('r.WorkshopID = @wid');
      params.wid = { type: sql.Int, value: workshopId };
    }
    if (participantId) {
      where.push('r.ParticipantID = @pid');
      params.pid = { type: sql.Int, value: participantId };
    }
    if (source) {
      where.push('r.Source = @src');
      params.src = { type: sql.NVarChar(20), value: source };
    }
    if (status === 'active') where.push('r.IsCancelled = 0');
    if (status === 'cancelled') where.push('r.IsCancelled = 1');
    if (status === 'attended') where.push('r.Attended = 1');
    if (status === 'unpaid') where.push('r.IsCancelled = 0 AND r.PaidAmount <= 0');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const base = `
      FROM core.Registration r
      JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
      LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
      LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      ${whereSql}`;

    const count = await query<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, params);
    const total = count.recordset[0]?.n ?? 0;

    const rows = await query(
      `SELECT r.RegistrationID, r.ParticipantID, r.WorkshopID,
              CONCAT(p.FirstName, ' ', p.LastName) AS ParticipantName,
              p.Email, n.WorkshopName, w.WorkshopCode, w.StartDate,
              r.PaidAmount, r.RegistrationDate, r.IsCancelled, r.Attended, r.Source
       ${base}
       ORDER BY r.RegistrationDate DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        ...params,
        offset: { type: sql.Int, value: (page - 1) * pageSize },
        limit: { type: sql.Int, value: pageSize },
      },
    );

    res.json({ data: rows.recordset, page, pageSize, total });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Write endpoints                                                    */
/* ------------------------------------------------------------------ */

/** Participant picker — search by name or email. */
/**
 * @openapi
 * /api/registrations/lookup-participants:
 *   get:
 *     tags: [Registrations]
 *     summary: Search participants for the picker
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: q, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Matching participants
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       label: { type: string }
 */
registrationsRouter.get('/lookup-participants', requireAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (q.length < 2) {
      res.json({ data: [] });
      return;
    }

    const result = await query<{ id: number; label: string }>(
      `SELECT TOP 20
              p.ParticipantID AS id,
              CONCAT(p.FirstName, ' ', p.LastName,
                     CASE WHEN p.Email IS NOT NULL AND p.Email <> '' THEN CONCAT(' · ', p.Email) ELSE '' END) AS label
         FROM core.Participant p
        WHERE p.FirstName LIKE @q OR p.LastName LIKE @q OR p.Email LIKE @q
        ORDER BY p.LastName, p.FirstName`,
      { q: { type: sql.NVarChar(260), value: `%${q}%` } },
    );

    res.json({ data: result.recordset });
  } catch (err) {
    next(err);
  }
});

/** Workshop picker — search by title or code. */
/**
 * @openapi
 * /api/registrations/lookup-workshops:
 *   get:
 *     tags: [Registrations]
 *     summary: Search workshops for the picker
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: q, schema: { type: string } }
 *     responses:
 *       200: { description: Matching workshops }
 */
registrationsRouter.get('/lookup-workshops', requireAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (q.length < 2) {
      res.json({ data: [] });
      return;
    }

    const result = await query<{ id: number; label: string }>(
      `SELECT TOP 20
              w.WorkshopID AS id,
              CONCAT(ISNULL(n.WorkshopName, 'Untitled'), ' · ', ISNULL(w.WorkshopCode, '—'),
                     ' · ', CONVERT(NVARCHAR(10), w.StartDate, 101)) AS label
         FROM core.Workshop w
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
        WHERE n.WorkshopName LIKE @q OR w.WorkshopCode LIKE @q
        ORDER BY w.StartDate DESC`,
      { q: { type: sql.NVarChar(260), value: `%${q}%` } },
    );

    res.json({ data: result.recordset });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/registrations/{id}:
 *   get:
 *     tags: [Registrations]
 *     summary: Get a registration
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Registration detail }
 *       404: { description: Not found }
 */
registrationsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT r.*, CONCAT(p.FirstName, ' ', p.LastName) AS ParticipantName,
              p.Email, n.WorkshopName, w.WorkshopCode
         FROM core.Registration r
         JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
         LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
        WHERE r.RegistrationID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Registration not found' });
      return;
    }

    res.json(row);
  } catch (err) {
    next(err);
  }
});

/* 

/**
 * @openapi
 * /api/registrations:
 *   post:
 *     tags: [Registrations]
 *     summary: Create a registration
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [participantId]
 *             properties:
 *               participantId: { type: integer }
 *               workshopId: { type: integer, nullable: true }
 *               paidAmount: { type: number }
 *               registrationDate: { type: string, format: date }
 *               isScholarship: { type: boolean }
 *               notes: { type: string }
 *     responses:
 *       201: { description: Created }
 *       409: { description: Duplicate registration }
 *       422: { description: Validation failed }
 */
registrationsRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'), async (req, res, next) => {
  try {
    const parsed = registrationWriteSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid registration data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { participantId, workshopId } = parsed.data;

    // Both parents must exist — the FKs would reject them anyway, but a
    // clear 422 beats a raw SQL error.
    const participant = await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM core.Participant WHERE ParticipantID = @id',
      { id: { type: sql.Int, value: participantId } },
    );
    if ((participant.recordset[0]?.n ?? 0) === 0) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Participant not found',
        details: [{ path: 'participantId', message: 'No participant with that id' }],
      });
      return;
    }

    if (workshopId !== null && workshopId !== undefined) {
      const workshop = await query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM core.Workshop WHERE WorkshopID = @id',
        { id: { type: sql.Int, value: workshopId } },
      );
      if ((workshop.recordset[0]?.n ?? 0) === 0) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Workshop not found',
          details: [{ path: 'workshopId', message: 'No workshop with that id' }],
        });
        return;
      }

      // One active registration per participant per workshop.
      const dup = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM core.Registration
          WHERE ParticipantID = @pid AND WorkshopID = @wid AND IsCancelled = 0`,
        {
          pid: { type: sql.Int, value: participantId },
          wid: { type: sql.Int, value: workshopId },
        },
      );
      if ((dup.recordset[0]?.n ?? 0) > 0) {
        res.status(409).json({
          error: 'conflict',
          message: 'This participant is already registered for that workshop',
        });
        return;
      }
    }

    const cols: string[] = [];
    const vals: string[] = [];
    const params: Record<string, SqlParam> = {};

    for (const [key, value] of Object.entries(parsed.data)) {
      const col = COLUMN_MAP[key];
      if (!col) continue;
      cols.push(col);
      vals.push(`@${key}`);
      params[key] = { type: paramType(col), value: value ?? null };
    }

    // Defaults that the form does not send.
    if (!cols.includes('RegistrationDate')) {
      cols.push('RegistrationDate');
      vals.push('CAST(SYSUTCDATETIME() AS DATE)');
    }
    cols.push('Source');
    vals.push("'Manual'");

    // RegistrationID is not an IDENTITY column — it was created as a plain INT
    // so the legacy Access IDs could be loaded verbatim. New rows need an
    // explicit ID, taken from the current maximum.
    const next = await query<{ NextId: number }>(
      'SELECT ISNULL(MAX(RegistrationID), 0) + 1 AS NextId FROM core.Registration',
    );
    cols.push('RegistrationID');
    vals.push('@nextId');
    params.nextId = { type: sql.Int, value: next.recordset[0]!.NextId };

    const created = await query<{ RegistrationID: number }>(
      `INSERT INTO core.Registration (${cols.join(', ')})
       OUTPUT INSERTED.RegistrationID
       VALUES (${vals.join(', ')})`,
      params,
    );

    res.status(201).json({ registrationId: created.recordset[0]!.RegistrationID });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/registrations/{id}:
 *   patch:
 *     tags: [Registrations]
 *     summary: Update a registration
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Updated }
 *       404: { description: Not found }
 *       422: { description: Validation failed }
 */
registrationsRouter.patch('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = registrationWriteSchema.partial().safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid registration data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const sets: string[] = [];
    const params: Record<string, SqlParam> = { id: { type: sql.Int, value: id } };

    for (const [key, value] of Object.entries(parsed.data)) {
      const col = COLUMN_MAP[key];
      if (!col) continue;
      sets.push(`${col} = @${key}`);
      params[key] = { type: paramType(col), value: value ?? null };
    }

    if (sets.length === 0) {
      res.status(422).json({ error: 'validation_failed', message: 'No fields to update' });
      return;
    }

    sets.push('UpdatedAt = SYSUTCDATETIME()');

    const updated = await query<{ RegistrationID: number }>(
      `UPDATE core.Registration SET ${sets.join(', ')}
       OUTPUT INSERTED.RegistrationID
       WHERE RegistrationID = @id`,
      params,
    );

    if (updated.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Registration not found' });
      return;
    }

    res.json({ registrationId: id });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/registrations/{id}:
 *   delete:
 *     tags: [Registrations]
 *     summary: Cancel a registration
 *     description: >
 *       Soft delete — sets IsCancelled so payment and attendance history is
 *       preserved. Registrations are never physically removed.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Cancelled }
 *       404: { description: Not found }
 */
registrationsRouter.delete('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `UPDATE core.Registration
          SET IsCancelled = 1, UpdatedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.RegistrationID
        WHERE RegistrationID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    if (result.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Registration not found' });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
