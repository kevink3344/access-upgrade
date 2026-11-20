import { Router } from 'express';
import { query, sql } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import type { DashboardSummary, UpcomingWorkshop, ActivityItem } from '@pe/shared';

export const dashboardRouter = Router();

/**
 * @openapi
 * /api/dashboard:
 *   get:
 *     tags: [Dashboard]
 *     summary: Landing-page summary
 *     description: Real counts from the migrated database.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Dashboard summary
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/DashboardSummary' }
 */
dashboardRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    // Current school year (the one not flagged as past).
    const sy = await query<{ SchoolYearID: number; SchoolYear: string }>(
      `SELECT TOP 1 SchoolYearID, SchoolYear
         FROM ref.SchoolYear
        WHERE IsPastYear = 0
        ORDER BY SchoolYearID DESC`,
    );
    const schoolYear = sy.recordset[0] ?? null;

    // Whole-database totals.
    const totals = await query<{
      Workshops: number;
      Participants: number;
      Registrations: number;
      Agencies: number;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM core.Workshop)     AS Workshops,
        (SELECT COUNT(*) FROM core.Participant)  AS Participants,
        (SELECT COUNT(*) FROM core.Registration) AS Registrations,
        (SELECT COUNT(*) FROM core.Agency)       AS Agencies
    `);
    const t = totals.recordset[0]!;

    // Current-year figures.
    const yearParams = schoolYear
      ? { sy: { type: sql.Int, value: schoolYear.SchoolYearID } }
      : undefined;

    const yearStats = schoolYear
      ? await query<{
          Workshops: number;
          Registrations: number;
          Participants: number;
          Revenue: number;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM core.Workshop WHERE SchoolYearID = @sy) AS Workshops,
             (SELECT COUNT(*) FROM core.Registration r
                JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
               WHERE w.SchoolYearID = @sy AND r.IsCancelled = 0)          AS Registrations,
             (SELECT COUNT(DISTINCT r.ParticipantID) FROM core.Registration r
                JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
               WHERE w.SchoolYearID = @sy AND r.IsCancelled = 0)          AS Participants,
             (SELECT ISNULL(SUM(r.PaidAmount), 0) FROM core.Registration r
                JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
               WHERE w.SchoolYearID = @sy AND r.IsCancelled = 0)          AS Revenue`,
          yearParams,
        )
      : null;

    const ys = yearStats?.recordset[0] ?? { Workshops: 0, Registrations: 0, Participants: 0, Revenue: 0 };

    // Upcoming workshops: not cancelled, starting from today, soonest first.
    const upcoming = await query<{
      WorkshopID: number;
      WorkshopName: string | null;
      WorkshopCode: string | null;
      StartDate: Date | null;
      EndDate: Date | null;
      Registered: number;
      Capacity: number | null;
      IsClosed: boolean;
      IsCancelled: boolean;
    }>(`
      SELECT TOP 6
             w.WorkshopID,
             n.WorkshopName,
             w.WorkshopCode,
             w.StartDate,
             w.EndDate,
             (SELECT COUNT(*) FROM core.Registration r
               WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS Registered,
             w.MaxEnrollment AS Capacity,
             w.IsClosed,
             w.IsCancelled
        FROM core.Workshop w
        LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
       WHERE w.IsCancelled = 0
         AND w.StartDate >= CAST(SYSUTCDATETIME() AS DATE)
       ORDER BY w.StartDate ASC
    `);

    const upcomingWorkshops: UpcomingWorkshop[] = upcoming.recordset.map((r) => ({
      workshopId: r.WorkshopID,
      workshopName: r.WorkshopName,
      workshopCode: r.WorkshopCode,
      startDate: r.StartDate ? r.StartDate.toISOString().slice(0, 10) : null,
      endDate: r.EndDate ? r.EndDate.toISOString().slice(0, 10) : null,
      registered: r.Registered,
      capacity: r.Capacity,
      isClosed: r.IsClosed,
      isCancelled: r.IsCancelled,
    }));

    // Unpaid: registrations with a positive amount still owed.
    const unpaid = await query<{ Count: number; Total: number }>(`
      SELECT COUNT(*) AS [Count], ISNULL(SUM(PaidAmount), 0) AS Total
        FROM core.Registration
       WHERE IsCancelled = 0
         AND Attended = 0
         AND PaidAmount <= 0
         AND RegistrationDate > DATEADD(MONTH, -6, SYSUTCDATETIME())
    `);
    const u = unpaid.recordset[0]!;

    // Recent activity: latest registrations, joined for a readable label.
    const recent = await query<{
      RegistrationID: number;
      RegistrationDate: Date;
      ParticipantName: string | null;
      WorkshopName: string | null;
      IsCancelled: boolean;
    }>(`
      SELECT TOP 8
             r.RegistrationID,
             r.RegistrationDate,
             CONCAT(p.FirstName, ' ', p.LastName) AS ParticipantName,
             n.WorkshopName,
             r.IsCancelled
        FROM core.Registration r
        LEFT JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
        LEFT JOIN core.Workshop w    ON w.WorkshopID = r.WorkshopID
        LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
       WHERE r.RegistrationDate IS NOT NULL
       ORDER BY r.RegistrationDate DESC
    `);

    const recentActivity: ActivityItem[] = recent.recordset.map((r) => ({
      at: r.RegistrationDate.toISOString(),
      kind: 'registration' as const,
      description: `${r.ParticipantName ?? 'Unknown participant'} registered for ${r.WorkshopName ?? 'a workshop'}`,
      registrationId: r.RegistrationID,
      isCancelled: r.IsCancelled,
    }));

    const body: DashboardSummary = {
      schoolYear: schoolYear
        ? { id: schoolYear.SchoolYearID, name: schoolYear.SchoolYear }
        : null,
      counts: {
        workshops: t.Workshops,
        participants: t.Participants,
        registrations: t.Registrations,
        agencies: t.Agencies,
      },
      currentYear: {
        workshops: ys.Workshops,
        registrations: ys.Registrations,
        participants: ys.Participants,
        revenue: Number(ys.Revenue),
      },
      upcomingWorkshops,
      unpaidRegistrations: { count: u.Count, total: Number(u.Total) },
      recentActivity,
    };

    res.json(body);
  } catch (err) {
    next(err);
  }
});
