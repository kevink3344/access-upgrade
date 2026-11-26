import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { answersForTrainingRequest } from '../services/forms.js';

/**
 * Training requests: an agency asking Project Enlightenment to deliver a
 * workshop on-site.
 *
 * The workflow is quote -> schedule -> invoice, but the four child tables are
 * imported history rather than something staff edit here: this screen is the
 * request itself, its contact log, and read-only views of what was quoted,
 * scheduled and paid.
 */
export const trainingRequestsRouter = Router();

const EDIT_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'] as const;

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  status: z.enum(['all', 'active', 'inactive', 'invoiced', 'uninvoiced']).default('all'),
  sort: z.enum(['recent', 'oldest', 'agency']).default('recent'),
});

/**
 * `ParticipantCount` is NVARCHAR in the legacy table — values like "20-30" —
 * so it is written as free text rather than coerced to a number. Narrowing it
 * would lose data nobody has reviewed yet.
 */
const writeSchema = z.object({
  agencyId: z.number().int().positive().nullable().optional(),
  requestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  requestedBy: z.string().max(100).nullable().optional(),
  requestPhone: z.string().max(14).nullable().optional(),
  requestExt: z.number().int().nonnegative().nullable().optional(),
  requestEmail: z
    .string()
    .max(100)
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email')
    .nullable()
    .optional(),
  description: z.string().max(4000).nullable().optional(),
  participantCount: z.string().max(255).nullable().optional(),
  invoiceNum: z.string().max(10).nullable().optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  amtDue: z.number().nullable().optional(),
  isActive: z.boolean().optional(),
});

/** camelCase field -> column, and the SQL type to bind it as. */
const COLUMNS: Record<string, { column: string; type: () => SqlParam['type'] }> = {
  agencyId: { column: 'AgencyID', type: () => sql.Int },
  requestDate: { column: 'RequestDate', type: () => sql.Date },
  requestedBy: { column: 'RequestedBy', type: () => sql.NVarChar(100) },
  requestPhone: { column: 'RequestPhone', type: () => sql.NVarChar(14) },
  requestExt: { column: 'RequestExt', type: () => sql.Int },
  requestEmail: { column: 'RequestEmail', type: () => sql.NVarChar(100) },
  description: { column: 'Description', type: () => sql.NVarChar(sql.MAX) },
  participantCount: { column: 'ParticipantCount', type: () => sql.NVarChar(255) },
  invoiceNum: { column: 'InvoiceNum', type: () => sql.NVarChar(10) },
  invoiceDate: { column: 'InvoiceDate', type: () => sql.Date },
  dueDate: { column: 'DueDate', type: () => sql.Date },
  amtDue: { column: 'AmtDue', type: () => sql.Decimal(19, 4) },
  isActive: { column: 'IsActive', type: () => sql.Bit },
};

const STATUS_FILTERS: Record<string, string> = {
  all: '',
  active: 'AND t.IsActive = 1',
  inactive: 'AND t.IsActive = 0',
  invoiced: 'AND t.InvoiceNum IS NOT NULL',
  uninvoiced: 'AND t.InvoiceNum IS NULL',
};

const SORTS: Record<string, string> = {
  recent: 't.RequestDate DESC',
  oldest: 't.RequestDate ASC',
  agency: 'a.AgencyName ASC',
};

/**
 * The search + status filters shared by the list and the calendar, so the two
 * views always agree on what "matching" means. Every column is aliased to
 * `t` (request) and `a` (agency) in both queries.
 */
function buildFilters(q: string | undefined, status: string): { sql: string; params: Record<string, SqlParam> } {
  const where: string[] = ['1 = 1'];
  const params: Record<string, SqlParam> = {};

  if (q) {
    where.push(
      '(a.AgencyName LIKE @q OR t.RequestedBy LIKE @q OR t.InvoiceNum LIKE @q OR t.RequestEmail LIKE @q OR t.Description LIKE @q)',
    );
    params.q = { type: sql.NVarChar(260), value: `%${q}%` };
  }
  if (STATUS_FILTERS[status]) where.push(STATUS_FILTERS[status].replace(/^AND /, ''));

  return { sql: `WHERE ${where.join(' AND ')}`, params };
}

/**
 * @openapi
 * /api/training-requests:
 *   get:
 *     tags: [Training requests]
 *     summary: List training requests
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25, maximum: 200 } }
 *       - { in: query, name: q, schema: { type: string }, description: Agency, contact or invoice number }
 *       - { in: query, name: status, schema: { type: string, enum: [all, active, inactive, invoiced, uninvoiced] } }
 *       - { in: query, name: sort, schema: { type: string, enum: [recent, oldest, agency] } }
 *     responses:
 *       200:
 *         description: Paginated requests
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/TrainingRequestSummary' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 *                 counts: { type: object }
 */
trainingRequestsRouter.get('/', requireAuth, async (req, res, next) => {
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

    const { page, pageSize, q, status, sort } = parsed.data;

    const { sql: whereSql, params } = buildFilters(q, status);

    const count = await query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM core.TrainingRequest t
         LEFT JOIN core.Agency a ON a.AgencyID = t.AgencyID
         ${whereSql}`,
      params,
    );

    // Counts for the status chips. Deliberately unfiltered by status so the
    // chip totals describe the whole set, matching the search box.
    const counts = await query<{
      all: number;
      active: number;
      invoiced: number;
      uninvoiced: number;
    }>(
      `SELECT COUNT(*) AS [all],
              SUM(CASE WHEN t.IsActive = 1 THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN t.InvoiceNum IS NOT NULL THEN 1 ELSE 0 END) AS invoiced,
              SUM(CASE WHEN t.InvoiceNum IS NULL THEN 1 ELSE 0 END) AS uninvoiced
         FROM core.TrainingRequest t
         LEFT JOIN core.Agency a ON a.AgencyID = t.AgencyID
        WHERE ${q ? '(a.AgencyName LIKE @q OR t.RequestedBy LIKE @q OR t.InvoiceNum LIKE @q OR t.RequestEmail LIKE @q OR t.Description LIKE @q)' : '1 = 1'}`,
      q ? { q: { type: sql.NVarChar(260), value: `%${q}%` } } : {},
    );

    const rows = await query(
      `SELECT t.TrainingRequestID, t.AgencyID, a.AgencyName,
              t.RequestDate, t.RequestedBy, t.RequestEmail, t.RequestPhone,
              t.Description,
              t.ParticipantCount, t.InvoiceNum, t.InvoiceDate, t.DueDate,
              t.AmtDue, t.IsActive,
              (SELECT COUNT(*) FROM core.TrainingRequestQuote qq
                WHERE qq.TrainingRequestID = t.TrainingRequestID) AS QuoteCount,
              (SELECT COUNT(*) FROM core.TrainingRequestScheduled ss
                WHERE ss.TrainingRequestID = t.TrainingRequestID) AS ScheduledCount,
              (SELECT COUNT(*) FROM core.TrainingRequestContact cc
                WHERE cc.TrainingRequestID = t.TrainingRequestID) AS ContactCount
         FROM core.TrainingRequest t
         LEFT JOIN core.Agency a ON a.AgencyID = t.AgencyID
         ${whereSql}
        ORDER BY ${SORTS[sort]}, t.TrainingRequestID DESC
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
      counts: counts.recordset[0] ?? { all: 0, active: 0, invoiced: 0, uninvoiced: 0 },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Calendar range. Bounded on purpose: the UI never needs more than a few
 * months, and an unbounded range would pull the whole table.
 */
const calendarQuery = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    q: z.string().trim().optional(),
    status: z.enum(['all', 'active', 'inactive', 'invoiced', 'uninvoiced']).default('all'),
  })
  .refine((v) => v.from <= v.to, { message: '`from` must not be after `to`', path: ['from'] })
  .refine(
    (v) => (new Date(v.to).getTime() - new Date(v.from).getTime()) / 86_400_000 <= 400,
    { message: 'Range must be 400 days or fewer', path: ['to'] },
  );

/**
 * @openapi
 * /api/training-requests/calendar:
 *   get:
 *     tags: [Training requests]
 *     summary: Training requests in a date range, for the calendar view
 *     description: >
 *       Keyed on `TrainingRequest.RequestDate` — one entry per request, on the
 *       day it was asked for. Requests with no RequestDate cannot be placed on
 *       a calendar and are reported in `undated` rather than silently dropped.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: from, required: true, schema: { type: string, format: date } }
 *       - { in: query, name: to, required: true, schema: { type: string, format: date } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [all, active, inactive, invoiced, uninvoiced] } }
 *     responses:
 *       200:
 *         description: Calendar entries plus the count of undated requests
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/TrainingRequestCalendarEntry' } }
 *                 undated: { type: integer, description: Matching requests with no RequestDate }
 *       422: { description: Invalid range }
 */
trainingRequestsRouter.get('/calendar', requireAuth, async (req, res, next) => {
  try {
    const parsed = calendarQuery.safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid query parameters',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { from, to, q, status } = parsed.data;
    const { sql: whereSql, params } = buildFilters(q, status);

    const rows = await query<{
      TrainingRequestID: number;
      AgencyName: string | null;
      RequestedBy: string | null;
      RequestDate: Date;
      ParticipantCount: string | null;
      InvoiceNum: string | null;
      IsActive: boolean;
      QuoteCount: number;
      ScheduledCount: number;
    }>(
      `SELECT t.TrainingRequestID, a.AgencyName, t.RequestedBy, t.RequestDate,
              t.ParticipantCount, t.InvoiceNum, t.IsActive,
              (SELECT COUNT(*) FROM core.TrainingRequestQuote qq
                WHERE qq.TrainingRequestID = t.TrainingRequestID) AS QuoteCount,
              (SELECT COUNT(*) FROM core.TrainingRequestScheduled ss
                WHERE ss.TrainingRequestID = t.TrainingRequestID) AS ScheduledCount
         FROM core.TrainingRequest t
         LEFT JOIN core.Agency a ON a.AgencyID = t.AgencyID
         ${whereSql}
           AND t.RequestDate >= @from AND t.RequestDate <= @to
        ORDER BY t.RequestDate, a.AgencyName`,
      {
        ...params,
        from: { type: sql.Date, value: from },
        to: { type: sql.Date, value: to },
      },
    );

    // Same filters, but counting what the calendar cannot show.
    const undated = await query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM core.TrainingRequest t
         LEFT JOIN core.Agency a ON a.AgencyID = t.AgencyID
        ${whereSql}
           AND t.RequestDate IS NULL`,
      params,
    );

    res.json({
      data: rows.recordset.map((r) => ({
        trainingRequestId: r.TrainingRequestID,
        agencyName: r.AgencyName,
        requestedBy: r.RequestedBy,
        date: r.RequestDate.toISOString().slice(0, 10),
        participantCount: r.ParticipantCount,
        invoiceNum: r.InvoiceNum,
        isActive: r.IsActive,
        quoteCount: r.QuoteCount,
        scheduledCount: r.ScheduledCount,
      })),
      undated: undated.recordset[0]?.n ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/training-requests/{id}:
 *   get:
 *     tags: [Training requests]
 *     summary: Get a training request with its history
 *     description: >
 *       Returns the request plus its quotes, contact log, scheduled workshops
 *       and payments. The child rows are imported history and are read-only
 *       here.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Request detail }
 *       404: { description: Not found }
 */
trainingRequestsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const head = await query(
      `SELECT t.*, a.AgencyName, a.AgencyShortName, a.AgencyPhone
         FROM core.TrainingRequest t
         LEFT JOIN core.Agency a ON a.AgencyID = t.AgencyID
        WHERE t.TrainingRequestID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = head.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Training request not found' });
      return;
    }

    const [quotes, contacts, scheduled, payments] = await Promise.all([      query(
        `SELECT q.TrainingRequestQuoteID, q.WorkshopTypeID, e.WorkshopType,
                q.TopicRequested, q.Location, q.NumStudents, q.NumSessions,
                q.DatesRequested, q.TimesRequested, q.Duration, q.SpecialEquip, q.RequestAmt
           FROM core.TrainingRequestQuote q
           LEFT JOIN ref.EvalType e ON e.EvalTypeID = q.WorkshopTypeID
          WHERE q.TrainingRequestID = @id
          ORDER BY q.TrainingRequestQuoteID`,
        { id: { type: sql.Int, value: id } },
      ),
      query(
        `SELECT TrainingRequestContactID, ContactDate, Note
           FROM core.TrainingRequestContact
          WHERE TrainingRequestID = @id
          ORDER BY ContactDate DESC, TrainingRequestContactID DESC`,
        { id: { type: sql.Int, value: id } },
      ),
      query(
        `SELECT s.WorkshopID, s.ScheduledOn, w.WorkshopCode, w.StartDate,
                n.WorkshopName
           FROM core.TrainingRequestScheduled s
           LEFT JOIN core.Workshop w ON w.WorkshopID = s.WorkshopID
           LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
          WHERE s.TrainingRequestID = @id
          ORDER BY s.ScheduledOn`,
        { id: { type: sql.Int, value: id } },
      ),
      query(
        `SELECT p.PaymentID, p.PaymentTotal AS Amount, p.PaidDate AS PaymentDate, pm.PaymentMethod
           FROM core.TrainingRequestPayment trp
           JOIN core.Payment p ON p.PaymentID = trp.PaymentID
           LEFT JOIN ref.PaymentMethod pm ON pm.PaymentMethodID = p.PaymentMethodID
          WHERE trp.TrainingRequestID = @id
          ORDER BY p.PaidDate`,
        { id: { type: sql.Int, value: id } },
      ),
    ]);

    res.json({
      ...row,
      quotes: quotes.recordset,
      contacts: contacts.recordset,
      scheduled: scheduled.recordset,
      payments: payments.recordset,
      /** The submitted form's answers, grouped by page. Empty for older requests. */
      formAnswers: await answersForTrainingRequest(id),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/training-requests:
 *   post:
 *     tags: [Training requests]
 *     summary: Create a training request
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Created }
 *       422: { description: Validation failed }
 */
trainingRequestsRouter.post('/', requireAuth, requireRole(...EDIT_ROLES), async (req, res, next) => {
  try {
    const parsed = writeSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid training request',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const cols: string[] = [];
    const vals: string[] = [];
    const params: Record<string, SqlParam> = {};

    for (const [key, value] of Object.entries(parsed.data)) {
      const def = COLUMNS[key];
      if (!def) continue;
      cols.push(def.column);
      vals.push(`@${key}`);
      params[key] = { type: def.type(), value: value ?? null };
    }

    // TrainingRequestID is not IDENTITY — the legacy key was preserved by the
    // ETL. The id is allocated in the same statement as the insert, so two
    // concurrent creates cannot both read the same maximum.
    const created = await query<{ TrainingRequestID: number }>(
      `INSERT INTO core.TrainingRequest (TrainingRequestID, ${cols.join(', ')})
       OUTPUT INSERTED.TrainingRequestID
       SELECT ISNULL(MAX(TrainingRequestID), 0) + 1, ${vals.join(', ')}
         FROM core.TrainingRequest WITH (UPDLOCK, HOLDLOCK)`,
      params,
    );

    res.status(201).json({ trainingRequestId: created.recordset[0]!.TrainingRequestID });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/training-requests/{id}:
 *   patch:
 *     tags: [Training requests]
 *     summary: Update a training request
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Updated }
 *       404: { description: Not found }
 */
trainingRequestsRouter.patch(
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
          message: 'Invalid training request',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const sets: string[] = [];
      const params: Record<string, SqlParam> = { id: { type: sql.Int, value: id } };

      for (const [key, value] of Object.entries(parsed.data)) {
        const def = COLUMNS[key];
        if (!def) continue;
        sets.push(`${def.column} = @${key}`);
        params[key] = { type: def.type(), value: value ?? null };
      }

      if (sets.length === 0) {
        res.status(422).json({ error: 'validation_failed', message: 'No fields supplied' });
        return;
      }

      const r = await query(
        `UPDATE core.TrainingRequest SET ${sets.join(', ')} WHERE TrainingRequestID = @id`,
        params,
      );

      if ((r.rowsAffected[0] ?? 0) === 0) {
        res.status(404).json({ error: 'not_found', message: 'Training request not found' });
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
 * /api/training-requests/{id}:
 *   delete:
 *     tags: [Training requests]
 *     summary: Delete a training request
 *     description: >
 *       For removing duplicates and mistakes. Refused when the request has
 *       quotes, scheduled workshops, payments or a contact log, because
 *       deleting it would take that history with it. Only a request still
 *       carrying nothing but its own details can be removed.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Not found }
 *       409: { description: Has history that would be lost }
 */
trainingRequestsRouter.delete(
  '/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const exists = await query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM core.TrainingRequest WHERE TrainingRequestID = @id',
        { id: { type: sql.Int, value: id } },
      );
      if ((exists.recordset[0]?.n ?? 0) === 0) {
        res.status(404).json({ error: 'not_found', message: 'Training request not found' });
        return;
      }

      // The child tables are imported history. A request that has any is part
      // of the record, not a duplicate, so it is not deletable here.
      const deps = await query<{
        Quotes: number;
        Scheduled: number;
        Payments: number;
        Contacts: number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM core.TrainingRequestQuote     WHERE TrainingRequestID = @id) AS Quotes,
           (SELECT COUNT(*) FROM core.TrainingRequestScheduled WHERE TrainingRequestID = @id) AS Scheduled,
           (SELECT COUNT(*) FROM core.TrainingRequestPayment   WHERE TrainingRequestID = @id) AS Payments,
           (SELECT COUNT(*) FROM core.TrainingRequestContact   WHERE TrainingRequestID = @id) AS Contacts`,
        { id: { type: sql.Int, value: id } },
      );

      const d = deps.recordset[0]!;
      if (d.Quotes > 0 || d.Scheduled > 0 || d.Payments > 0 || d.Contacts > 0) {
        res.status(409).json({
          error: 'conflict',
          message:
            `This request has ${d.Quotes} quote(s), ${d.Scheduled} scheduled workshop(s), ` +
            `${d.Payments} payment(s) and ${d.Contacts} contact log entr(ies). ` +
            'Close it instead of deleting it, so that history is kept.',
          details: [
            { path: 'quotes', message: String(d.Quotes) },
            { path: 'scheduled', message: String(d.Scheduled) },
            { path: 'payments', message: String(d.Payments) },
            { path: 'contacts', message: String(d.Contacts) },
          ],
        });
        return;
      }

      // Form answers belong to the request itself, so they go with it. Done
      // first because the foreign key would otherwise block the delete.
      await query('DELETE FROM core.FormAnswer WHERE TrainingRequestID = @id', {
        id: { type: sql.Int, value: id },
      });
      await query('DELETE FROM core.TrainingRequest WHERE TrainingRequestID = @id', {
        id: { type: sql.Int, value: id },
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/training-requests/{id}/contacts:
 *   post:
 *     tags: [Training requests]
 *     summary: Log a contact against a request
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       201: { description: Created }
 */
trainingRequestsRouter.post(
  '/:id/contacts',
  requireAuth,
  requireRole(...EDIT_ROLES),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const parsed = z
        .object({
          contactDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
          note: z.string().max(2000).nullable().optional(),
        })
        .safeParse(req.body);

      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'A contact date is required',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const exists = await query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM core.TrainingRequest WHERE TrainingRequestID = @id',
        { id: { type: sql.Int, value: id } },
      );
      if ((exists.recordset[0]?.n ?? 0) === 0) {
        res.status(404).json({ error: 'not_found', message: 'Training request not found' });
        return;
      }

      const created = await query<{ id: number }>(
        `INSERT INTO core.TrainingRequestContact
                (TrainingRequestContactID, TrainingRequestID, ContactDate, Note)
         OUTPUT INSERTED.TrainingRequestContactID AS id
         SELECT ISNULL(MAX(TrainingRequestContactID), 0) + 1, @id, @date, @note
           FROM core.TrainingRequestContact WITH (UPDLOCK, HOLDLOCK)`,
        {
          id: { type: sql.Int, value: id },
          date: { type: sql.Date, value: parsed.data.contactDate },
          note: { type: sql.NVarChar(sql.MAX), value: parsed.data.note ?? null },
        },
      );

      res.status(201).json({ contactId: created.recordset[0]!.id });
    } catch (err) {
      next(err);
    }
  },
);
