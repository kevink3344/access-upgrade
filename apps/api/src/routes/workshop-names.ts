import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { queryBoolean } from '../query.js';

export const workshopNamesRouter = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  includeUnused: queryBoolean(true),
  sort: z.enum(['newest', 'title']).default('newest'),
});

/**
 * @openapi
 * /api/workshop-names:
 *   get:
 *     tags: [Workshop catalog]
 *     summary: List catalog entries
 *     description: >
 *       Reusable workshop definitions. Each is the template a scheduled
 *       workshop points at, so a title is written once and reused across
 *       school years.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25, maximum: 200 } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: includeUnused, schema: { type: boolean, default: true } }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [newest, title], default: newest }
 *         description: >
 *           `newest` orders by WorkshopNameID descending. The catalog has no
 *           created-date column, but the ID is assigned sequentially on insert
 *           and the highest IDs are the most recently added titles, so it is a
 *           faithful stand-in for creation order.
 *     responses:
 *       200:
 *         description: Paginated catalog
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/WorkshopNameRow' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 */
workshopNamesRouter.get('/', requireAuth, async (req, res, next) => {
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

    const { page, pageSize, q, includeUnused, sort } = parsed.data;

    const where: string[] = [];
    const params: Record<string, SqlParam> = {};

    if (q) {
      where.push('(n.WorkshopName LIKE @q OR n.ShortName LIKE @q)');
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    if (!includeUnused) {
      where.push('EXISTS (SELECT 1 FROM core.Workshop w WHERE w.WorkshopNameID = n.WorkshopNameID)');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql =
      sort === 'title'
        ? 'ORDER BY n.WorkshopName'
        : 'ORDER BY n.WorkshopNameID DESC';

    const count = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM core.WorkshopName n ${whereSql}`,
      params,
    );
    const total = count.recordset[0]?.n ?? 0;

    const rows = await query(
      `SELECT n.WorkshopNameID, n.WorkshopName, n.ShortName, n.ECourseNum,
              n.IsLiteracy, a.Ages,
              CASE WHEN n.Description IS NULL OR LEN(n.Description) = 0 THEN 0 ELSE 1 END AS HasDescription,
              (SELECT COUNT(*) FROM core.Workshop w WHERE w.WorkshopNameID = n.WorkshopNameID) AS WorkshopCount
         FROM core.WorkshopName n
         LEFT JOIN ref.Age a ON a.AgesID = n.AgesID
         ${whereSql}
        ${orderSql}
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
 * /api/workshop-names/{id}:
 *   get:
 *     tags: [Workshop catalog]
 *     summary: Get a catalog entry
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Catalog entry }
 *       404: { description: Not found }
 */
workshopNamesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT n.*, a.Ages
         FROM core.WorkshopName n
         LEFT JOIN ref.Age a ON a.AgesID = n.AgesID
        WHERE n.WorkshopNameID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Catalog entry not found' });
      return;
    }

    res.json(row);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshop-names/{id}/workshops:
 *   get:
 *     tags: [Workshop catalog]
 *     summary: Scheduled workshops using this catalog entry
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Workshops }
 */
workshopNamesRouter.get('/:id/workshops', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT w.WorkshopID, w.WorkshopCode, w.StartDate, sy.SchoolYear
         FROM core.Workshop w
         LEFT JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
        WHERE w.WorkshopNameID = @id
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
  agesId: 'AgesID',
  workshopName: 'WorkshopName',
  shortName: 'ShortName',
  eCourseNum: 'ECourseNum',
  wlCourse: 'WLCourse',
  prerequisites: 'Prerequisites',
  description: 'Description',
  topicNums: 'TopicNums',
  isLiteracy: 'IsLiteracy',
};

function paramType(column: string) {
  if (column.endsWith('ID')) return sql.Int;
  if (column === 'ECourseNum' || column === 'WLCourse') return sql.Int;
  if (column === 'WorkshopName') return sql.NVarChar(255);
  if (column === 'ShortName') return sql.NVarChar(100);
  if (column === 'Prerequisites') return sql.NVarChar(255);
  if (column === 'TopicNums') return sql.NVarChar(15);
  if (column === 'Description') return sql.NVarChar(sql.MAX);
  if (column.startsWith('Is')) return sql.Bit;
  return sql.NVarChar(255);
}

const writeSchema = z.object({
  agesId: z.number().int().nullable().optional(),
  workshopName: z.string().max(255).nullable().optional(),
  shortName: z.string().max(100).nullable().optional(),
  eCourseNum: z.number().int().nullable().optional(),
  wlCourse: z.number().int().nullable().optional(),
  prerequisites: z.string().max(255).nullable().optional(),
  description: z.string().nullable().optional(),
  topicNums: z.string().max(15).nullable().optional(),
  isLiteracy: z.boolean().optional(),
});

/**
 * @openapi
 * /api/workshop-names:
 *   post:
 *     tags: [Workshop catalog]
 *     summary: Create a catalog entry
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       201: { description: Created }
 *       409: { description: A catalog entry with that title already exists }
 *       422: { description: Validation failed }
 */
workshopNamesRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const parsed = writeSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid catalog data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const title = parsed.data.workshopName?.trim();
    if (!title) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'A workshop title is required',
        details: [{ path: 'workshopName', message: 'Required' }],
      });
      return;
    }

    // 7 legacy titles are already duplicated. Refuse to add an eighth.
    const dupe = await query<{ WorkshopNameID: number }>(
      'SELECT TOP 1 WorkshopNameID FROM core.WorkshopName WHERE LOWER(WorkshopName) = LOWER(@t)',
      { t: { type: sql.NVarChar(255), value: title } },
    );
    if (dupe.recordset[0]) {
      res.status(409).json({
        error: 'conflict',
        message: 'A catalog entry with that title already exists.',
        details: [{ path: 'workshopName', message: 'Already in use' }],
      });
      return;
    }

    // WorkshopNameID is not an IDENTITY column - the legacy Access IDs were
    // loaded verbatim, so new rows take MAX + 1.
    const next = await query<{ NextId: number }>(
      'SELECT ISNULL(MAX(WorkshopNameID), 0) + 1 AS NextId FROM core.WorkshopName',
    );

    const cols: string[] = ['WorkshopNameID'];
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
        value: key === 'workshopName' ? title : (value ?? null),
      };
    }

    const created = await query<{ WorkshopNameID: number }>(
      `INSERT INTO core.WorkshopName (${cols.join(', ')})
       OUTPUT INSERTED.WorkshopNameID
       VALUES (${vals.join(', ')})`,
      params,
    );

    res.status(201).json({ workshopNameId: created.recordset[0]!.WorkshopNameID });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshop-names/{id}:
 *   patch:
 *     tags: [Workshop catalog]
 *     summary: Update a catalog entry
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
 *       409: { description: Another entry already has that title }
 */
workshopNamesRouter.patch('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = writeSchema.partial().safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid catalog data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    if (parsed.data.workshopName) {
      const clash = await query<{ WorkshopNameID: number }>(
        `SELECT TOP 1 WorkshopNameID FROM core.WorkshopName
          WHERE LOWER(WorkshopName) = LOWER(@t) AND WorkshopNameID <> @id`,
        {
          t: { type: sql.NVarChar(255), value: parsed.data.workshopName.trim() },
          id: { type: sql.Int, value: id },
        },
      );
      if (clash.recordset[0]) {
        res.status(409).json({
          error: 'conflict',
          message: 'Another catalog entry already uses that title.',
          details: [{ path: 'workshopName', message: 'Already in use' }],
        });
        return;
      }
    }

    const sets: string[] = [];
    const params: Record<string, SqlParam> = { id: { type: sql.Int, value: id } };

    for (const [key, value] of Object.entries(parsed.data)) {
      const col = COLUMN_MAP[key];
      if (!col) continue;
      sets.push(`${col} = @${key}`);
      params[key] = {
        type: paramType(col),
        value: key === 'workshopName' && typeof value === 'string' ? value.trim() : (value ?? null),
      };
    }

    if (sets.length === 0) {
      res.status(422).json({ error: 'validation_failed', message: 'No fields to update' });
      return;
    }

    const updated = await query<{ WorkshopNameID: number }>(
      `UPDATE core.WorkshopName SET ${sets.join(', ')}
       OUTPUT INSERTED.WorkshopNameID WHERE WorkshopNameID = @id`,
      params,
    );

    if (updated.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Catalog entry not found' });
      return;
    }

    res.json({ workshopNameId: id });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshop-names/{id}:
 *   delete:
 *     tags: [Workshop catalog]
 *     summary: Delete a catalog entry
 *     description: >
 *       Refused when scheduled workshops reference the entry, since they
 *       would lose their title.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Not found }
 *       409: { description: Referenced by workshops }
 */
workshopNamesRouter.delete('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    // Entry 0 is the "Legacy workshop" placeholder that 78 legacy
    // registrations depend on.
    if (id === 0) {
      res.status(409).json({
        error: 'conflict',
        message: 'The "Legacy workshop" placeholder cannot be deleted',
      });
      return;
    }

    const deps = await query<{ Workshops: number }>(
      'SELECT COUNT(*) AS Workshops FROM core.Workshop WHERE WorkshopNameID = @id',
      { id: { type: sql.Int, value: id } },
    );

    const workshops = deps.recordset[0]!.Workshops;

    if (workshops > 0) {
      res.status(409).json({
        error: 'conflict',
        message:
          `This catalog entry is used by ${workshops} scheduled workshop(s). ` +
          'Delete those first, or keep the entry for their history.',
        details: [{ path: 'workshops', message: String(workshops) }],
      });
      return;
    }

    const removed = await query<{ WorkshopNameID: number }>(
      'DELETE FROM core.WorkshopName OUTPUT DELETED.WorkshopNameID WHERE WorkshopNameID = @id',
      { id: { type: sql.Int, value: id } },
    );

    if (removed.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Catalog entry not found' });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
