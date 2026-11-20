import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { queryBoolean } from '../query.js';

export const paymentsRouter = Router();

/**
 * Payments are driven by core.Registration.PaidAmount, not core.Payment.
 *
 * The Access database recorded most money directly on the registration row:
 * 26,607 registrations carry $1.50M with no Payment record at all, while the
 * Payment table holds only $329K. Summing Payment would understate revenue by
 * roughly 84%. The Payment table is therefore treated as supporting detail for
 * the registrations that happen to have one.
 *
 * See docs/features/payments.md.
 */

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  paymentMethodId: z.coerce.number().int().optional(),
  /** all | paid | unpaid | refunded */
  status: z.enum(['all', 'paid', 'unpaid', 'refunded']).default('all'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  includeCancelled: queryBoolean(false),
});

/** Shared WHERE builder so the totals always match the rows. */
function buildWhere(p: z.infer<typeof listQuery>) {
  const where: string[] = [];
  const params: Record<string, SqlParam> = {};

  if (p.q) {
    where.push(
      `(pt.FirstName LIKE @q OR pt.LastName LIKE @q
        OR CONCAT(pt.FirstName, ' ', pt.LastName) LIKE @q
        OR n.WorkshopName LIKE @q OR w.WorkshopCode LIKE @q
        OR CAST(r.ReceiptNumber AS NVARCHAR(20)) LIKE @q)`,
    );
    params.q = { type: sql.NVarChar(260), value: `%${p.q}%` };
  }
  if (p.paymentMethodId !== undefined) {
    where.push('r.PaymentMethodID = @pm');
    params.pm = { type: sql.Int, value: p.paymentMethodId };
  }
  if (p.status === 'paid') where.push('r.PaidAmount > 0');
  if (p.status === 'unpaid') where.push('(r.PaidAmount IS NULL OR r.PaidAmount = 0)');
  if (p.status === 'refunded') where.push('r.PaidAmount < 0');

  if (p.from) {
    // PaidDate is only populated on 6,925 of 41,341 registrations and stops
    // at 2013-09-16, so filtering on it alone would silently hide most
    // payments. Fall back to the registration date, which is present on
    // every row.
    where.push('COALESCE(r.PaidDate, r.RegistrationDate) >= @from');
    params.from = { type: sql.Date, value: p.from };
  }
  if (p.to) {
    where.push('COALESCE(r.PaidDate, r.RegistrationDate) < DATEADD(DAY, 1, @to)');
    params.to = { type: sql.Date, value: p.to };
  }
  if (!p.includeCancelled) where.push('r.IsCancelled = 0');

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * @openapi
 * /api/payments:
 *   get:
 *     tags: [Payments]
 *     summary: List registration payments
 *     description: >
 *       One row per registration, driven by Registration.PaidAmount. Where a
 *       registration has a linked core.Payment record, its receipt number and
 *       tender are shown as supporting detail.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25, maximum: 200 } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: paymentMethodId, schema: { type: integer } }
 *       - { in: query, name: status, schema: { type: string, enum: [all, paid, unpaid, refunded] } }
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *       - { in: query, name: includeCancelled, schema: { type: boolean, default: false } }
 *     responses:
 *       200:
 *         description: Paginated payments with totals for the whole filtered set
 */
paymentsRouter.get('/', requireAuth, async (req, res, next) => {
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

    const p = parsed.data;
    const { whereSql, params } = buildWhere(p);

    const base = `
      FROM core.Registration r
      LEFT JOIN core.Participant pt ON pt.ParticipantID = r.ParticipantID
      LEFT JOIN core.Workshop w    ON w.WorkshopID = r.WorkshopID
      LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      LEFT JOIN ref.PaymentMethod pm ON pm.PaymentMethodID = r.PaymentMethodID
      LEFT JOIN core.Payment pay   ON pay.PaymentID = r.PaymentID
      LEFT JOIN core.Payee py      ON py.PayeeID = COALESCE(r.PayeeID, pay.PayeeID)
      ${whereSql}`;

    // Totals cover the whole filtered set, not just the current page - a
    // paginated total would be misleading on a financial screen.
    const totals = await query<{ n: number; total: number; paid: number; refunded: number }>(
      `SELECT COUNT(*) AS n,
              ISNULL(SUM(r.PaidAmount), 0) AS total,
              ISNULL(SUM(CASE WHEN r.PaidAmount > 0 THEN r.PaidAmount ELSE 0 END), 0) AS paid,
              ISNULL(SUM(CASE WHEN r.PaidAmount < 0 THEN r.PaidAmount ELSE 0 END), 0) AS refunded
       ${base}`,
      params,
    );
    const t = totals.recordset[0]!;

    const rows = await query(
      `SELECT r.RegistrationID, r.PaidAmount, r.PaidDate, r.ReceiptNumber,
              r.CheckNumber, r.CheckTotal, r.IsCancelled, r.IsScholarship,
              pm.PaymentMethod,
              pt.ParticipantID, pt.FirstName, pt.LastName,
              w.WorkshopID, w.WorkshopCode, n.WorkshopName,
              pay.PaymentID, pay.PaymentTotal AS PaymentRecordTotal,
              py.Payee
       ${base}
       ORDER BY r.PaidDate DESC, r.RegistrationID DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        ...params,
        offset: { type: sql.Int, value: (p.page - 1) * p.pageSize },
        limit: { type: sql.Int, value: p.pageSize },
      },
    );

    res.json({
      data: rows.recordset,
      page: p.page,
      pageSize: p.pageSize,
      total: t.n,
      totals: { total: t.total, paid: t.paid, refunded: t.refunded },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/payments/summary:
 *   get:
 *     tags: [Payments]
 *     summary: Revenue by school year and payment method
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Summary totals }
 */
paymentsRouter.get('/summary', requireAuth, async (_req, res, next) => {
  try {
    const byYear = await query(
      `SELECT sy.SchoolYearID, sy.SchoolYear,
              COUNT(r.RegistrationID) AS Registrations,
              ISNULL(SUM(r.PaidAmount), 0) AS Amount
         FROM core.Registration r
         JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
        WHERE r.IsCancelled = 0
        GROUP BY sy.SchoolYearID, sy.SchoolYear
        ORDER BY sy.SchoolYearID DESC`,
    );

    const byMethod = await query(
      `SELECT pm.PaymentMethodID, pm.PaymentMethod,
              COUNT(r.RegistrationID) AS Registrations,
              ISNULL(SUM(r.PaidAmount), 0) AS Amount
         FROM ref.PaymentMethod pm
         LEFT JOIN core.Registration r
                ON r.PaymentMethodID = pm.PaymentMethodID AND r.IsCancelled = 0
        GROUP BY pm.PaymentMethodID, pm.PaymentMethod
        ORDER BY Amount DESC`,
    );

    res.json({ byYear: byYear.recordset, byMethod: byMethod.recordset });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/payments/{registrationId}:
 *   get:
 *     tags: [Payments]
 *     summary: Payment detail for one registration
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: registrationId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Payment detail }
 *       404: { description: Not found }
 */
paymentsRouter.get('/:registrationId', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.registrationId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT r.RegistrationID, r.PaidAmount, r.PaidDate, r.ReceiptNumber,
              r.CheckNumber, r.CheckTotal, r.IsCancelled, r.IsScholarship,
              r.PaymentMethodID, pm.PaymentMethod,
              r.PaymentID, pay.PaymentTotal AS PaymentRecordTotal,
              pay.CheckNumber AS PaymentCheckNumber, pay.ReceiptNumber AS PaymentReceiptNumber,
              py.Payee,
              pt.ParticipantID, pt.FirstName, pt.LastName, pt.Email,
              w.WorkshopID, w.WorkshopCode, n.WorkshopName, w.StartDate,
              sy.SchoolYear
         FROM core.Registration r
         LEFT JOIN ref.PaymentMethod pm ON pm.PaymentMethodID = r.PaymentMethodID
         LEFT JOIN core.Payment pay ON pay.PaymentID = r.PaymentID
         LEFT JOIN core.Payee py ON py.PayeeID = COALESCE(r.PayeeID, pay.PayeeID)
         LEFT JOIN core.Participant pt ON pt.ParticipantID = r.ParticipantID
         LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
         LEFT JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
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

/**
 * @openapi
 * /api/payments/{registrationId}:
 *   patch:
 *     tags: [Payments]
 *     summary: Record or correct a payment on a registration
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: registrationId, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paidAmount: { type: number, nullable: true }
 *               paidDate: { type: string, format: date, nullable: true }
 *               paymentMethodId: { type: integer, nullable: true }
 *               receiptNumber: { type: integer, nullable: true }
 *               checkNumber: { type: integer, nullable: true }
 *               payeeId: { type: integer, nullable: true }
 *     responses:
 *       200: { description: Updated }
 *       404: { description: Not found }
 *       422: { description: Validation failed }
 */
const writeSchema = z.object({
  paidAmount: z.number().nullable().optional(),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  paymentMethodId: z.number().int().nullable().optional(),
  receiptNumber: z.number().int().nullable().optional(),
  checkNumber: z.number().int().nullable().optional(),
  payeeId: z.number().int().nullable().optional(),
});

const COLUMN_MAP: Record<string, string> = {
  paidAmount: 'PaidAmount',
  paidDate: 'PaidDate',
  paymentMethodId: 'PaymentMethodID',
  receiptNumber: 'ReceiptNumber',
  checkNumber: 'CheckNumber',
  payeeId: 'PayeeID',
};

function paramType(column: string) {
  if (column === 'PaidAmount') return sql.Decimal(19, 4);
  if (column === 'PaidDate') return sql.Date;
  if (column.endsWith('ID')) return sql.Int;
  // Receipt and check numbers are INT columns, not strings. Without this they
  // fall through to NVarChar and SQL Server rejects the parameter.
  if (column === 'ReceiptNumber' || column === 'CheckNumber') return sql.Int;
  return sql.NVarChar(255);
}

paymentsRouter.patch(
  '/:registrationId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.registrationId);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const parsed = writeSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid payment data',
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
         OUTPUT INSERTED.RegistrationID WHERE RegistrationID = @id`,
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
  },
);
