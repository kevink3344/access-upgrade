import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { queryBoolean } from '../query.js';

export const presentersRouter = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  includeRetired: queryBoolean(false),
});

/**
 * @openapi
 * /api/presenters:
 *   get:
 *     tags: [Presenters]
 *     summary: List presenters and staff
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25, maximum: 200 } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: includeRetired, schema: { type: boolean, default: false } }
 *     responses:
 *       200:
 *         description: Paginated presenters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/PresenterRow' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 */
presentersRouter.get('/', requireAuth, async (req, res, next) => {
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

    const { page, pageSize, q, includeRetired } = parsed.data;

    const where: string[] = [];
    const params: Record<string, SqlParam> = {};

    if (q) {
      where.push(
        `(p.FirstName LIKE @q OR p.LastName LIKE @q OR p.HomeEmail LIKE @q
          OR CONCAT(p.FirstName, ' ', p.LastName) LIKE @q)`,
      );
      params.q = { type: sql.NVarChar(120), value: `%${q}%` };
    }
    if (!includeRetired) {
      where.push('p.IsRetired = 0');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const count = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM core.PresenterStaff p ${whereSql}`,
      params,
    );
    const total = count.recordset[0]?.n ?? 0;

    const rows = await query(
      `SELECT p.PresenterStaffID, p.FirstName, p.LastName, p.HomeEmail,
              p.WorkPhone, p.CellPhone, p.IsRetired,
              a.AgencyName,
              (SELECT COUNT(*) FROM core.WorkshopPresenter wp
                WHERE wp.PresenterID = p.PresenterStaffID) AS WorkshopCount
         FROM core.PresenterStaff p
         LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
         ${whereSql}
        ORDER BY p.LastName, p.FirstName
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

/**
 * @openapi
 * /api/presenters/{id}:
 *   get:
 *     tags: [Presenters]
 *     summary: Get a presenter
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Presenter detail }
 *       404: { description: Not found }
 */
presentersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT p.*, a.AgencyName, c.City, st.State, s.Salutation
         FROM core.PresenterStaff p
         LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
         LEFT JOIN ref.City c ON c.CityID = p.CityID
         LEFT JOIN ref.State st ON st.StateID = p.StateID
         LEFT JOIN ref.Salutation s ON s.SalutationID = p.SalutationID
        WHERE p.PresenterStaffID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Presenter not found' });
      return;
    }

    res.json(row);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/presenters/{id}/workshops:
 *   get:
 *     tags: [Presenters]
 *     summary: Workshops this presenter has taught
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Workshops }
 */
presentersRouter.get('/:id/workshops', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT w.WorkshopID, w.WorkshopCode, n.WorkshopName, w.StartDate,
              sy.SchoolYear
         FROM core.WorkshopPresenter wp
         JOIN core.Workshop w ON w.WorkshopID = wp.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
         LEFT JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
        WHERE wp.PresenterID = @id
        ORDER BY w.StartDate DESC`,
      { id: { type: sql.Int, value: id } },
    );

    res.json({ data: result.recordset });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Write operations                                                   */
/* ------------------------------------------------------------------ */

const COLUMN_MAP: Record<string, string> = {
  salutationId: 'SalutationID',
  agencyId: 'AgencyID',
  cityId: 'CityID',
  stateId: 'StateID',
  firstName: 'FirstName',
  lastName: 'LastName',
  middleName: 'MiddleName',
  workPhone: 'WorkPhone',
  extension: 'Extension',
  homePhone: 'HomePhone',
  cellPhone: 'CellPhone',
  homeEmail: 'HomeEmail',
  address: 'Address',
  zip: 'Zip',
  isRetired: 'IsRetired',
};

function paramType(column: string) {
  if (column.endsWith('ID')) return sql.Int;
  if (column === 'Extension') return sql.Int;
  if (column === 'FirstName' || column === 'LastName') return sql.NVarChar(30);
  if (column === 'MiddleName') return sql.NVarChar(20);
  if (column === 'WorkPhone' || column === 'CellPhone') return sql.NVarChar(14);
  if (column === 'HomePhone') return sql.NVarChar(15);
  if (column === 'HomeEmail') return sql.NVarChar(50);
  if (column === 'Address') return sql.NVarChar(200);
  if (column === 'Zip') return sql.NVarChar(10);
  if (column.startsWith('Is')) return sql.Bit;
  return sql.NVarChar(255);
}

const presenterWriteSchema = z.object({
  salutationId: z.number().int().nullable().optional(),
  agencyId: z.number().int().nullable().optional(),
  cityId: z.number().int().nullable().optional(),
  stateId: z.number().int().nullable().optional(),
  firstName: z.string().max(30).nullable().optional(),
  lastName: z.string().max(30).nullable().optional(),
  middleName: z.string().max(20).nullable().optional(),
  workPhone: z.string().max(14).nullable().optional(),
  extension: z.number().int().nullable().optional(),
  homePhone: z.string().max(15).nullable().optional(),
  cellPhone: z.string().max(14).nullable().optional(),
  homeEmail: z
    .string()
    .max(50)
    .nullable()
    .optional()
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email'),
  address: z.string().max(200).nullable().optional(),
  zip: z.string().max(10).nullable().optional(),
  isRetired: z.boolean().optional(),
});

/**
 * @openapi
 * /api/presenters:
 *   post:
 *     tags: [Presenters]
 *     summary: Create a presenter
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       201: { description: Created }
 *       422: { description: Validation failed }
 */
presentersRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const parsed = presenterWriteSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid presenter data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const first = parsed.data.firstName?.trim() ?? '';
    const last = parsed.data.lastName?.trim() ?? '';

    if (!first && !last) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'A first or last name is required',
        details: [{ path: 'lastName', message: 'Required' }],
      });
      return;
    }

    // PresenterStaffID is not an IDENTITY column - the legacy Access IDs were
    // loaded verbatim, so new rows take MAX + 1.
    const next = await query<{ NextId: number }>(
      'SELECT ISNULL(MAX(PresenterStaffID), 0) + 1 AS NextId FROM core.PresenterStaff',
    );

    const cols: string[] = ['PresenterStaffID'];
    const vals: string[] = ['@nextId'];
    const params: Record<string, SqlParam> = {
      nextId: { type: sql.Int, value: next.recordset[0]!.NextId },
    };

    for (const [key, value] of Object.entries(parsed.data)) {
      const col = COLUMN_MAP[key];
      if (!col) continue;
      cols.push(col);
      vals.push(`@${key}`);
      params[key] = {
        type: paramType(col),
        value: key === 'firstName' || key === 'lastName'
          ? (typeof value === 'string' ? value.trim() : null)
          : (value ?? null),
      };
    }

    const created = await query<{ PresenterStaffID: number }>(
      `INSERT INTO core.PresenterStaff (${cols.join(', ')}, DateOfEntry)
       OUTPUT INSERTED.PresenterStaffID
       VALUES (${vals.join(', ')}, SYSUTCDATETIME())`,
      params,
    );

    res.status(201).json({ presenterStaffId: created.recordset[0]!.PresenterStaffID });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/presenters/{id}:
 *   patch:
 *     tags: [Presenters]
 *     summary: Update a presenter
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
 */
presentersRouter.patch('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = presenterWriteSchema.partial().safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid presenter data',
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
      params[key] = {
        type: paramType(col),
        value: key === 'firstName' || key === 'lastName'
          ? (typeof value === 'string' ? value.trim() : null)
          : (value ?? null),
      };
    }

    if (sets.length === 0) {
      res.status(422).json({ error: 'validation_failed', message: 'No fields to update' });
      return;
    }

    sets.push('UpdatedAt = SYSUTCDATETIME()');

    const updated = await query<{ PresenterStaffID: number }>(
      `UPDATE core.PresenterStaff SET ${sets.join(', ')}
       OUTPUT INSERTED.PresenterStaffID WHERE PresenterStaffID = @id`,
      params,
    );

    if (updated.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Presenter not found' });
      return;
    }

    res.json({ presenterStaffId: id });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/presenters/{id}:
 *   delete:
 *     tags: [Presenters]
 *     summary: Delete a presenter
 *     description: >
 *       Refused when the presenter is attached to workshops. Mark them
 *       retired instead so the workshop history keeps its presenter.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Not found }
 *       409: { description: Attached to workshops }
 */
presentersRouter.delete('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const deps = await query<{ Workshops: number }>(
      'SELECT COUNT(*) AS Workshops FROM core.WorkshopPresenter WHERE PresenterID = @id',
      { id: { type: sql.Int, value: id } },
    );

    const workshops = deps.recordset[0]!.Workshops;

    if (workshops > 0) {
      res.status(409).json({
        error: 'conflict',
        message:
          `This presenter is attached to ${workshops} workshop(s). ` +
          'Mark them retired instead of deleting, so the history is preserved.',
        details: [{ path: 'workshops', message: String(workshops) }],
      });
      return;
    }

    const removed = await query<{ PresenterStaffID: number }>(
      'DELETE FROM core.PresenterStaff OUTPUT DELETED.PresenterStaffID WHERE PresenterStaffID = @id',
      { id: { type: sql.Int, value: id } },
    );

    if (removed.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Presenter not found' });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
