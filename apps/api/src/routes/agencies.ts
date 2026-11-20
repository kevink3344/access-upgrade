import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { queryBoolean } from '../query.js';

export const agenciesRouter = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  includeOutOfBusiness: queryBoolean(false),
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
              c.City, t.TypeName AS AgencyType,
              (SELECT COUNT(*) FROM core.Participant p WHERE p.AgencyID = a.AgencyID) AS ParticipantCount
         FROM core.Agency a
         LEFT JOIN ref.City c ON c.CityID = a.CityID
         LEFT JOIN ref.AgencyType t ON t.AgencyTypeID = a.AgencyTypeID
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

/* ------------------------------------------------------------------ */
/*  Write operations                                                   */
/* ------------------------------------------------------------------ */

/**
 * camelCase request field -> real column. Only these may be written; the
 * legacy IDs (WakeSitesFacilityID, SchoolCode) and timestamps are not
 * exposed because nothing in the UI sets them.
 */
const COLUMN_MAP: Record<string, string> = {
  agencyName: 'AgencyName',
  agencyShortName: 'AgencyShortName',
  agencyTypeId: 'AgencyTypeID',
  facilityTypeId: 'FacilityTypeID',
  countyId: 'CountyID',
  cityId: 'CityID',
  stateId: 'StateID',
  streetTypeId: 'StreetTypeID',
  agencyAddress1: 'AgencyAddress1',
  agencyAddress2: 'AgencyAddress2',
  agencyZip: 'AgencyZip',
  agencyPhone: 'AgencyPhone',
  agencyFax: 'AgencyFax',
  agencyEmail: 'AgencyEmail',
  agencyWebsite: 'AgencyWebsite',
  directorFirstName: 'DirectorFirstName',
  directorLastName: 'DirectorLastName',
  altContactFirstName: 'AltContactFirstName',
  altContactLastName: 'AltContactLastName',
  isOutOfBusiness: 'IsOutOfBusiness',
  isWorkshopSite: 'IsWorkshopSite',
  notes: 'Notes',
};

/** SQL type per column, so parameters are typed correctly. */
function paramType(column: string) {
  if (column.endsWith('ID')) return sql.Int;
  if (column === 'Notes') return sql.NVarChar(sql.MAX);
  if (column === 'AgencyName') return sql.NVarChar(250);
  if (column === 'AgencyShortName' || column === 'AgencyAddress1') return sql.NVarChar(255);
  if (column === 'AgencyAddress2') return sql.NVarChar(50);
  if (column === 'AgencyZip') return sql.NVarChar(10);
  if (column === 'AgencyPhone' || column === 'AgencyFax') return sql.NVarChar(16);
  if (column === 'AgencyEmail') return sql.NVarChar(50);
  if (column === 'AgencyWebsite') return sql.NVarChar(100);
  if (column === 'DirectorFirstName') return sql.NVarChar(50);
  if (column === 'DirectorLastName') return sql.NVarChar(50);
  if (column === 'AltContactFirstName' || column === 'AltContactLastName') return sql.NVarChar(30);
  if (column.startsWith('Is')) return sql.Bit;
  return sql.NVarChar(255);
}

const agencyWriteSchema = z.object({
  agencyName: z.string().max(250).nullable().optional(),
  agencyShortName: z.string().max(255).nullable().optional(),
  agencyTypeId: z.number().int().nullable().optional(),
  facilityTypeId: z.number().int().nullable().optional(),
  countyId: z.number().int().nullable().optional(),
  cityId: z.number().int().nullable().optional(),
  stateId: z.number().int().nullable().optional(),
  streetTypeId: z.number().int().nullable().optional(),
  agencyAddress1: z.string().max(255).nullable().optional(),
  agencyAddress2: z.string().max(50).nullable().optional(),
  agencyZip: z.string().max(10).nullable().optional(),
  agencyPhone: z.string().max(16).nullable().optional(),
  agencyFax: z.string().max(16).nullable().optional(),
  agencyEmail: z.string().max(50).nullable().optional(),
  agencyWebsite: z.string().max(100).nullable().optional(),
  directorFirstName: z.string().max(50).nullable().optional(),
  directorLastName: z.string().max(50).nullable().optional(),
  altContactFirstName: z.string().max(30).nullable().optional(),
  altContactLastName: z.string().max(30).nullable().optional(),
  isOutOfBusiness: z.boolean().optional(),
  isWorkshopSite: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

/**
 * @openapi
 * /api/agencies:
 *   post:
 *     tags: [Agencies]
 *     summary: Create an agency
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       201: { description: Created }
 *       409: { description: An agency with that name already exists }
 *       422: { description: Validation failed }
 */
agenciesRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const parsed = agencyWriteSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid agency data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const name = parsed.data.agencyName?.trim();
    if (!name) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Agency name is required',
        details: [{ path: 'agencyName', message: 'Required' }],
      });
      return;
    }

    // 812 legacy agencies accumulated near-duplicates from free-text entry.
    // Refuse an exact name match rather than adding another.
    const dupe = await query<{ AgencyID: number }>(
      'SELECT TOP 1 AgencyID FROM core.Agency WHERE LOWER(AgencyName) = LOWER(@n)',
      { n: { type: sql.NVarChar(250), value: name } },
    );
    if (dupe.recordset[0]) {
      res.status(409).json({
        error: 'conflict',
        message: 'An agency with that name already exists.',
        details: [{ path: 'agencyName', message: 'Already in use' }],
      });
      return;
    }

    // AgencyID is not an IDENTITY column - the legacy Access IDs were loaded
    // verbatim, so new rows take MAX + 1.
    const next = await query<{ NextId: number }>(
      'SELECT ISNULL(MAX(AgencyID), 0) + 1 AS NextId FROM core.Agency',
    );

    const cols: string[] = ['AgencyID'];
    const vals: string[] = ['@nextId'];
    const params: Record<string, SqlParam> = {
      nextId: { type: sql.Int, value: next.recordset[0]!.NextId },
    };

    for (const [key, value] of Object.entries(parsed.data)) {
      const col = COLUMN_MAP[key];
      if (!col) continue;
      cols.push(col);
      vals.push(`@${key}`);
      params[key] = { type: paramType(col), value: key === 'agencyName' ? name : (value ?? null) };
    }

    const created = await query<{ AgencyID: number }>(
      `INSERT INTO core.Agency (${cols.join(', ')}, CreatedAt, UpdatedAt)
       OUTPUT INSERTED.AgencyID
       VALUES (${vals.join(', ')}, SYSUTCDATETIME(), SYSUTCDATETIME())`,
      params,
    );

    res.status(201).json({ agencyId: created.recordset[0]!.AgencyID });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/agencies/{id}:
 *   patch:
 *     tags: [Agencies]
 *     summary: Update an agency
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
 *       409: { description: Another agency already has that name }
 */
agenciesRouter.patch('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = agencyWriteSchema.partial().safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid agency data',
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
        value: key === 'agencyName' && typeof value === 'string' ? value.trim() : (value ?? null),
      };
    }

    if (sets.length === 0) {
      res.status(422).json({ error: 'validation_failed', message: 'No fields to update' });
      return;
    }

    // Renaming to a name another agency already holds would recreate the
    // duplicate problem this screen is meant to avoid.
    if (parsed.data.agencyName) {
      const clash = await query<{ AgencyID: number }>(
        `SELECT TOP 1 AgencyID FROM core.Agency
          WHERE LOWER(AgencyName) = LOWER(@n) AND AgencyID <> @id`,
        {
          n: { type: sql.NVarChar(250), value: parsed.data.agencyName.trim() },
          id: { type: sql.Int, value: id },
        },
      );
      if (clash.recordset[0]) {
        res.status(409).json({
          error: 'conflict',
          message: 'Another agency already uses that name.',
          details: [{ path: 'agencyName', message: 'Already in use' }],
        });
        return;
      }
    }

    sets.push('UpdatedAt = SYSUTCDATETIME()');

    const updated = await query<{ AgencyID: number }>(
      `UPDATE core.Agency SET ${sets.join(', ')} OUTPUT INSERTED.AgencyID WHERE AgencyID = @id`,
      params,
    );

    if (updated.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Agency not found' });
      return;
    }

    res.json({ agencyId: id });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/agencies/{id}:
 *   delete:
 *     tags: [Agencies]
 *     summary: Delete an agency
 *     description: >
 *       Refused when participants, workshops, or other records reference the
 *       agency. Mark it out of business instead so history is preserved.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Not found }
 *       409: { description: Referenced by other records }
 */
agenciesRouter.delete('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    // Agency 0 is the "Unknown" placeholder that 36 board members and many
    // participants point at. Deleting it would orphan them.
    if (id === 0) {
      res.status(409).json({
        error: 'conflict',
        message: 'The "Unknown" placeholder agency cannot be deleted',
      });
      return;
    }

    const deps = await query<{
      Participants: number;
      Workshops: number;
      Presenters: number;
      BoardMembers: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM core.Participant    WHERE AgencyID = @id) AS Participants,
         (SELECT COUNT(*) FROM core.Workshop       WHERE AgencyID = @id) AS Workshops,
         (SELECT COUNT(*) FROM core.PresenterStaff WHERE AgencyID = @id) AS Presenters,
         (SELECT COUNT(*) FROM core.BoardMember    WHERE AgencyID = @id) AS BoardMembers`,
      { id: { type: sql.Int, value: id } },
    );

    const d = deps.recordset[0]!;
    const total = d.Participants + d.Workshops + d.Presenters + d.BoardMembers;

    if (total > 0) {
      res.status(409).json({
        error: 'conflict',
        message:
          `This agency is referenced by ${d.Participants} participant(s), ` +
          `${d.Workshops} workshop(s), ${d.Presenters} presenter(s) and ` +
          `${d.BoardMembers} board member(s). Mark it out of business instead of deleting.`,
        details: [
          { path: 'participants', message: String(d.Participants) },
          { path: 'workshops', message: String(d.Workshops) },
          { path: 'presenters', message: String(d.Presenters) },
          { path: 'boardMembers', message: String(d.BoardMembers) },
        ],
      });
      return;
    }

    // Mailing address is a child row with no other purpose.
    await query('DELETE FROM core.AgencyMailAddress WHERE AgencyID = @id', {
      id: { type: sql.Int, value: id },
    });

    const removed = await query<{ AgencyID: number }>(
      'DELETE FROM core.Agency OUTPUT DELETED.AgencyID WHERE AgencyID = @id',
      { id: { type: sql.Int, value: id } },
    );

    if (removed.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Agency not found' });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
