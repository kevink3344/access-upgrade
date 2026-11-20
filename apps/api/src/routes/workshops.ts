import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

export const workshopsRouter = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  schoolYear: z.coerce.number().int().optional(),
  category: z.coerce.number().int().optional(),
  status: z.enum(['open', 'closed', 'cancelled', 'all']).default('all'),
  sort: z.enum(['startDate', 'code', 'name', 'registered']).default('startDate'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Writable workshop fields. Deliberately excludes:
 *  - WorkshopID (identity, preserved from Access)
 *  - LegacyWorkshopID (migration artefact)
 *  - derived totals (replaced by core.vw_WorkshopCounts)
 */
const workshopWriteSchema = z.object({
  workshopNameId: z.number().int().positive().nullable().optional(),
  evalTypeId: z.number().int().nullable().optional(),
  componentId: z.number().int().nullable().optional(),
  categoryId: z.number().int().nullable().optional(),
  agencyId: z.number().int().nullable().optional(),
  schoolYearId: z.number().int().nullable().optional(),
  workshopCode: z.string().max(10).nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM').nullable().optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM').nullable().optional(),
  maxEnrollment: z.number().int().min(0).nullable().optional(),
  minEnrollment: z.number().int().min(0).nullable().optional(),
  room: z.number().int().nullable().optional(),
  cost1: z.number().nullable().optional(),
  cost2: z.number().nullable().optional(),
  consultFee: z.number().nullable().optional(),
  creditPossible: z.string().max(50).nullable().optional(),
  sessionCount: z.number().int().nullable().optional(),
  sessionHours: z.number().nullable().optional(),
  sessionCeus: z.number().nullable().optional(),
  isBrochure: z.boolean().optional(),
  isFolder: z.boolean().optional(),
  isLabel: z.boolean().optional(),
  isClosed: z.boolean().optional(),
  isCancelled: z.boolean().optional(),
  isContracted: z.boolean().optional(),
  isStaffDev: z.boolean().optional(),
  isRegistrationOpen: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  specialNotes: z.string().nullable().optional(),
});

const createSchema = workshopWriteSchema;

const SORT_COLUMNS: Record<string, string> = {
  startDate: 'w.StartDate',
  code: 'w.WorkshopCode',
  name: 'n.WorkshopName',
  registered: 'Registered',
};

/**
 * @openapi
 * /api/workshops:
 *   get:
 *     tags: [Workshops]
 *     summary: List workshops
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25, maximum: 200 } }
 *       - { in: query, name: q, schema: { type: string }, description: Search title or code }
 *       - { in: query, name: schoolYear, schema: { type: integer } }
 *       - { in: query, name: category, schema: { type: integer } }
 *       - { in: query, name: status, schema: { type: string, enum: [open, closed, cancelled, all] } }
 *       - { in: query, name: sort, schema: { type: string, enum: [startDate, code, name, registered] } }
 *       - { in: query, name: dir, schema: { type: string, enum: [asc, desc] } }
 *     responses:
 *       200:
 *         description: Paginated workshops
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/WorkshopSummary' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 */
workshopsRouter.get('/', requireAuth, async (req, res, next) => {
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

    const { page, pageSize, q, schoolYear, category, status, sort, dir } = parsed.data;

    const where: string[] = [];
    const params: Record<string, SqlParam> = {};

    if (q) {
      where.push('(n.WorkshopName LIKE @q OR w.WorkshopCode LIKE @q)');
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    if (schoolYear) {
      where.push('w.SchoolYearID = @sy');
      params.sy = { type: sql.Int, value: schoolYear };
    }
    if (category) {
      where.push('w.CategoryID = @cat');
      params.cat = { type: sql.Int, value: category };
    }
    if (status === 'open') where.push('w.IsClosed = 0 AND w.IsCancelled = 0');
    if (status === 'closed') where.push('w.IsClosed = 1 AND w.IsCancelled = 0');
    if (status === 'cancelled') where.push('w.IsCancelled = 1');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderCol = SORT_COLUMNS[sort] ?? 'w.StartDate';
    const orderDir = dir === 'asc' ? 'ASC' : 'DESC';

    // Join order matters: joins must precede WHERE.
    const base = `
      FROM core.Workshop w
      LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      LEFT JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
      LEFT JOIN ref.Category c ON c.CategoryID = w.CategoryID
      ${whereSql}`;

    const countResult = await query<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, params);
    const total = countResult.recordset[0]?.n ?? 0;

    const offset = (page - 1) * pageSize;

    const rows = await query<{
      WorkshopID: number;
      WorkshopCode: string | null;
      WorkshopName: string | null;
      StartDate: Date | null;
      EndDate: Date | null;
      SchoolYear: string | null;
      CategoryCode: string | null;
      Registered: number;
      Capacity: number | null;
      IsClosed: boolean;
      IsCancelled: boolean;
    }>(
      `SELECT w.WorkshopID,
              w.WorkshopCode,
              n.WorkshopName,
              w.StartDate,
              w.EndDate,
              sy.SchoolYear,
              c.CategoryCode,
              (SELECT COUNT(*) FROM core.Registration r
                WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS Registered,
              w.MaxEnrollment AS Capacity,
              w.IsClosed,
              w.IsCancelled
       ${base}
       ORDER BY ${orderCol} ${orderDir}
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        ...params,
        offset: { type: sql.Int, value: offset },
        limit: { type: sql.Int, value: pageSize },
      },
    );

    res.json({
      data: rows.recordset.map((r) => ({
        workshopId: r.WorkshopID,
        workshopCode: r.WorkshopCode,
        workshopName: r.WorkshopName,
        startDate: r.StartDate ? r.StartDate.toISOString().slice(0, 10) : null,
        endDate: r.EndDate ? r.EndDate.toISOString().slice(0, 10) : null,
        schoolYear: r.SchoolYear,
        categoryCode: r.CategoryCode,
        registered: r.Registered,
        capacity: r.Capacity,
        isClosed: r.IsClosed,
        isCancelled: r.IsCancelled,
      })),
      page,
      pageSize,
      total,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/lookup-names:
 *   get:
 *     tags: [Workshops]
 *     summary: Workshop catalog titles for pickers
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Catalog options
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
workshopsRouter.get('/lookup-names', requireAuth, async (_req, res, next) => {
  try {
    const result = await query<{ id: number; label: string }>(
      `SELECT WorkshopNameID AS id, WorkshopName AS label
         FROM core.WorkshopName
        WHERE WorkshopName IS NOT NULL
        ORDER BY WorkshopName`,
    );
    res.json({ data: result.recordset });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}:
 *   get:
 *     tags: [Workshops]
 *     summary: Get a workshop
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: Workshop detail
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WorkshopDetail' }
 *       404: { description: Not found }
 */
workshopsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query<Record<string, unknown>>(
      `SELECT w.*, n.WorkshopName, n.ShortName, sy.SchoolYear, c.CategoryCode,
              a.AgencyName,
              (SELECT COUNT(*) FROM core.Registration r
                WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS Registered
         FROM core.Workshop w
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
         LEFT JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
         LEFT JOIN ref.Category c ON c.CategoryID = w.CategoryID
         LEFT JOIN core.Agency a ON a.AgencyID = w.AgencyID
        WHERE w.WorkshopID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Workshop not found' });
      return;
    }

    res.json(row);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}/sessions:
 *   get:
 *     tags: [Workshops]
 *     summary: Sessions for a workshop
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Sessions }
 */
workshopsRouter.get('/:id/sessions', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT s.WorkshopSessionID, s.SessionDate, s.RegAttend, s.ESchoolAttend, s.StaffID,
              CONCAT(p.FirstName, ' ', p.LastName) AS PresenterName
         FROM core.WorkshopSession s
         LEFT JOIN core.PresenterStaff p ON p.PresenterStaffID = s.StaffID
        WHERE s.WorkshopID = @id
        ORDER BY s.SessionDate`,
      { id: { type: sql.Int, value: id } },
    );

    res.json({ data: result.recordset });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}/registrations:
 *   get:
 *     tags: [Workshops]
 *     summary: Registrations for a workshop
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Registrations }
 */
workshopsRouter.get('/:id/registrations', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT r.RegistrationID, r.ParticipantID, r.PaidAmount, r.RegistrationDate,
              r.IsCancelled, r.Attended, r.Source,
              CONCAT(p.FirstName, ' ', p.LastName) AS ParticipantName,
              p.Email, a.AgencyName
         FROM core.Registration r
         JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
         LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
        WHERE r.WorkshopID = @id
        ORDER BY p.LastName, p.FirstName`,
      { id: { type: sql.Int, value: id } },
    );

    res.json({ data: result.recordset });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Write endpoints                                                    */
/* ------------------------------------------------------------------ */


/** Maps camelCase API names to real column names. */
const COLUMN_MAP: Record<string, string> = {
  workshopNameId: 'WorkshopNameID',
  evalTypeId: 'EvalTypeID',
  componentId: 'ComponentID',
  categoryId: 'CategoryID',
  agencyId: 'AgencyID',
  schoolYearId: 'SchoolYearID',
  workshopCode: 'WorkshopCode',
  startDate: 'StartDate',
  endDate: 'EndDate',
  startTime: 'StartTime',
  endTime: 'EndTime',
  maxEnrollment: 'MaxEnrollment',
  minEnrollment: 'MinEnrollment',
  room: 'Room',
  cost1: 'Cost1',
  cost2: 'Cost2',
  consultFee: 'ConsultFee',
  creditPossible: 'CreditPossible',
  sessionCount: 'SessionCount',
  sessionHours: 'SessionHours',
  sessionCeus: 'SessionCeus',
  isBrochure: 'IsBrochure',
  isFolder: 'IsFolder',
  isLabel: 'IsLabel',
  isClosed: 'IsClosed',
  isCancelled: 'IsCancelled',
  isContracted: 'IsContracted',
  isStaffDev: 'IsStaffDev',
  isRegistrationOpen: 'IsRegistrationOpen',
  notes: 'Notes',
  specialNotes: 'SpecialNotes',
};

/** SQL type per column, so parameters are typed correctly. */
function paramType(column: string) {
  if (column.endsWith('ID')) return sql.Int;
  if (column === 'StartDate' || column === 'EndDate') return sql.Date;
  if (column === 'StartTime' || column === 'EndTime') return sql.VarChar(8);
  if (column === 'Room') return sql.SmallInt;
  if (column === 'MaxEnrollment' || column === 'MinEnrollment' || column === 'SessionCount') return sql.Int;
  if (column === 'SessionHours') return sql.Decimal(18, 2);
  if (column === 'SessionCeus') return sql.Real;
  if (column === 'Cost1' || column === 'Cost2' || column === 'ConsultFee') return sql.Decimal(19, 4);
  if (column === 'Notes' || column === 'SpecialNotes') return sql.NVarChar(sql.MAX);
  if (column === 'CreditPossible') return sql.NVarChar(50);
  if (column === 'WorkshopCode') return sql.NVarChar(10);
  if (column.startsWith('Is')) return sql.Bit;
  return sql.NVarChar(255);
}

/**
 * @openapi
 * /api/workshops:
 *   post:
 *     tags: [Workshops]
 *     summary: Create a workshop
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workshopNameId: { type: integer, nullable: true }
 *               schoolYearId: { type: integer, nullable: true }
 *               categoryId: { type: integer, nullable: true }
 *               workshopCode: { type: string, maxLength: 10 }
 *               startDate: { type: string, format: date }
 *               endDate: { type: string, format: date }
 *               startTime: { type: string, example: "09:00" }
 *               endTime: { type: string, example: "12:00" }
 *               maxEnrollment: { type: integer }
 *               minEnrollment: { type: integer }
 *               room: { type: integer }
 *               cost1: { type: number }
 *               cost2: { type: number }
 *               creditPossible: { type: string }
 *               sessionCount: { type: integer }
 *               sessionHours: { type: number }
 *               sessionCeus: { type: number }
 *               isBrochure: { type: boolean }
 *               isClosed: { type: boolean }
 *               isCancelled: { type: boolean }
 *               notes: { type: string }
 *     responses:
 *       201:
 *         description: Created
 *       422: { description: Validation failed }
 */
workshopsRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid workshop data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const cols: string[] = [];
    const vals: string[] = [];
    const params: Record<string, SqlParam> = {};

    // WorkshopID is not an IDENTITY column — it was created as a plain INT so
    // the legacy Access IDs could be loaded verbatim. New rows therefore need
    // an explicit ID, taken from the current maximum.
    const next = await query<{ NextId: number }>(
      'SELECT ISNULL(MAX(WorkshopID), 0) + 1 AS NextId FROM core.Workshop',
    );
    const nextId = next.recordset[0]!.NextId;

    cols.push('WorkshopID');
    vals.push('@nextId');
    params.nextId = { type: sql.Int, value: nextId };

    for (const [key, value] of Object.entries(parsed.data)) {
      const col = COLUMN_MAP[key];
      if (!col) continue;
      cols.push(col);
      vals.push(`@${key}`);
      params[key] = { type: paramType(col), value: value ?? null };
    }

    if (cols.length === 0) {
      res.status(422).json({ error: 'validation_failed', message: 'No fields supplied' });
      return;
    }

    const created = await query<{ WorkshopID: number }>(
      `INSERT INTO core.Workshop (${cols.join(', ')}, CreatedAt, UpdatedAt)
       OUTPUT INSERTED.WorkshopID
       VALUES (${vals.join(', ')}, SYSUTCDATETIME(), SYSUTCDATETIME())`,
      params,
    );

    res.status(201).json({ workshopId: created.recordset[0]!.WorkshopID });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}:
 *   patch:
 *     tags: [Workshops]
 *     summary: Update a workshop
 *     description: Partial update — send only the fields that changed.
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
workshopsRouter.patch('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = workshopWriteSchema.partial().safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid workshop data',
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

    const updated = await query<{ WorkshopID: number }>(
      `UPDATE core.Workshop SET ${sets.join(', ')} OUTPUT INSERTED.WorkshopID WHERE WorkshopID = @id`,
      params,
    );

    if (updated.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Workshop not found' });
      return;
    }

    res.json({ workshopId: id });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}:
 *   delete:
 *     tags: [Workshops]
 *     summary: Delete a workshop
 *     description: >
 *       Refuses with 409 if the workshop has registrations or sessions, because
 *       deleting it would orphan real history. Cancel the workshop instead.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Not found }
 *       409: { description: Workshop has dependent records }
 */
workshopsRouter.delete('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    // The placeholder workshop must never be deleted — 78 legacy
    // registrations depend on it.
    if (id === 0) {
      res.status(409).json({
        error: 'conflict',
        message: 'The "Legacy workshop" placeholder cannot be deleted',
      });
      return;
    }

    const deps = await query<{ Registrations: number; Sessions: number }>(
      `SELECT
         (SELECT COUNT(*) FROM core.Registration     WHERE WorkshopID = @id) AS Registrations,
         (SELECT COUNT(*) FROM core.WorkshopSession  WHERE WorkshopID = @id) AS Sessions`,
      { id: { type: sql.Int, value: id } },
    );

    const d = deps.recordset[0]!;

    if (d.Registrations > 0 || d.Sessions > 0) {
      res.status(409).json({
        error: 'conflict',
        message:
          `This workshop has ${d.Registrations} registration(s) and ${d.Sessions} session(s). ` +
          'Cancel it instead of deleting, so the history is preserved.',
        details: [
          { path: 'registrations', message: String(d.Registrations) },
          { path: 'sessions', message: String(d.Sessions) },
        ],
      });
      return;
    }

    const deleted = await query(
      `DELETE FROM core.Workshop OUTPUT DELETED.WorkshopID WHERE WorkshopID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    if (deleted.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Workshop not found' });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
