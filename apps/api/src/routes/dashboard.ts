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

    // Calendar-year history for the stat cards' sparklines. One query per
    // card's own rule, so each line agrees with the number above it:
    // workshops by start date, registrations by registration date, revenue
    // by registration date (excluding cancellations, like the year figure).
    // SYSUTCDATETIME() matches the rest of this route, which treats dates as UTC.
    const history = await query<{
      Kind: string;
      MonthNo: number;
      Total: number;
    }>(`
      WITH Months AS (
        SELECT 1 AS MonthNo UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
        UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8
        UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
      ),
      YearStart AS (
        SELECT DATEFROMPARTS(YEAR(SYSUTCDATETIME()), 1, 1) AS D
      ),
      WorkshopCounts AS (
        SELECT MONTH(w.StartDate) AS MonthNo, COUNT(*) AS Total
          FROM core.Workshop w, YearStart
         WHERE w.StartDate >= YearStart.D
           AND w.StartDate < DATEADD(YEAR, 1, YearStart.D)
         GROUP BY MONTH(w.StartDate)
      ),
      RegistrationCounts AS (
        SELECT MONTH(r.RegistrationDate) AS MonthNo, COUNT(*) AS Total
          FROM core.Registration r, YearStart
         WHERE r.RegistrationDate >= YearStart.D
           AND r.RegistrationDate < DATEADD(YEAR, 1, YearStart.D)
           AND r.IsCancelled = 0
         GROUP BY MONTH(r.RegistrationDate)
      ),
      Revenue AS (
        SELECT MONTH(r.RegistrationDate) AS MonthNo, ISNULL(SUM(r.PaidAmount), 0) AS Total
          FROM core.Registration r, YearStart
         WHERE r.RegistrationDate >= YearStart.D
           AND r.RegistrationDate < DATEADD(YEAR, 1, YearStart.D)
           AND r.IsCancelled = 0
         GROUP BY MONTH(r.RegistrationDate)
      )
      SELECT 'workshops' AS Kind, m.MonthNo, ISNULL(c.Total, 0) AS Total
        FROM Months m LEFT JOIN WorkshopCounts c ON c.MonthNo = m.MonthNo
      UNION ALL
      SELECT 'registrations', m.MonthNo, ISNULL(c.Total, 0)
        FROM Months m LEFT JOIN RegistrationCounts c ON c.MonthNo = m.MonthNo
      UNION ALL
      SELECT 'revenue', m.MonthNo, ISNULL(c.Total, 0)
        FROM Months m LEFT JOIN Revenue c ON c.MonthNo = m.MonthNo
      ORDER BY Kind, MonthNo
    `);

    const series = (kind: 'workshops' | 'registrations' | 'revenue') =>
      history.recordset
        .filter((r) => r.Kind === kind)
        .sort((a, b) => a.MonthNo - b.MonthNo)
        .map((r) => (kind === 'revenue' ? Number(r.Total) : Number(r.Total) || 0));

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

    // Training requests are imported history (nothing new since 2019), so the
    // card reports the whole set and the sparkline shows the most recent year
    // that actually has requests rather than the current calendar year.
    const training = await query<{ Total: number; Active: number; LatestYear: number | null }>(`
      SELECT COUNT(*) AS Total,
             ISNULL(SUM(CASE WHEN IsActive = 1 THEN 1 ELSE 0 END), 0) AS Active,
             MAX(YEAR(RequestDate)) AS LatestYear
        FROM core.TrainingRequest
    `);
    const tr = training.recordset[0]!;

    const trainingMonthly = tr.LatestYear
      ? await query<{ MonthNo: number; Total: number }>(
          `SELECT MONTH(RequestDate) AS MonthNo, COUNT(*) AS Total
             FROM core.TrainingRequest
            WHERE YEAR(RequestDate) = @year
            GROUP BY MONTH(RequestDate)`,
          { year: { type: sql.Int, value: tr.LatestYear } },
        )
      : null;

    const trainingSeries = Array.from({ length: 12 }, (_, i) => {
      const month = trainingMonthly?.recordset.find((r) => r.MonthNo === i + 1);
      return month ? Number(month.Total) : 0;
    });

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
      monthly: {
        year: new Date().getUTCFullYear(),
        workshops: series('workshops'),
        registrations: series('registrations'),
        revenue: series('revenue'),
      },
      upcomingWorkshops,
      trainingRequests: {
        total: tr.Total,
        active: tr.Active,
        latestYear: tr.LatestYear,
        monthly: trainingSeries,
      },
      recentActivity,
    };

    res.json(body);
  } catch (err) {
    next(err);
  }
});
