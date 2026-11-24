import { Router } from 'express';
import { z } from 'zod';
import { getPool, query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { checkWorkshopCapacity } from '../services/notifications.js';
import {
  MAX_BULK_SESSIONS,
  planBulkSessions,
  sessionCapacity,
  validateSession,
} from '../services/sessions.js';

export const workshopsRouter = Router();

/** Writable session fields. Shared by POST (required date) and PATCH (partial). */
const sessionWriteSchema = z.object({
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm').nullable().optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm').nullable().optional(),
  maxEnrollment: z.number().int().nonnegative().nullable().optional(),
  minEnrollment: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(400).nullable().optional(),
});

/**
 * A session's date must fall inside the workshop's own range.
 *
 * A workshop with no dates cannot constrain anything, so this returns null
 * rather than blocking — legacy workshops often have one date and not the
 * other.
 */
async function checkSessionDateInWorkshop(
  workshopId: number,
  sessionDate: string,
): Promise<string | null> {
  const r = await query<{ StartDate: Date | null; EndDate: Date | null }>(
    `SELECT StartDate, EndDate FROM core.Workshop WHERE WorkshopID = @id`,
    { id: { type: sql.Int, value: workshopId } },
  );

  const w = r.recordset[0];
  if (!w) return 'Workshop not found';

  const day = sessionDate;
  if (w.StartDate && day < w.StartDate.toISOString().slice(0, 10)) {
    return `Session date cannot be before the workshop starts (${w.StartDate.toISOString().slice(0, 10)})`;
  }
  if (w.EndDate && day > w.EndDate.toISOString().slice(0, 10)) {
    return `Session date cannot be after the workshop ends (${w.EndDate.toISOString().slice(0, 10)})`;
  }
  return null;
}

/**
 * A session on a single-day workshop should sit inside the workshop's own
 * time window.
 *
 * This is a warning, not a rejection: a workshop's times are often just the
 * first session's, and staff may legitimately add an afternoon session to a
 * workshop whose time field was never widened. Returning the message lets
 * the UI explain rather than silently accepting a session that looks wrong.
 */
async function sessionTimeWarning(
  workshopId: number,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): Promise<string | null> {
  if (!startTime && !endTime) return null;

  const r = await query<{
    StartDate: Date | null;
    EndDate: Date | null;
    StartTime: string | null;
    EndTime: string | null;
  }>(
    `SELECT StartDate, EndDate,
            CONVERT(NVARCHAR(5), StartTime, 108) AS StartTime,
            CONVERT(NVARCHAR(5), EndTime, 108)   AS EndTime
       FROM core.Workshop WHERE WorkshopID = @id`,
    { id: { type: sql.Int, value: workshopId } },
  );

  const w = r.recordset[0];
  if (!w || !w.StartTime || !w.EndTime) return null;

  // Only meaningful for a workshop that runs on one day; a multi-day series
  // has no single window to compare against.
  const singleDay =
    w.StartDate && w.EndDate && w.StartDate.toISOString().slice(0, 10) === w.EndDate.toISOString().slice(0, 10);
  if (!singleDay) return null;

  const outsideStart = startTime ? startTime < w.StartTime : false;
  const outsideEnd = endTime ? endTime > w.EndTime : false;
  if (!outsideStart && !outsideEnd) return null;

  return `This session runs outside the workshop's own time (${w.StartTime}–${w.EndTime}). Update the workshop's times, or confirm the session is correct.`;
}

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  schoolYear: z.coerce.number().int().optional(),
  category: z.coerce.number().int().optional(),
  status: z.enum(['open', 'closed', 'cancelled', 'all']).default('all'),
  sort: z.enum(['upcoming', 'startDate', 'code', 'name', 'registered']).default('upcoming'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

/**
 * Calendar range. Bounded on purpose: an unbounded range would let a single
 * request pull 2,599 workshops, and the UI never needs more than a few months.
 */
const calendarQuery = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    q: z.string().trim().optional(),
    schoolYear: z.coerce.number().int().optional(),
    status: z.enum(['open', 'closed', 'cancelled', 'all']).default('all'),
  })
  .refine((v) => v.from <= v.to, { message: '`from` must not be after `to`', path: ['from'] })
  .refine(
    (v) => (new Date(v.to).getTime() - new Date(v.from).getTime()) / 86_400_000 <= 400,
    { message: 'Range must be 400 days or fewer', path: ['to'] },
  );

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
 * /api/workshops/calendar:
 *   get:
 *     tags: [Workshops]
 *     summary: Workshops in a date range, for the calendar view
 *     description: >
 *       Keyed on `Workshop.StartDate` — one entry per workshop, on the day it
 *       starts. Multi-session workshops appear once, not once per session.
 *       Workshops with no StartDate cannot be placed on a calendar and are
 *       reported in `undated` rather than silently dropped.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: from, required: true, schema: { type: string, format: date } }
 *       - { in: query, name: to, required: true, schema: { type: string, format: date } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: schoolYear, schema: { type: integer } }
 *       - { in: query, name: status, schema: { type: string, enum: [open, closed, cancelled, all] } }
 *     responses:
 *       200:
 *         description: Calendar entries plus the count of undated workshops
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/WorkshopCalendarEntry' } }
 *                 undated: { type: integer, description: Matching workshops with no StartDate }
 *       422: { description: Invalid range }
 */
workshopsRouter.get('/calendar', requireAuth, async (req, res, next) => {
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

    const { from, to, q, schoolYear, status } = parsed.data;

    const filters: string[] = [];
    const params: Record<string, SqlParam> = {
      from: { type: sql.Date, value: from },
      to: { type: sql.Date, value: to },
    };

    if (q) {
      filters.push('(n.WorkshopName LIKE @q OR w.WorkshopCode LIKE @q)');
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    if (schoolYear) {
      filters.push('w.SchoolYearID = @sy');
      params.sy = { type: sql.Int, value: schoolYear };
    }
    if (status === 'open') filters.push('w.IsClosed = 0 AND w.IsCancelled = 0');
    if (status === 'closed') filters.push('w.IsClosed = 1 AND w.IsCancelled = 0');
    if (status === 'cancelled') filters.push('w.IsCancelled = 1');

    const filterSql = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const base = `
      FROM core.Workshop w
      LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      WHERE w.StartDate IS NOT NULL ${filterSql}`;

    const rows = await query<{
      WorkshopID: number;
      WorkshopCode: string | null;
      WorkshopName: string | null;
      StartDate: Date;
      EndDate: Date | null;
      Registered: number;
      Capacity: number | null;
      IsClosed: boolean;
      IsCancelled: boolean;
    }>(
      `SELECT w.WorkshopID, w.WorkshopCode, n.WorkshopName, w.StartDate, w.EndDate,
              (SELECT COUNT(*) FROM core.Registration r
                WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS Registered,
              w.MaxEnrollment AS Capacity,
              w.IsClosed, w.IsCancelled
       ${base}
         AND w.StartDate >= @from AND w.StartDate <= @to
       ORDER BY w.StartDate, n.WorkshopName`,
      params,
    );

    // Same filters, but counting what the calendar cannot show.
    const undated = await query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM core.Workshop w
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
        WHERE w.StartDate IS NULL ${filterSql}`,
      params,
    );

    res.json({
      data: rows.recordset.map((r) => ({
        workshopId: r.WorkshopID,
        workshopCode: r.WorkshopCode,
        workshopName: r.WorkshopName,
        date: r.StartDate.toISOString().slice(0, 10),
        endDate: r.EndDate ? r.EndDate.toISOString().slice(0, 10) : null,
        registered: r.Registered,
        capacity: r.Capacity,
        isClosed: r.IsClosed,
        isCancelled: r.IsCancelled,
      })),
      undated: undated.recordset[0]?.n ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

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
 *       - { in: query, name: sort, schema: { type: string, enum: [upcoming, startDate, code, name, registered], default: upcoming }, description: 'upcoming puts the soonest workshops first, then past ones newest-first' }
 *       - { in: query, name: dir, schema: { type: string, enum: [asc, desc], default: asc } }
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

    /**
     * "Upcoming" is not a plain direction. The table holds 2,534 past workshops
     * against 44 upcoming ones, so ASC would open on 2001 and DESC on the
     * furthest-future date — neither shows what staff mean by "next".
     *
     * This orders in two buckets: upcoming first (soonest to latest), then past
     * (most recent to oldest), with undated rows last. The CASE is the bucket
     * key; the inner ordering flips per bucket so both read naturally.
     */
    const orderBy =
      sort === 'upcoming'
        ? `CASE
             WHEN w.StartDate IS NULL THEN 2
             WHEN w.StartDate >= CAST(SYSUTCDATETIME() AS date) THEN 0
             ELSE 1
           END ASC,
           CASE WHEN w.StartDate >= CAST(SYSUTCDATETIME() AS date)
                THEN w.StartDate END ASC,
           CASE WHEN w.StartDate < CAST(SYSUTCDATETIME() AS date)
                THEN w.StartDate END DESC,
           n.WorkshopName ASC`
        : `${orderCol} ${orderDir}`;

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
       ORDER BY ${orderBy}
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
 * /api/workshops/{id}/registrants:
 *   get:
 *     tags: [Workshops]
 *     summary: Registrants for a workshop
 *     description: >
 *       The roster shown on the Registrants tab. Counts are computed from the
 *       same predicate as the rows, so the headline totals always match the
 *       list. Defaults to active (non-cancelled) registrations.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: query, name: status, schema: { type: string, enum: [active, cancelled, all], default: active } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 50 } }
 *     responses:
 *       200:
 *         description: Registrant roster with reconciled counts
 *       404: { description: Workshop not found }
 */
workshopsRouter.get('/:id/registrants', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = z
      .object({
        status: z.enum(['active', 'cancelled', 'all']).default('active'),
        q: z.string().trim().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query);

    if (!parsed.success) {
      res.status(400).json({
        error: 'bad_request',
        message: 'Invalid query parameters',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { status, q, page, pageSize } = parsed.data;

    const exists = await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM core.Workshop WHERE WorkshopID = @id',
      { id: { type: sql.Int, value: id } },
    );
    if ((exists.recordset[0]?.n ?? 0) === 0) {
      res.status(404).json({ error: 'not_found', message: 'Workshop not found' });
      return;
    }

    const where = ['r.WorkshopID = @wid'];
    const params: Record<string, SqlParam> = { wid: { type: sql.Int, value: id } };

    if (status === 'active') where.push('r.IsCancelled = 0');
    if (status === 'cancelled') where.push('r.IsCancelled = 1');
    if (q) {
      where.push('(p.FirstName LIKE @q OR p.LastName LIKE @q OR p.Email LIKE @q)');
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const from = `
      FROM core.Registration r
      JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
      LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID`;

    // Headline counts use the unfiltered workshop totals so the chips stay
    // stable while the user types in the search box.
    const counts = await query<{ Active: number; Cancelled: number; Attended: number }>(
      `SELECT
         SUM(CASE WHEN r.IsCancelled = 0 THEN 1 ELSE 0 END) AS Active,
         SUM(CASE WHEN r.IsCancelled = 1 THEN 1 ELSE 0 END) AS Cancelled,
         SUM(CASE WHEN r.Attended = 1 THEN 1 ELSE 0 END) AS Attended
       FROM core.Registration r
       WHERE r.WorkshopID = @wid`,
      { wid: { type: sql.Int, value: id } },
    );

    const total = await query<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${whereSql}`, params);

    const rows = await query(
      `SELECT r.RegistrationID, r.ParticipantID,
              CONCAT(p.FirstName, ' ', p.LastName) AS ParticipantName,
              p.Email, a.AgencyName,
              r.RegistrationDate, r.PaidAmount, r.IsCancelled, r.Attended, r.Source
       ${from} ${whereSql}
       ORDER BY p.LastName, p.FirstName
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        ...params,
        offset: { type: sql.Int, value: (page - 1) * pageSize },
        limit: { type: sql.Int, value: pageSize },
      },
    );

    const c = counts.recordset[0];
    res.json({
      data: rows.recordset,
      page,
      pageSize,
      total: total.recordset[0]?.n ?? 0,
      counts: {
        active: c?.Active ?? 0,
        cancelled: c?.Cancelled ?? 0,
        attended: c?.Attended ?? 0,
        all: (c?.Active ?? 0) + (c?.Cancelled ?? 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}/notification-settings:
 *   get:
 *     tags: [Workshops]
 *     summary: Capacity notification settings for a workshop
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Settings plus current fill }
 */
workshopsRouter.get('/:id/notification-settings', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const r = await query<{
      WorkshopID: number;
      MaxEnrollment: number | null;
      NotifyPercentFull: number | null;
      NotifyFiredAt: Date | null;
      Registered: number;
    }>(
      `SELECT w.WorkshopID, w.MaxEnrollment, w.NotifyPercentFull, w.NotifyFiredAt,
              (SELECT COUNT(*) FROM core.Registration r
                WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS Registered
         FROM core.Workshop w
        WHERE w.WorkshopID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = r.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Workshop not found' });
      return;
    }

    const capacity = row.MaxEnrollment ?? null;
    res.json({
      workshopId: row.WorkshopID,
      capacity,
      registered: row.Registered,
      percentFull: capacity && capacity > 0 ? Math.round((row.Registered / capacity) * 100) : null,
      notifyPercentFull: row.NotifyPercentFull,
      lastNotifiedAt: row.NotifyFiredAt ? row.NotifyFiredAt.toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}/notification-settings:
 *   patch:
 *     tags: [Workshops]
 *     summary: Set the capacity notification threshold
 *     description: >
 *       `notifyPercentFull` is 1-100, or null to turn the alert off for this
 *       workshop. Changing the threshold clears the fired flag so the new
 *       threshold can alert immediately if it is already crossed.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated }
 */
workshopsRouter.patch(
  '/:id/notification-settings',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const parsed = z
        .object({ notifyPercentFull: z.number().int().min(1).max(100).nullable() })
        .safeParse(req.body);

      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Threshold must be between 1 and 100, or null to turn it off',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }

      const updated = await query<{ WorkshopID: number }>(
        `UPDATE core.Workshop
            SET NotifyPercentFull = @pct,
                -- A new threshold should be evaluated afresh.
                NotifyFiredAt = NULL
          OUTPUT INSERTED.WorkshopID
          WHERE WorkshopID = @id`,
        {
          pct: { type: sql.Int, value: parsed.data.notifyPercentFull },
          id: { type: sql.Int, value: id },
        },
      );

      if (updated.recordset.length === 0) {
        res.status(404).json({ error: 'not_found', message: 'Workshop not found' });
        return;
      }

      // If the new threshold is already crossed, alert now rather than
      // waiting for the next registration.
      if (parsed.data.notifyPercentFull !== null) {
        await checkWorkshopCapacity(id);
      }

      res.json({ workshopId: id, notifyPercentFull: parsed.data.notifyPercentFull });
    } catch (err) {
      next(err);
    }
  },
);

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
                WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS Registered,
              (SELECT COUNT(*) FROM core.Registration r
                WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 1) AS CancelledCount,
              (SELECT COUNT(*) FROM core.Registration r
                WHERE r.WorkshopID = w.WorkshopID) AS RegistrationCount,
              (SELECT COUNT(*) FROM core.Registration r
                WHERE r.WorkshopID = w.WorkshopID AND r.Attended = 1) AS AttendedCount
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

    // Capacity is resolved here rather than in the UI so the fallback rule
    // lives in one place. WorkshopRegistered is the workshop's own count,
    // repeated per row — sessions are descriptive, so there is no per-session
    // roster to report.
    const result = await query<{
      WorkshopSessionID: number;
      SessionDate: Date | null;
      StartTime: string | null;
      EndTime: string | null;
      MaxEnrollment: number | null;
      MinEnrollment: number | null;
      Notes: string | null;
      RegAttend: number | null;
      ESchoolAttend: number | null;
      WorkshopMax: number | null;
      WorkshopRegistered: number;
    }>(
      `SELECT s.WorkshopSessionID, s.SessionDate,
              CONVERT(NVARCHAR(5), s.StartTime, 108) AS StartTime,
              CONVERT(NVARCHAR(5), s.EndTime, 108)   AS EndTime,
              s.MaxEnrollment, s.MinEnrollment, s.Notes,
              s.RegAttend, s.ESchoolAttend,
              w.MaxEnrollment AS WorkshopMax,
              ISNULL(c.WorkshopRegistered, 0) AS WorkshopRegistered
         FROM core.WorkshopSession s
         LEFT JOIN core.Workshop w ON w.WorkshopID = s.WorkshopID
         -- Counted inline rather than through core.vw_WorkshopSessionCounts:
         -- the application login cannot CREATE VIEW in production, so the
         -- view is absent there and the LEFT JOIN would silently report 0.
         OUTER APPLY (
             SELECT COUNT(*) AS WorkshopRegistered
               FROM core.Registration r
              WHERE r.WorkshopID = s.WorkshopID AND r.IsCancelled = 0
         ) c
        WHERE s.WorkshopID = @id
        ORDER BY s.SessionDate, s.StartTime`,
      { id: { type: sql.Int, value: id } },
    );

    const data = result.recordset.map((r) => {
      const effective = sessionCapacity(r.MaxEnrollment, r.WorkshopMax);
      return {
        WorkshopSessionID: r.WorkshopSessionID,
        SessionDate: r.SessionDate ? r.SessionDate.toISOString().slice(0, 10) : null,
        StartTime: r.StartTime,
        EndTime: r.EndTime,
        MaxEnrollment: r.MaxEnrollment,
        MinEnrollment: r.MinEnrollment,
        Notes: r.Notes,
        EffectiveCapacity: effective,
        CapacityInherited: r.MaxEnrollment === null && effective !== null,
        WorkshopRegistered: r.WorkshopRegistered,
        RegAttend: r.RegAttend,
        ESchoolAttend: r.ESchoolAttend,
      };
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}/presenters:
 *   get:
 *     tags: [Workshops]
 *     summary: Presenters assigned to a workshop
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Presenters }
 */
workshopsRouter.get('/:id/presenters', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query<{
      WorkshopPresenterID: number;
      PresenterStaffID: number;
      FirstName: string | null;
      LastName: string | null;
      AgencyName: string | null;
      IsRetired: boolean;
    }>(
      `SELECT wp.WorkshopPresenterID, p.PresenterStaffID, p.FirstName, p.LastName,
              a.AgencyName, p.IsRetired
         FROM core.WorkshopPresenter wp
         JOIN core.PresenterStaff p ON p.PresenterStaffID = wp.PresenterID
         LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
        WHERE wp.WorkshopID = @id
        ORDER BY p.LastName, p.FirstName`,
      { id: { type: sql.Int, value: id } },
    );

    res.json({
      data: result.recordset.map((r) => ({
        workshopPresenterId: r.WorkshopPresenterID,
        presenterStaffId: r.PresenterStaffID,
        name: [r.FirstName, r.LastName].filter(Boolean).join(' ') || 'Unnamed presenter',
        agencyName: r.AgencyName,
        isRetired: r.IsRetired,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}/presenters:
 *   post:
 *     tags: [Workshops]
 *     summary: Assign a presenter to a workshop
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [presenterStaffId]
 *             properties:
 *               presenterStaffId: { type: integer }
 *     responses:
 *       201: { description: Created }
 *       409: { description: Already assigned }
 */
workshopsRouter.post(
  '/:id/presenters',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const parsed = z
        .object({ presenterStaffId: z.number().int().positive() })
        .safeParse(req.body);

      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'A presenter is required',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const dup = await query(
        `SELECT 1 AS x FROM core.WorkshopPresenter
          WHERE WorkshopID = @w AND PresenterID = @p`,
        {
          w: { type: sql.Int, value: id },
          p: { type: sql.Int, value: parsed.data.presenterStaffId },
        },
      );
      if (dup.recordset.length > 0) {
        res.status(409).json({
          error: 'conflict',
          message: 'That presenter is already assigned to this workshop.',
        });
        return;
      }

      // WorkshopPresenterID is not IDENTITY (legacy key preserved by the ETL).
      const created = await query<{ id: number }>(
        `INSERT INTO core.WorkshopPresenter (WorkshopPresenterID, PresenterID, WorkshopID)
         OUTPUT INSERTED.WorkshopPresenterID AS id
         VALUES ((SELECT ISNULL(MAX(WorkshopPresenterID), 0) + 1 FROM core.WorkshopPresenter), @p, @w)`,
        {
          w: { type: sql.Int, value: id },
          p: { type: sql.Int, value: parsed.data.presenterStaffId },
        },
      );

      res.status(201).json({ workshopPresenterId: created.recordset[0]!.id });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/workshops/{id}/presenters/{presenterRowId}:
 *   delete:
 *     tags: [Workshops]
 *     summary: Unassign a presenter from a workshop
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: presenterRowId, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Removed }
 */
workshopsRouter.delete(
  '/:id/presenters/:presenterRowId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const rowId = Number(req.params.presenterRowId);
      if (!Number.isInteger(id) || !Number.isInteger(rowId)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const r = await query(
        `DELETE FROM core.WorkshopPresenter
          WHERE WorkshopPresenterID = @row AND WorkshopID = @w`,
        {
          row: { type: sql.Int, value: rowId },
          w: { type: sql.Int, value: id },
        },
      );

      if ((r.rowsAffected[0] ?? 0) === 0) {
        res.status(404).json({ error: 'not_found', message: 'Presenter not found on this workshop' });
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
 * /api/workshops/{id}/sessions:
 *   post:
 *     tags: [Workshops]
 *     summary: Add a session to a workshop
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionDate: { type: string, format: date }
 *               staffId: { type: integer, nullable: true }
 *     responses:
 *       201: { description: Created }
 */
workshopsRouter.post(
  '/:id/sessions',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const parsed = sessionWriteSchema.safeParse(req.body);

      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'A valid session date is required',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const problem = validateSession(parsed.data);
      if (problem) {
        res.status(422).json({
          error: 'validation_failed',
          message: problem.message,
          details: [problem],
        });
        return;
      }

      const rangeProblem = await checkSessionDateInWorkshop(id, parsed.data.sessionDate);
      if (rangeProblem) {
        res.status(422).json({
          error: 'validation_failed',
          message: rangeProblem,
          details: [{ path: 'sessionDate', message: rangeProblem }],
        });
        return;
      }

      // WorkshopSessionID is not IDENTITY (legacy key preserved by the ETL).
      // StaffID is deliberately not written: a workshop almost always has the
      // same presenter for every session, and that is recorded on the
      // workshop's Presenters tab. The column stays for legacy rows.
      const created = await query<{ id: number }>(
        `INSERT INTO core.WorkshopSession
                (WorkshopSessionID, WorkshopID, SessionDate,
                 StartTime, EndTime, MaxEnrollment, MinEnrollment, Notes)
         OUTPUT INSERTED.WorkshopSessionID AS id
         VALUES ((SELECT ISNULL(MAX(WorkshopSessionID), 0) + 1 FROM core.WorkshopSession),
                 @w, @date, @start, @end, @max, @min, @notes)`,
        {
          w: { type: sql.Int, value: id },
          date: { type: sql.Date, value: parsed.data.sessionDate },
          start: { type: sql.VarChar(8), value: parsed.data.startTime ?? null },
          end: { type: sql.VarChar(8), value: parsed.data.endTime ?? null },
          max: { type: sql.Int, value: parsed.data.maxEnrollment ?? null },
          min: { type: sql.Int, value: parsed.data.minEnrollment ?? null },
          notes: { type: sql.NVarChar(400), value: parsed.data.notes ?? null },
        },
      );

      const warning = await sessionTimeWarning(id, parsed.data.startTime, parsed.data.endTime);

      res.status(201).json({ workshopSessionId: created.recordset[0]!.id, warning });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/workshops/{id}/sessions/bulk:
 *   post:
 *     tags: [Workshops]
 *     summary: Add several back-to-back sessions in one action
 *     description: >
 *       Creates `count` sessions starting at `startTime`, each
 *       `durationMinutes` long. Each row is a normal, independent session —
 *       this is a pre-fill, not a template. `count` is capped at 12.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       201: { description: Created }
 *       422: { description: Validation failed }
 */
workshopsRouter.post(
  '/:id/sessions/bulk',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const parsed = z
        .object({
          sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
          startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm'),
          count: z.number().int().min(1).max(MAX_BULK_SESSIONS),
          durationMinutes: z.number().int().min(5).max(600),
          maxEnrollment: z.number().int().nonnegative().nullable().optional(),
        })
        .safeParse(req.body);

      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid bulk session request',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const { sessionDate, startTime, count, durationMinutes } = parsed.data;

      const rangeProblem = await checkSessionDateInWorkshop(id, sessionDate);
      if (rangeProblem) {
        res.status(422).json({
          error: 'validation_failed',
          message: rangeProblem,
          details: [{ path: 'sessionDate', message: rangeProblem }],
        });
        return;
      }

      const plan = planBulkSessions(startTime, count, durationMinutes);
      if (plan.length === 0) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Start time must be HH:mm',
          details: [{ path: 'startTime', message: 'Start time must be HH:mm' }],
        });
        return;
      }

      // One transaction so a failure part-way leaves nothing behind. The
      // ids are allocated from the current maximum, then incremented.
      const pool = await getPool();
      const tx = pool.transaction();
      await tx.begin();

      try {
        const maxRow = await tx
          .request()
          .query<{ NextId: number }>(
            'SELECT ISNULL(MAX(WorkshopSessionID), 0) + 1 AS NextId FROM core.WorkshopSession',
          );
        let nextId = maxRow.recordset[0]!.NextId;

        const created: Array<{ workshopSessionId: number; startTime: string; endTime: string }> = [];

        for (const slot of plan) {
          const r = await tx
            .request()
            .input('id', sql.Int, nextId)
            .input('w', sql.Int, id)
            .input('date', sql.Date, sessionDate)
            .input('start', sql.VarChar(8), slot.startTime)
            .input('end', sql.VarChar(8), slot.endTime)
            .input('max', sql.Int, parsed.data.maxEnrollment ?? null)
            .query<{ id: number }>(
              `INSERT INTO core.WorkshopSession
                      (WorkshopSessionID, WorkshopID, SessionDate,
                       StartTime, EndTime, MaxEnrollment)
               OUTPUT INSERTED.WorkshopSessionID AS id
               VALUES (@id, @w, @date, @start, @end, @max)`,
            );

          created.push({
            workshopSessionId: r.recordset[0]!.id,
            startTime: slot.startTime,
            endTime: slot.endTime,
          });
          nextId += 1;
        }

        await tx.commit();
        const warning = await sessionTimeWarning(id, plan[0]!.startTime, plan[plan.length - 1]!.endTime);
        res.status(201).json({ created, warning });
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/workshops/{id}/sessions/{sessionId}:
 *   patch:
 *     tags: [Workshops]
 *     summary: Update a session's date or presenter
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: sessionId, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Updated }
 */
workshopsRouter.patch(
  '/:id/sessions/:sessionId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const sessionId = Number(req.params.sessionId);
      const parsed = sessionWriteSchema.partial().safeParse(req.body);

      if (!Number.isInteger(id) || !Number.isInteger(sessionId)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid session',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      // Cross-field rules need the merged state, not just the fields sent —
      // patching only EndTime must still be checked against the stored
      // StartTime.
      const current = await query<{
        SessionDate: Date | null;
        StartTime: string | null;
        EndTime: string | null;
        MinEnrollment: number | null;
        MaxEnrollment: number | null;
      }>(
        `SELECT SessionDate,
                CONVERT(NVARCHAR(5), StartTime, 108) AS StartTime,
                CONVERT(NVARCHAR(5), EndTime, 108)   AS EndTime,
                MinEnrollment, MaxEnrollment
           FROM core.WorkshopSession
          WHERE WorkshopSessionID = @sid AND WorkshopID = @w`,
        {
          sid: { type: sql.Int, value: sessionId },
          w: { type: sql.Int, value: id },
        },
      );

      const existing = current.recordset[0];
      if (!existing) {
        res.status(404).json({ error: 'not_found', message: 'Session not found' });
        return;
      }

      const merged = {
        startTime: parsed.data.startTime !== undefined ? parsed.data.startTime : existing.StartTime,
        endTime: parsed.data.endTime !== undefined ? parsed.data.endTime : existing.EndTime,
        minEnrollment:
          parsed.data.minEnrollment !== undefined ? parsed.data.minEnrollment : existing.MinEnrollment,
        maxEnrollment:
          parsed.data.maxEnrollment !== undefined ? parsed.data.maxEnrollment : existing.MaxEnrollment,
      };

      const problem = validateSession(merged);
      if (problem) {
        res.status(422).json({
          error: 'validation_failed',
          message: problem.message,
          details: [problem],
        });
        return;
      }

      if (parsed.data.sessionDate !== undefined) {
        const rangeProblem = await checkSessionDateInWorkshop(id, parsed.data.sessionDate);
        if (rangeProblem) {
          res.status(422).json({
            error: 'validation_failed',
            message: rangeProblem,
            details: [{ path: 'sessionDate', message: rangeProblem }],
          });
          return;
        }
      }

      const sets: string[] = [];
      const params: Record<string, SqlParam> = {
        sid: { type: sql.Int, value: sessionId },
        w: { type: sql.Int, value: id },
      };
      if (parsed.data.sessionDate !== undefined) {
        sets.push('SessionDate = @date');
        params.date = { type: sql.Date, value: parsed.data.sessionDate };
      }
      if (parsed.data.startTime !== undefined) {
        sets.push('StartTime = @start');
        params.start = { type: sql.VarChar(8), value: parsed.data.startTime };
      }
      if (parsed.data.endTime !== undefined) {
        sets.push('EndTime = @end');
        params.end = { type: sql.VarChar(8), value: parsed.data.endTime };
      }
      if (parsed.data.maxEnrollment !== undefined) {
        sets.push('MaxEnrollment = @max');
        params.max = { type: sql.Int, value: parsed.data.maxEnrollment };
      }
      if (parsed.data.minEnrollment !== undefined) {
        sets.push('MinEnrollment = @min');
        params.min = { type: sql.Int, value: parsed.data.minEnrollment };
      }
      if (parsed.data.notes !== undefined) {
        sets.push('Notes = @notes');
        params.notes = { type: sql.NVarChar(400), value: parsed.data.notes };
      }
      if (sets.length === 0) {
        res.status(422).json({ error: 'validation_failed', message: 'No fields supplied' });
        return;
      }

      const r = await query(
        `UPDATE core.WorkshopSession SET ${sets.join(', ')}
          WHERE WorkshopSessionID = @sid AND WorkshopID = @w`,
        params,
      );

      if ((r.rowsAffected[0] ?? 0) === 0) {
        res.status(404).json({ error: 'not_found', message: 'Session not found' });
        return;
      }

      const warning = await sessionTimeWarning(id, merged.startTime, merged.endTime);
      res.status(200).json({ warning });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/workshops/{id}/sessions/{sessionId}:
 *   delete:
 *     tags: [Workshops]
 *     summary: Delete a session
 *     description: Refuses when attendance has been recorded, so a checklist is never silently lost.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: sessionId, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       409: { description: Attendance recorded }
 */
workshopsRouter.delete(
  '/:id/sessions/:sessionId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const sessionId = Number(req.params.sessionId);
      if (!Number.isInteger(id) || !Number.isInteger(sessionId)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const marked = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM core.SessionParticipant WHERE WorkshopSessionID = @sid`,
        { sid: { type: sql.Int, value: sessionId } },
      );
      if ((marked.recordset[0]?.n ?? 0) > 0) {
        res.status(409).json({
          error: 'conflict',
          message: `This session has ${marked.recordset[0]!.n} attendance record(s). Clear the attendance first.`,
        });
        return;
      }

      const r = await query(
        `DELETE FROM core.WorkshopSession
          WHERE WorkshopSessionID = @sid AND WorkshopID = @w`,
        {
          sid: { type: sql.Int, value: sessionId },
          w: { type: sql.Int, value: id },
        },
      );

      if ((r.rowsAffected[0] ?? 0) === 0) {
        res.status(404).json({ error: 'not_found', message: 'Session not found' });
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
 * /api/workshops/{id}/sessions/{sessionId}/attendance:
 *   get:
 *     tags: [Workshops]
 *     summary: Attendance checklist for one session
 *     description: >
 *       Every active registrant, with `attended` and `isLate` from
 *       SessionParticipant. Registrants with no row are unmarked rather than
 *       absent, so a fresh checklist is not mistaken for a session where
 *       nobody turned up.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: sessionId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Roster with attendance state }
 */
workshopsRouter.get('/:id/sessions/:sessionId/attendance', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(id) || !Number.isInteger(sessionId)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query<{
      ParticipantID: number;
      ParticipantName: string | null;
      Email: string | null;
      AgencyName: string | null;
      Attended: boolean | null;
      IsLate: boolean | null;
    }>(
      `SELECT r.ParticipantID,
              CONCAT(p.FirstName, ' ', p.LastName) AS ParticipantName,
              p.Email, a.AgencyName,
              CASE WHEN sp.ParticipantID IS NULL THEN NULL ELSE CAST(1 AS bit) END AS Attended,
              sp.IsLate
         FROM core.Registration r
         JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
         LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
         LEFT JOIN core.SessionParticipant sp
                ON sp.ParticipantID = r.ParticipantID
               AND sp.WorkshopSessionID = @sid
        WHERE r.WorkshopID = @w AND r.IsCancelled = 0
        ORDER BY p.LastName, p.FirstName`,
      {
        w: { type: sql.Int, value: id },
        sid: { type: sql.Int, value: sessionId },
      },
    );

    res.json({
      data: result.recordset.map((r) => ({
        participantId: r.ParticipantID,
        name: r.ParticipantName,
        email: r.Email,
        agencyName: r.AgencyName,
        attended: r.Attended === null ? null : r.Attended,
        isLate: r.IsLate === true,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/workshops/{id}/sessions/{sessionId}/attendance/{participantId}:
 *   put:
 *     tags: [Workshops]
 *     summary: Mark or clear one participant's attendance
 *     description: >
 *       `attended: true` inserts the SessionParticipant row, `false` deletes
 *       it. Clearing rather than storing a false keeps "unmarked" and
 *       "absent" distinguishable.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: sessionId, required: true, schema: { type: integer } }
 *       - { in: path, name: participantId, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Saved }
 */
workshopsRouter.put(
  '/:id/sessions/:sessionId/attendance/:participantId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const sessionId = Number(req.params.sessionId);
      const participantId = Number(req.params.participantId);
      const parsed = z
        .object({ attended: z.boolean(), isLate: z.boolean().optional() })
        .safeParse(req.body);

      if (!Number.isInteger(id) || !Number.isInteger(sessionId) || !Number.isInteger(participantId)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }
      if (!parsed.success) {
        res.status(422).json({ error: 'validation_failed', message: '`attended` is required' });
        return;
      }

      // The session must belong to this workshop, or a stray id could touch
      // another workshop's roster.
      const owns = await query(
        `SELECT 1 AS x FROM core.WorkshopSession
          WHERE WorkshopSessionID = @sid AND WorkshopID = @w`,
        {
          sid: { type: sql.Int, value: sessionId },
          w: { type: sql.Int, value: id },
        },
      );
      if (owns.recordset.length === 0) {
        res.status(404).json({ error: 'not_found', message: 'Session not found' });
        return;
      }

      if (parsed.data.attended) {
        await query(
          `IF NOT EXISTS (SELECT 1 FROM core.SessionParticipant
                           WHERE WorkshopSessionID = @sid AND ParticipantID = @pid)
             INSERT INTO core.SessionParticipant (ParticipantID, WorkshopSessionID, IsLate)
             VALUES (@pid, @sid, @late)
           ELSE
             UPDATE core.SessionParticipant SET IsLate = @late
              WHERE WorkshopSessionID = @sid AND ParticipantID = @pid`,
          {
            sid: { type: sql.Int, value: sessionId },
            pid: { type: sql.Int, value: participantId },
            late: { type: sql.Bit, value: parsed.data.isLate ? 1 : 0 },
          },
        );
      } else {
        await query(
          `DELETE FROM core.SessionParticipant
            WHERE WorkshopSessionID = @sid AND ParticipantID = @pid`,
          {
            sid: { type: sql.Int, value: sessionId },
            pid: { type: sql.Int, value: participantId },
          },
        );
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/workshops/{id}/registrations:
 *   get:
 *     tags: [Workshops]
 *     summary: Registrations for a workshop
 *     deprecated: true
 *     description: Superseded by /api/workshops/{id}/registrants.
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
  if (column === 'SessionCeus') return sql.Decimal(6, 2);
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
