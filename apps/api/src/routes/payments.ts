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
  /** YYYY-MM-DD. Omitted means "the current month"; empty means no bound. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).optional(),
  includeCancelled: queryBoolean(false),
});

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function firstOfMonth(now: Date): string {
  return isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

function lastOfMonth(now: Date): string {
  return isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
}

/**
 * The date window for a list request. The screen opens on the current month
 * rather than all history, so an omitted bound falls back to the month the
 * server is in; an empty one means the caller deliberately cleared it.
 */
function resolveWindow(p: z.infer<typeof listQuery>, now = new Date()) {
  return {
    from: p.from === undefined ? firstOfMonth(now) : p.from || null,
    to: p.to === undefined ? lastOfMonth(now) : p.to || null,
  };
}

/** Shared WHERE builder so the totals always match the rows. */
function buildWhere(p: z.infer<typeof listQuery>, now = new Date()) {
  const where: string[] = [];
  const params: Record<string, SqlParam> = {};
  const { from, to } = resolveWindow(p, now);

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

  // PaidDate is only populated on 6,925 of 41,341 registrations and stops
  // at 2013-09-16, so filtering on it alone would silently hide most
  // payments. Fall back to the registration date, which is present on
  // every row.
  if (from) {
    where.push('COALESCE(r.PaidDate, r.RegistrationDate) >= @from');
    params.from = { type: sql.Date, value: from };
  }
  if (to) {
    where.push('COALESCE(r.PaidDate, r.RegistrationDate) < DATEADD(DAY, 1, @to)');
    params.to = { type: sql.Date, value: to };
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
 *       - { in: query, name: from, schema: { type: string, format: date }, description: Defaults to the first day of the current month; send an empty value for no lower bound }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: Defaults to the last day of the current month; send an empty value for no upper bound }
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
    const now = new Date();
    const { whereSql, params } = buildWhere(p, now);

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
              r.CheckNumber, r.CheckTotal, r.IsCancelled, r.IsScholarship, r.Notes,
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
      // The window actually applied, so the cards can say which period they
      // cover even when the caller left the dates to default.
      window: resolveWindow(p, now),
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

const createSchema = z.object({
  participantId: z.number().int().positive(),
  workshopId: z.number().int().positive().nullable().optional(),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  paidAmount: z.number().finite(),
  paymentMethodId: z.number().int().nullable().optional(),
  receiptNumber: z.number().int().nullable().optional(),
  checkNumber: z.number().int().nullable().optional(),
  notes: z.string().max(255).nullable().optional(),
});

/**
 * @openapi
 * /api/payments:
 *   post:
 *     tags: [Payments]
 *     summary: Record a payment taken by staff
 *     description: >
 *       Money is held on the registration, so a payment for a workshop
 *       creates the registration when the participant has none. Without a
 *       workshop the payment is recorded on its own rather than inventing a
 *       registration with no workshop behind it.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [participantId, paidAmount]
 *             properties:
 *               participantId: { type: integer }
 *               workshopId: { type: integer, nullable: true }
 *               paidDate: { type: string, format: date, nullable: true }
 *               paidAmount: { type: number }
 *               paymentMethodId: { type: integer, nullable: true }
 *               receiptNumber: { type: integer, nullable: true }
 *               checkNumber: { type: integer, nullable: true }
 *               notes: { type: string, nullable: true }
 *     responses:
 *       201: { description: Recorded }
 *       409: { description: That registration already has a payment }
 *       422: { description: Validation failed }
 */
paymentsRouter.post(
  '/',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'),
  async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid payment data',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const d = parsed.data;
      const workshopId = d.workshopId ?? null;

      const participant = await query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM core.Participant WHERE ParticipantID = @id',
        { id: { type: sql.Int, value: d.participantId } },
      );
      if ((participant.recordset[0]?.n ?? 0) === 0) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Participant not found',
          details: [{ path: 'participantId', message: 'No participant with that id' }],
        });
        return;
      }

      if (workshopId !== null) {
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
      }

      const payParams: Record<string, SqlParam> = {
        amount: { type: sql.Decimal(19, 4), value: d.paidAmount },
        paidDate: { type: sql.Date, value: d.paidDate ?? isoDate(new Date()) },
        method: { type: sql.Int, value: d.paymentMethodId ?? null },
        receipt: { type: sql.Int, value: d.receiptNumber ?? null },
        check: { type: sql.Int, value: d.checkNumber ?? null },
        notes: { type: sql.NVarChar(255), value: d.notes ?? null },
      };

      // The money columns, shared by the update and the insert so the two
      // cannot drift apart.
      const PAY_SET = `PaidAmount = @amount, PaidDate = @paidDate, PaymentMethodID = @method,
                       ReceiptNumber = @receipt, CheckNumber = @check, Notes = @notes,
                       UpdatedAt = SYSUTCDATETIME()`;
      const PAY_COLUMNS = 'PaidAmount, PaidDate, PaymentMethodID, ReceiptNumber, CheckNumber, Notes, UpdatedAt';
      const PAY_VALUES = '@amount, @paidDate, @method, @receipt, @check, @notes, SYSUTCDATETIME()';

      let registrationId: number | null = null;

      if (workshopId !== null) {
        const existing = await query<{ RegistrationID: number; PaidAmount: number | null }>(
          `SELECT TOP 1 RegistrationID, PaidAmount FROM core.Registration
            WHERE ParticipantID = @pid AND WorkshopID = @wid AND IsCancelled = 0
            ORDER BY RegistrationID`,
          {
            pid: { type: sql.Int, value: d.participantId },
            wid: { type: sql.Int, value: workshopId },
          },
        );

        const found = existing.recordset[0];

        if (found) {
          // The registration is already there, so this is the late payment
          // for it. Never overwrite money that was already recorded: that
          // would silently replace one payment with another.
          if (found.PaidAmount !== null && Number(found.PaidAmount) !== 0) {
            res.status(409).json({
              error: 'conflict',
              message: 'That registration already has a payment recorded',
            });
            return;
          }

          await query(
            `UPDATE core.Registration SET ${PAY_SET} WHERE RegistrationID = @id`,
            { ...payParams, id: { type: sql.Int, value: found.RegistrationID } },
          );
          registrationId = found.RegistrationID;
        } else {
          const created = await query<{ RegistrationID: number }>(
            // RegistrationID is a legacy plain int, not IDENTITY, so the id is
            // allocated inside the INSERT (see db/migrations/019). The test
            // database has IDENTITY here; production does not, so omitting the
            // id passes in test and fails in production.
            `INSERT INTO core.Registration
                    (RegistrationID, ParticipantID, WorkshopID, RegistrationDate, IsCancelled,
                     IsLate, Attended, EmailConfirmation, Source, ${PAY_COLUMNS})
             OUTPUT INSERTED.RegistrationID
             SELECT ISNULL(MAX(RegistrationID), 0) + 1,
                    @pid, @wid, CAST(SYSUTCDATETIME() AS DATE), 0, 0, 0, 0, 'Manual', ${PAY_VALUES}
               FROM core.Registration WITH (UPDLOCK, HOLDLOCK)`,
            {
              ...payParams,
              pid: { type: sql.Int, value: d.participantId },
              wid: { type: sql.Int, value: workshopId },
            },
          );
          registrationId = created.recordset[0]!.RegistrationID;
        }
      } else {
        // No workshop to enrol the participant in, so the payment gets its
        // own registration row with nothing but the money on it — the same
        // shape the legacy data uses for payments that were never tied to a
        // workshop.
        const created = await query<{ RegistrationID: number }>(
          // Same legacy key as above: allocate RegistrationID in the INSERT.
          `INSERT INTO core.Registration
                  (RegistrationID, ParticipantID, RegistrationDate, IsCancelled, IsLate, Attended,
                   EmailConfirmation, Source, ${PAY_COLUMNS})
           OUTPUT INSERTED.RegistrationID
           SELECT ISNULL(MAX(RegistrationID), 0) + 1,
                  @pid, CAST(SYSUTCDATETIME() AS DATE), 0, 0, 0, 0, 'Manual', ${PAY_VALUES}
             FROM core.Registration WITH (UPDLOCK, HOLDLOCK)`,
          { ...payParams, pid: { type: sql.Int, value: d.participantId } },
        );
        registrationId = created.recordset[0]!.RegistrationID;
      }

      res.status(201).json({ registrationId, participantId: d.participantId });
    } catch (err) {
      next(err);
    }
  },
);

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
              r.CheckNumber, r.CheckTotal, r.IsCancelled, r.IsScholarship, r.Notes,
              r.PaymentMethodID, pm.PaymentMethod,
              r.PaymentID, pay.PaymentTotal AS PaymentRecordTotal,
              pay.CheckNumber AS PaymentCheckNumber, pay.ReceiptNumber AS PaymentReceiptNumber,
              py.Payee,
              pt.ParticipantID, pt.FirstName, pt.LastName, pt.Email,
              w.WorkshopID, w.WorkshopCode, n.WorkshopName, w.StartDate,
              sy.SchoolYear,
              -- Where this payment came from. A School Cash payment is
              -- written by the matcher, which records the vendor row it paid
              -- on ScoRow — so that row is the provenance, and it carries
              -- both the upload and the line to point staff back at.
              sco.ScoImportID, sco.ScoRowID, sco.RowNumber AS ScoRowNumber,
              imp.FileName AS ScoFileName,
              CONVERT(NVARCHAR(30), imp.UploadedAt, 126) AS ScoUploadedAt
         FROM core.Registration r
         LEFT JOIN ref.PaymentMethod pm ON pm.PaymentMethodID = r.PaymentMethodID
         LEFT JOIN core.Payment pay ON pay.PaymentID = r.PaymentID
         LEFT JOIN core.Payee py ON py.PayeeID = COALESCE(r.PayeeID, pay.PayeeID)
         LEFT JOIN core.Participant pt ON pt.ParticipantID = r.ParticipantID
         LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
         LEFT JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
         -- AppliedPaymentID is unique per row in practice; TOP 1 keeps the
         -- join from fanning out if a payment were ever recorded twice.
         OUTER APPLY (
           SELECT TOP 1 s.ScoImportID, s.ScoRowID, s.RowNumber
             FROM core.ScoRow s
            WHERE s.AppliedPaymentID = r.PaymentID
              AND r.PaymentID IS NOT NULL
            ORDER BY s.ScoRowID
         ) sco
         LEFT JOIN core.ScoImport imp ON imp.ScoImportID = sco.ScoImportID
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
