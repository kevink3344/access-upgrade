import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { queryBoolean } from '../query.js';

export const participantsRouter = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  agencyId: z.coerce.number().int().optional(),
  sort: z.enum(['name', 'email', 'agency']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  includeEmpty: queryBoolean().default(false),
});

const SORT: Record<string, string> = {
  name: 'p.LastName, p.FirstName',
  email: 'p.Email',
  agency: 'a.AgencyName',
};

/**
 * A participant row carrying no information at all: no name, no contact
 * details, and nothing linked to it.
 *
 * These are artefacts of the Access import (19 rows as of the ETL). They are
 * hidden from the list by default because they show as "Unnamed" with every
 * column blank, but they are not deleted — `includeEmpty=true` still returns
 * them, and they remain editable by direct id.
 */
const IS_EMPTY = `(
  (p.FirstName IS NULL OR LTRIM(RTRIM(p.FirstName)) = '')
  AND (p.LastName IS NULL OR LTRIM(RTRIM(p.LastName)) = '')
  AND NULLIF(LTRIM(RTRIM(ISNULL(p.Email,  ''))), '') IS NULL
  AND NULLIF(LTRIM(RTRIM(ISNULL(p.Email2, ''))), '') IS NULL
  AND NULLIF(LTRIM(RTRIM(ISNULL(p.Email3, ''))), '') IS NULL
  AND NULLIF(LTRIM(RTRIM(ISNULL(p.HomePhone, ''))), '') IS NULL
  AND NULLIF(LTRIM(RTRIM(ISNULL(p.WorkPhone, ''))), '') IS NULL
  AND NULLIF(LTRIM(RTRIM(ISNULL(p.HomeAddress1, ''))), '') IS NULL
  AND p.AgencyID IS NULL
  AND NOT EXISTS (SELECT 1 FROM core.Registration       r  WHERE r.ParticipantID  = p.ParticipantID)
  AND NOT EXISTS (SELECT 1 FROM core.SessionParticipant sp WHERE sp.ParticipantID = p.ParticipantID)
  AND NOT EXISTS (SELECT 1 FROM core.CertificateIssue   ci WHERE ci.ParticipantID = p.ParticipantID)
  AND NOT EXISTS (SELECT 1 FROM core.CreditSlip         cs
                   WHERE cs.ParticipantID = p.ParticipantID
                      OR cs.UsedParticipantID = p.ParticipantID)
)`;

/**
 * Writable participant fields. Excludes:
 *  - ParticipantID (not IDENTITY; legacy IDs preserved)
 *  - certificate flags (set by the certificate workflow)
 *  - DateOfEntry / UpdatedAt (system managed)
 */
const participantWriteSchema = z.object({
  salutationId: z.number().int().nullable().optional(),
  agencyId: z.number().int().nullable().optional(),
  streetTypeId: z.number().int().nullable().optional(),
  cityId: z.number().int().nullable().optional(),
  stateId: z.number().int().nullable().optional(),
  firstName: z.string().max(30).nullable().optional(),
  lastName: z.string().max(30).nullable().optional(),
  middleName: z.string().max(20).nullable().optional(),
  homePhone: z.string().max(15).nullable().optional(),
  homeFax: z.string().max(15).nullable().optional(),
  workPhone: z.string().max(15).nullable().optional(),
  workPhoneExt: z.string().max(6).nullable().optional(),
  homeAddress1: z.string().max(200).nullable().optional(),
  homeAddress2: z.string().max(50).nullable().optional(),
  homeZip: z.string().max(10).nullable().optional(),
  email: z.string().email('Enter a valid email').max(100).nullable().optional().or(z.literal('')),
  email2: z.string().max(100).nullable().optional(),
  email3: z.string().max(255).nullable().optional(),
  position: z.string().max(255).nullable().optional(),
  gradeLevel: z.string().max(255).nullable().optional(),
  isParentMailingList: z.boolean().optional(),
  isTeacherMailingList: z.boolean().optional(),
  isDirectorMailingList: z.boolean().optional(),
  isStaff: z.boolean().optional(),
  isWcpss: z.boolean().optional(),
});

const createSchema = participantWriteSchema.refine(
  (v) => (v.lastName && v.lastName.trim() !== '') || (v.firstName && v.firstName.trim() !== ''),
  { message: 'A first or last name is required', path: ['lastName'] },
);

const COLUMN_MAP: Record<string, string> = {
  salutationId: 'SalutationID',
  agencyId: 'AgencyID',
  streetTypeId: 'StreetTypeID',
  cityId: 'CityID',
  stateId: 'StateID',
  firstName: 'FirstName',
  lastName: 'LastName',
  middleName: 'MiddleName',
  homePhone: 'HomePhone',
  homeFax: 'HomeFax',
  workPhone: 'WorkPhone',
  workPhoneExt: 'WorkPhoneExt',
  homeAddress1: 'HomeAddress1',
  homeAddress2: 'HomeAddress2',
  homeZip: 'HomeZip',
  email: 'Email',
  email2: 'Email2',
  email3: 'Email3',
  position: 'Position',
  gradeLevel: 'GradeLevel',
  isParentMailingList: 'IsParentMailingList',
  isTeacherMailingList: 'IsTeacherMailingList',
  isDirectorMailingList: 'IsDirectorMailingList',
  isStaff: 'IsStaff',
  isWcpss: 'IsWcpss',
};

function paramType(column: string) {
  if (column.endsWith('ID')) return sql.Int;
  if (column === 'FirstName' || column === 'LastName') return sql.NVarChar(30);
  if (column === 'MiddleName') return sql.NVarChar(20);
  if (column === 'Email') return sql.NVarChar(100);
  if (column === 'Email2') return sql.NVarChar(100);
  if (column === 'Email3') return sql.NVarChar(255);
  if (column === 'Position' || column === 'GradeLevel') return sql.NVarChar(255);
  if (column === 'HomeAddress1') return sql.NVarChar(200);
  if (column === 'HomeAddress2') return sql.NVarChar(50);
  if (column === 'HomeZip') return sql.NVarChar(10);
  if (column === 'WorkPhoneExt') return sql.NVarChar(6);
  if (column.startsWith('Home') || column.startsWith('Work')) return sql.NVarChar(15);
  if (column.startsWith('Is')) return sql.Bit;
  return sql.NVarChar(255);
}

/**
 * @openapi
 * /api/participants:
 *   get:
 *     tags: [Participants]
 *     summary: List participants
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25, maximum: 200 } }
 *       - { in: query, name: q, schema: { type: string }, description: Search name or email }
 *       - { in: query, name: agencyId, schema: { type: integer } }
 *       - { in: query, name: sort, schema: { type: string, enum: [name, email, agency] } }
 *       - { in: query, name: dir, schema: { type: string, enum: [asc, desc] } }
 *       - { in: query, name: includeEmpty, schema: { type: boolean, default: false }, description: Include placeholder rows with no name, contact details or linked records }
 *     responses:
 *       200:
 *         description: Paginated participants
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/ParticipantSummary' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 */
participantsRouter.get('/', requireAuth, async (req, res, next) => {
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

    const { page, pageSize, q, agencyId, sort, dir, includeEmpty } = parsed.data;

    const where: string[] = [];
    const params: Record<string, SqlParam> = {};

    if (!includeEmpty) where.push(`NOT ${IS_EMPTY}`);
    if (q) {
      where.push('(p.FirstName LIKE @q OR p.LastName LIKE @q OR p.Email LIKE @q)');
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    if (agencyId) {
      where.push('p.AgencyID = @agency');
      params.agency = { type: sql.Int, value: agencyId };
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderCol = SORT[sort] ?? SORT.name;
    const orderDir = dir === 'asc' ? 'ASC' : 'DESC';

    const base = `
      FROM core.Participant p
      LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
      ${whereSql}`;

    const count = await query<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, params);
    const total = count.recordset[0]?.n ?? 0;

    const rows = await query<{
      ParticipantID: number;
      FirstName: string | null;
      LastName: string | null;
      Email: string | null;
      AgencyName: string | null;
      HasCeuCertificate: boolean;
      HasChcCertificate: boolean;
      RegistrationCount: number;
    }>(
      `SELECT p.ParticipantID, p.FirstName, p.LastName, p.Email,
              a.AgencyName, p.HasCeuCertificate, p.HasChcCertificate,
              (SELECT COUNT(*) FROM core.Registration r
                WHERE r.ParticipantID = p.ParticipantID) AS RegistrationCount
       ${base}
       ORDER BY ${orderCol} ${orderDir}
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        ...params,
        offset: { type: sql.Int, value: (page - 1) * pageSize },
        limit: { type: sql.Int, value: pageSize },
      },
    );

    res.json({
      data: rows.recordset.map((r) => ({
        participantId: r.ParticipantID,
        firstName: r.FirstName,
        lastName: r.LastName,
        email: r.Email,
        agencyName: r.AgencyName,
        hasCeuCertificate: r.HasCeuCertificate,
        hasChcCertificate: r.HasChcCertificate,
        registrationCount: r.RegistrationCount,
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
 * /api/participants/check-duplicate:
 *   get:
 *     tags: [Participants]
 *     summary: Find possible duplicates
 *     description: >
 *       The migrated data contains 962 duplicate email groups. This endpoint
 *       surfaces likely matches before a new record is created, so the problem
 *       does not keep growing. Matching is case-insensitive on email, and
 *       falls back to exact name when no email is supplied.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: email, schema: { type: string } }
 *       - { in: query, name: firstName, schema: { type: string } }
 *       - { in: query, name: lastName, schema: { type: string } }
 *       - { in: query, name: excludeId, schema: { type: integer }, description: Ignore this participant (when editing) }
 *     responses:
 *       200:
 *         description: Possible matches, most relevant first
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
 *                       participantId: { type: integer }
 *                       displayName: { type: string }
 *                       email: { type: string, nullable: true }
 *                       agencyName: { type: string, nullable: true }
 *                       registrationCount: { type: integer }
 *                       matchReason: { type: string, enum: [email, name] }
 */
participantsRouter.get('/check-duplicate', requireAuth, async (req, res, next) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    const firstName = typeof req.query.firstName === 'string' ? req.query.firstName.trim() : '';
    const lastName = typeof req.query.lastName === 'string' ? req.query.lastName.trim() : '';
    const excludeId = Number(req.query.excludeId);

    if (!email && (!firstName || !lastName)) {
      res.json({ data: [] });
      return;
    }

    const params: Record<string, SqlParam> = {};
    const clauses: string[] = [];

    if (email) {
      clauses.push('LOWER(p.Email) = @email');
      params.email = { type: sql.NVarChar(100), value: email.toLowerCase() };
    }
    if (firstName && lastName) {
      clauses.push('(LOWER(p.FirstName) = @fn AND LOWER(p.LastName) = @ln)');
      params.fn = { type: sql.NVarChar(30), value: firstName.toLowerCase() };
      params.ln = { type: sql.NVarChar(30), value: lastName.toLowerCase() };
    }

    let exclude = '';
    if (Number.isInteger(excludeId) && excludeId > 0) {
      exclude = 'AND p.ParticipantID <> @exclude';
      params.exclude = { type: sql.Int, value: excludeId };
    }

    const result = await query<{
      ParticipantID: number;
      FirstName: string | null;
      LastName: string | null;
      Email: string | null;
      AgencyName: string | null;
      RegistrationCount: number;
      MatchReason: string;
    }>(
      `SELECT TOP 10
              p.ParticipantID, p.FirstName, p.LastName, p.Email, a.AgencyName,
              (SELECT COUNT(*) FROM core.Registration r WHERE r.ParticipantID = p.ParticipantID) AS RegistrationCount,
              CASE WHEN @hasEmail = 1 AND LOWER(p.Email) = @email THEN 'email' ELSE 'name' END AS MatchReason
         FROM core.Participant p
         LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
        WHERE (${clauses.join(' OR ')}) ${exclude}
        ORDER BY MatchReason DESC, p.LastName, p.FirstName`,
      {
        ...params,
        hasEmail: { type: sql.Bit, value: email ? 1 : 0 },
        email: params.email ?? { type: sql.NVarChar(100), value: '' },
      },
    );

    res.json({
      data: result.recordset.map((r) => ({
        participantId: r.ParticipantID,
        displayName: [r.FirstName, r.LastName].filter(Boolean).join(' ') || 'Unnamed',
        email: r.Email,
        agencyName: r.AgencyName,
        registrationCount: r.RegistrationCount,
        matchReason: r.MatchReason,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/participants/{id}:
 *   get:
 *     tags: [Participants]
 *     summary: Get a participant
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Participant detail }
 *       404: { description: Not found }
 */
participantsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT p.*, a.AgencyName
         FROM core.Participant p
         LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
        WHERE p.ParticipantID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Participant not found' });
      return;
    }

    res.json(row);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/participants/{id}/registrations:
 *   get:
 *     tags: [Participants]
 *     summary: Registrations for a participant
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Registrations }
 */
participantsRouter.get('/:id/registrations', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query(
      `SELECT r.RegistrationID, r.WorkshopID, r.PaidAmount, r.RegistrationDate,
              r.IsCancelled, r.Attended, r.Source,
              w.WorkshopCode, n.WorkshopName, w.StartDate
         FROM core.Registration r
         LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
        WHERE r.ParticipantID = @id
        ORDER BY w.StartDate DESC`,
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

/**
 * @openapi
 * /api/participants:
 *   post:
 *     tags: [Participants]
 *     summary: Create a participant
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               email: { type: string, format: email }
 *               agencyId: { type: integer, nullable: true }
 *               position: { type: string }
 *               gradeLevel: { type: string }
 *     responses:
 *       201: { description: Created }
 *       422: { description: Validation failed }
 */
participantsRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid participant data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const data = { ...parsed.data };
    // An empty string is not a valid email — store NULL instead.
    if (data.email === '') data.email = null;

    const cols: string[] = [];
    const vals: string[] = [];
    const params: Record<string, SqlParam> = {};

    for (const [key, value] of Object.entries(data)) {
      const col = COLUMN_MAP[key];
      if (!col) continue;
      cols.push(col);
      vals.push(`@${key}`);
      params[key] = { type: paramType(col), value: value ?? null };
    }

    // ParticipantID is a legacy plain int, NOT IDENTITY. Migration 019 left it
    // that way and moved allocation into the INSERT: the read and the write
    // are one statement, and the locks hold until it commits, so two
    // concurrent creates cannot collide. The test database happens to have
    // IDENTITY on this column, which is why omitting the id passed there and
    // failed in production with "Cannot insert the value NULL".
    cols.unshift('ParticipantID');
    vals.unshift('ISNULL(MAX(ParticipantID), 0) + 1');

    cols.push('DateOfEntry');
    vals.push('SYSUTCDATETIME()');

    const created = await query<{ ParticipantID: number }>(
      `INSERT INTO core.Participant (${cols.join(', ')})
       OUTPUT INSERTED.ParticipantID
       SELECT ${vals.join(', ')}
         FROM core.Participant WITH (UPDLOCK, HOLDLOCK)`,
      params,
    );

    res.status(201).json({ participantId: created.recordset[0]!.ParticipantID });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/participants/{id}:
 *   patch:
 *     tags: [Participants]
 *     summary: Update a participant
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
participantsRouter.patch('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = participantWriteSchema.partial().safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid participant data',
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
      params[key] = { type: paramType(col), value: value === '' ? null : (value ?? null) };
    }

    if (sets.length === 0) {
      res.status(422).json({ error: 'validation_failed', message: 'No fields to update' });
      return;
    }

    sets.push('UpdatedAt = SYSUTCDATETIME()');

    const updated = await query<{ ParticipantID: number }>(
      `UPDATE core.Participant SET ${sets.join(', ')}
       OUTPUT INSERTED.ParticipantID
       WHERE ParticipantID = @id`,
      params,
    );

    if (updated.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Participant not found' });
      return;
    }

    res.json({ participantId: id });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/participants/{id}:
 *   delete:
 *     tags: [Participants]
 *     summary: Delete a participant
 *     description: >
 *       Refuses with 409 if the participant has registrations, credit slips,
 *       or session attendance, because deleting would orphan real history.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Not found }
 *       409: { description: Participant has dependent records }
 */
participantsRouter.delete('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const deps = await query<{ Registrations: number; CreditSlips: number; Attendance: number }>(
      `SELECT
         (SELECT COUNT(*) FROM core.Registration        WHERE ParticipantID = @id) AS Registrations,
         (SELECT COUNT(*) FROM core.CreditSlip          WHERE ParticipantID = @id OR UsedParticipantID = @id) AS CreditSlips,
         (SELECT COUNT(*) FROM core.SessionParticipant  WHERE ParticipantID = @id) AS Attendance`,
      { id: { type: sql.Int, value: id } },
    );

    const d = deps.recordset[0]!;

    if (d.Registrations > 0 || d.CreditSlips > 0 || d.Attendance > 0) {
      res.status(409).json({
        error: 'conflict',
        message:
          `This participant has ${d.Registrations} registration(s), ${d.CreditSlips} credit slip(s) ` +
          `and ${d.Attendance} attendance record(s). They cannot be deleted without losing history.`,
        details: [
          { path: 'registrations', message: String(d.Registrations) },
          { path: 'creditSlips', message: String(d.CreditSlips) },
          { path: 'attendance', message: String(d.Attendance) },
        ],
      });
      return;
    }

    const deleted = await query(
      `DELETE FROM core.Participant OUTPUT DELETED.ParticipantID WHERE ParticipantID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    if (deleted.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Participant not found' });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
