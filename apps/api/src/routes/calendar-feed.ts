import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, sql } from '../db.js';
import { env } from '../env.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  getFeedState,
  isFeedTokenValid,
  regenerateLink,
  setFeedEnabled,
} from '../services/calendar-feed-settings.js';
import {
  buildCalendar,
  type FeedSession,
  type FeedWorkshop,
} from '../services/calendar-feed.js';

export const calendarFeedRouter = Router();

/**
 * The workshop calendar as an iCalendar feed.
 *
 * Two audiences share this router:
 *
 *  - `/workshops.ics` is unauthenticated by necessity. Google's calendar
 *    fetcher cannot send a bearer token, so the URL carries a long-lived
 *    secret instead. It is served only while the feed is switched on in
 *    Settings, and a wrong or revoked token is a plain 404 — answering 401
 *    would confirm to a prober that the endpoint exists and is switched on.
 *
 *  - `/settings` and `/link` are the administrator's controls, behind the
 *    normal auth and role checks.
 */

/** How far either side of today the feed reaches. */
const PAST_DAYS = 365;
const FUTURE_DAYS = 730;

/** Where new subscribers should look for updates. Google honours this loosely. */
const REFRESH_INTERVAL = 'PT1H';

/**
 * Domain used in event UIDs.
 *
 * A UID only has to be globally unique and stable, so the deployment's own
 * host is the natural choice. WEB_ORIGIN is a full URL, which is not a legal
 * UID domain, so only its host part is taken.
 */
function uidDomain(): string {
  try {
    return new URL(env.WEB_ORIGIN).host || 'project-enlightenment.local';
  } catch {
    return 'project-enlightenment.local';
  }
}

interface FeedRow {
  WorkshopID: number;
  WorkshopCode: string | null;
  WorkshopName: string | null;
  StartDate: string;
  EndDate: string | null;
  StartTime: string | null;
  EndTime: string | null;
  TimesText: string | null;
  DatesText: string | null;
  Room: number | null;
  IsCancelled: boolean;
  UpdatedAt: Date | null;
  Presenters: string | null;
  Registered: number;
  Capacity: number | null;
}

/**
 * Reads every workshop in the feed's window, with its presenters and its
 * registration count.
 *
 * Presenters are aggregated in SQL rather than fetched per workshop: a
 * two-year window is several hundred workshops, and one round trip per
 * workshop would make the feed slow enough that Google would time it out.
 */
async function loadWorkshops(): Promise<FeedWorkshop[]> {
  const r = await query<FeedRow>(
    `SELECT w.WorkshopID, w.WorkshopCode, n.WorkshopName,
            CONVERT(NVARCHAR(10), w.StartDate, 23) AS StartDate,
            CONVERT(NVARCHAR(10), w.EndDate, 23)   AS EndDate,
            CONVERT(NVARCHAR(5), w.StartTime, 108) AS StartTime,
            CONVERT(NVARCHAR(5), w.EndTime, 108)   AS EndTime,
            w.TimesText, w.DatesText, w.Room, w.IsCancelled, w.UpdatedAt,
            STUFF((SELECT ', ' + LTRIM(RTRIM(
                            ISNULL(ps.FirstName, '') + ' ' + ISNULL(ps.LastName, '')))
                     FROM core.WorkshopPresenter wp
                     JOIN core.PresenterStaff ps ON ps.PresenterStaffID = wp.PresenterID
                    WHERE wp.WorkshopID = w.WorkshopID
                    ORDER BY ps.LastName, ps.FirstName
                      FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS Presenters,
            (SELECT COUNT(*) FROM core.Registration reg
              WHERE reg.WorkshopID = w.WorkshopID AND reg.IsCancelled = 0) AS Registered,
            w.MaxEnrollment AS Capacity
       FROM core.Workshop w
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      WHERE w.StartDate IS NOT NULL
        AND w.StartDate >= DATEADD(day, -@past, CAST(SYSUTCDATETIME() AS date))
        AND w.StartDate <= DATEADD(day, @future, CAST(SYSUTCDATETIME() AS date))
      ORDER BY w.StartDate, w.WorkshopID`,
    {
      past: { type: sql.Int, value: PAST_DAYS },
      future: { type: sql.Int, value: FUTURE_DAYS },
    },
  );

  return r.recordset.map((row) => ({
    workshopId: row.WorkshopID,
    workshopCode: row.WorkshopCode,
    workshopName: row.WorkshopName,
    startDate: row.StartDate,
    endDate: row.EndDate,
    startTime: row.StartTime,
    endTime: row.EndTime,
    timesText: row.TimesText,
    datesText: row.DatesText,
    // Room is a legacy SMALLINT code. It is published as a plain number
    // rather than guessed at a building and room name.
    room: row.Room === null ? null : `Room ${row.Room}`,
    presenters: (row.Presenters ?? '').split(', ').filter((p) => p.trim() !== ''),
    registered: row.Registered,
    capacity: row.Capacity,
    isCancelled: row.IsCancelled,
    updatedAt: row.UpdatedAt,
  }));
}

/** Sessions for every workshop in one query, grouped by workshop. */
async function loadSessions(workshopIds: number[]): Promise<Map<number, FeedSession[]>> {
  const byWorkshop = new Map<number, FeedSession[]>();
  if (workshopIds.length === 0) return byWorkshop;

  const r = await query<{
    WorkshopSessionID: number;
    WorkshopID: number;
    SessionDate: string | null;
    StartTime: string | null;
    EndTime: string | null;
  }>(
    `SELECT s.WorkshopSessionID, s.WorkshopID,
            CONVERT(NVARCHAR(10), s.SessionDate, 23) AS SessionDate,
            CONVERT(NVARCHAR(5), s.StartTime, 108)  AS StartTime,
            CONVERT(NVARCHAR(5), s.EndTime, 108)    AS EndTime
       FROM core.WorkshopSession s
      WHERE s.WorkshopID IN (SELECT value FROM STRING_SPLIT(@ids, ','))
      ORDER BY s.SessionDate, s.StartTime, s.WorkshopSessionID`,
    { ids: { type: sql.NVarChar(sql.MAX), value: workshopIds.join(',') } },
  );

  for (const row of r.recordset) {
    const list = byWorkshop.get(row.WorkshopID) ?? [];
    list.push({
      sessionId: row.WorkshopSessionID,
      sessionDate: row.SessionDate,
      startTime: row.StartTime,
      endTime: row.EndTime,
    });
    byWorkshop.set(row.WorkshopID, list);
  }

  return byWorkshop;
}

/* ------------------------------------------------------------------ */
/*  Public feed                                                        */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/calendar/workshops.ics:
 *   get:
 *     tags: [Calendar feed]
 *     summary: Workshop calendar as an iCalendar feed
 *     description: >
 *       Subscribe to this URL from Google Calendar, Outlook, or any other
 *       calendar app. The `token` is the link issued in Settings; the feed
 *       answers 404 when it is switched off or the token is not current.
 *     security: []
 *     parameters:
 *       - { in: query, name: token, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: iCalendar document, content: { text/calendar: { schema: { type: string } } } }
 *       404: { description: Feed is off or the token is not valid }
 */
calendarFeedRouter.get('/workshops.ics', async (req, res, next) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';

    if (!(await isFeedTokenValid(token))) {
      res.status(404).json({ error: 'not_found', message: 'Calendar feed not found' });
      return;
    }

    const workshops = await loadWorkshops();
    const sessions = await loadSessions(workshops.map((w) => w.workshopId));

    const body = buildCalendar(
      workshops.map((workshop) => ({
        workshop,
        sessions: sessions.get(workshop.workshopId) ?? [],
      })),
      {
        uidDomain: uidDomain(),
        calendarName: 'Project Enlightenment — Workshops',
        appUrl: env.WEB_ORIGIN,
        now: new Date(),
        refreshInterval: REFRESH_INTERVAL,
      },
    );

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="workshops.ics"');
    // Subscribers poll this on their own schedule; a cached copy only makes
    // an edit take longer to appear.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(body);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Administrator controls                                             */
/* ------------------------------------------------------------------ */

/**
 * The absolute subscription URL.
 *
 * The browser builds this from its own origin, because the page's origin is
 * the one the calendar app must reach: in development the API sits behind
 * the Vite proxy, so the server's own Host header would name a port the
 * browser never talked to. `WEB_ORIGIN` is the production fallback for the
 * rare caller that sends no Origin.
 */
function feedUrl(req: Request, token: string): string {
  const origin = req.get('origin') ?? env.WEB_ORIGIN;
  return `${origin.replace(/\/+$/, '')}/api/calendar/workshops.ics?token=${encodeURIComponent(token)}`;
}

/**
 * The state the settings screen sees, with the link attached.
 *
 * `url` is null when no link exists, or when it was issued before migration
 * 033 and only its hash survives — the screen then offers to issue a new one
 * rather than showing a URL that cannot be rebuilt.
 */
async function settingsPayload(req: Request) {
  const state = await getFeedState();
  return { ...state, url: state.token ? feedUrl(req, state.token) : null };
}

/**
 * @openapi
 * /api/calendar/settings:
 *   get:
 *     tags: [Calendar feed]
 *     summary: Whether the workshop calendar feed is on
 *     description: >
 *       Includes the current subscription URL when a link exists. The token
 *       is stored sealed (AES-256-GCM) alongside its hash, so the screen can
 *       show the link again at any time instead of forcing a new one.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Feed state and the subscription URL when a link exists }
 *   patch:
 *     tags: [Calendar feed]
 *     summary: Switch the workshop calendar feed on or off
 *     description: >
 *       Switching on issues a link if none exists, and returns it.
 *       Switching off keeps the link so turning it back on restores the
 *       calendar staff already subscribed to.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: New state, plus the link }
 */
calendarFeedRouter.get(
  '/settings',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      res.json(await settingsPayload(req));
    } catch (err) {
      next(err);
    }
  },
);

const settingsPatch = z.object({ enabled: z.boolean() });

calendarFeedRouter.patch(
  '/settings',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const parsed = settingsPatch.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'validation_failed', details: parsed.error.issues });
        return;
      }

      await setFeedEnabled(parsed.data.enabled, req.user!.email);
      res.json(await settingsPayload(req));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/calendar/link:
 *   post:
 *     tags: [Calendar feed]
 *     summary: Issue a new subscription URL, invalidating the old one
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: The new URL }
 */
calendarFeedRouter.post(
  '/link',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      await regenerateLink(req.user!.email);
      res.json(await settingsPayload(req));
    } catch (err) {
      next(err);
    }
  },
);
