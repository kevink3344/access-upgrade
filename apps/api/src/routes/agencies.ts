import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth } from '../auth/middleware.js';

export const agenciesRouter = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  includeOutOfBusiness: z.coerce.boolean().default(false),
});

/**
 * @openapi
 * /api/agencies:
 *   get:
 *     tags: [Agencies]
 *     summary: List agencies
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25, maximum: 200 } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: includeOutOfBusiness, schema: { type: boolean, default: false } }
 *     responses:
 *       200:
 *         description: Paginated agencies
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/AgencySummary' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 */
agenciesRouter.get('/', requireAuth, async (req, res, next) => {
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

    const { page, pageSize, q, includeOutOfBusiness } = parsed.data;

    const where: string[] = [];
    const params: Record<string, SqlParam> = {};

    if (q) {
      where.push('(a.AgencyName LIKE @q OR a.AgencyShortName LIKE @q)');
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    if (!includeOutOfBusiness) {
      where.push('a.IsOutOfBusiness = 0');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const count = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM core.Agency a ${whereSql}`,
      params,
    );
    const total = count.recordset[0]?.n ?? 0;

    const rows = await query(
      `SELECT a.AgencyID, a.AgencyName, a.AgencyShortName, a.AgencyPhone,
              a.AgencyZip, a.IsOutOfBusiness, a.IsWorkshopSite,
              c.City,
              (SELECT COUNT(*) FROM core.Participant p WHERE p.AgencyID = a.AgencyID) AS ParticipantCount
         FROM core.Agency a
         LEFT JOIN ref.City c ON c.CityID = a.CityID
         ${whereSql}
        ORDER BY a.AgencyName
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
 * /api/agencies/{id}:
 *   get:
 *     tags: [Agencies]
 *     summary: Get an agency
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Agency detail }
 *       404: { description: Not found }
 */
agenciesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT a.*, c.City, st.State, ct.County
         FROM core.Agency a
         LEFT JOIN ref.City c ON c.CityID = a.CityID
         LEFT JOIN ref.State st ON st.StateID = a.StateID
         LEFT JOIN ref.County ct ON ct.CountyID = a.CountyID
        WHERE a.AgencyID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Agency not found' });
      return;
    }

    res.json(row);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/agencies/{id}/board-members:
 *   get:
 *     tags: [Agencies]
 *     summary: Board members for an agency
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Board members }
 */
agenciesRouter.get('/:id/board-members', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT BoardID, BoardFirstName, BoardLastName, BoardTitle,
              BoardAddress1, BoardZip, BoardPhone, BoardEmail
         FROM core.BoardMember
        WHERE AgencyID = @id
        ORDER BY BoardLastName, BoardFirstName`,
      { id: { type: sql.Int, value: id } },
    );

    res.json({ data: result.recordset });
  } catch (err) {
    next(err);
  }
});
