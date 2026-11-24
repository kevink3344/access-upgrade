import { query, sql, type SqlParam } from '../db.js';
import type { ChartPoint, ChartSeries } from '@pe/shared';

/**
 * The aggregate behind each Visual Reports chart.
 *
 * Kept apart from the report definitions because these are not "rows" — each
 * one is a single grouped query whose result is already the shape a chart
 * wants. Every function returns the same `ChartSeries` envelope so the
 * frontend has one fetch pattern and one empty-state rule.
 *
 * Figures in the comments were measured against the live database on
 * 2026-11-23; they are there so a future reader can tell at a glance whether
 * a chart has stopped making sense.
 */

export type ChartRunner = (schoolYearId: number | null) => Promise<ChartSeries>;

function envelope(data: ChartPoint[], unit: string, note: string | null): ChartSeries {
  const total = data.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
  return { data, total, isEmpty: data.length === 0, note, unit };
}

/** `yyyy-MM` -> "Sep 2024", for an axis that reads like a date. */
export function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = Number(m[2]) - 1;
  return `${months[idx] ?? m[2]} ${m[1]}`;
}

/**
 * Registrations per month within a school year.
 *
 * Scoped to the school year, not the calendar year: the 2024-25 series runs
 * August to May (229, 377, 224, 135, 50, 96, 140, 51, 23, 1), and a calendar
 * window would cut that curve in half.
 */
async function registrationsByMonth(schoolYearId: number | null): Promise<ChartSeries> {
  if (schoolYearId === null) {
    return envelope([], 'registrations', 'Choose a school year to see the monthly trend.');
  }

  const r = await query<{ ym: string; n: number }>(
    `SELECT FORMAT(r.RegistrationDate, 'yyyy-MM') AS ym, COUNT(*) AS n
       FROM core.Registration r
       JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
      WHERE w.SchoolYearID = @sy AND r.RegistrationDate IS NOT NULL
      GROUP BY FORMAT(r.RegistrationDate, 'yyyy-MM')
      ORDER BY ym`,
    { sy: { type: sql.Int, value: schoolYearId } },
  );

  return envelope(
    r.recordset.map((row) => ({ label: monthLabel(row.ym), value: row.n })),
    'registrations',
    'Counts registrations, not people — one person can register for several workshops.',
  );
}

/**
 * Attended / cancelled / no-show within a school year.
 *
 * "No-show" is derived: registered, not cancelled, not marked attended.
 * There is no status column, and inventing one would let it drift from the
 * two facts it is computed from.
 *
 * **Attendance recording stopped around 2018-19.** Measured 2026-11-23:
 * 3,284 attended in 2006-07, 568 in 2018-19, 0 in 2019-20, and 1 or fewer in
 * every year since. A recent year therefore reads as ~99% no-show — not
 * because nobody came, but because nobody marks the register. Showing that
 * as an outcome chart would be actively misleading, so the note changes when
 * the attended count is too low to be real.
 */
async function attendanceOutcomes(schoolYearId: number | null): Promise<ChartSeries> {
  if (schoolYearId === null) {
    return envelope([], 'registrations', 'Choose a school year to see attendance.');
  }

  const r = await query<{ attended: number; cancelled: number; noShow: number; total: number }>(
    `SELECT SUM(CASE WHEN r.Attended = 1 THEN 1 ELSE 0 END) AS attended,
            SUM(CASE WHEN r.IsCancelled = 1 THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN r.Attended = 0 AND r.IsCancelled = 0 THEN 1 ELSE 0 END) AS noShow,
            COUNT(*) AS total
       FROM core.Registration r
       JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
      WHERE w.SchoolYearID = @sy`,
    { sy: { type: sql.Int, value: schoolYearId } },
  );

  const row = r.recordset[0];
  const attended = row?.attended ?? 0;
  const total = row?.total ?? 0;

  // Below 10% attended, the register almost certainly was not kept. Saying so
  // is the difference between a chart and a lie.
  const looksUnrecorded = total > 0 && attended / total < 0.1;

  const data: ChartPoint[] = [
    { label: 'Attended', value: attended },
    { label: 'No-show', value: row?.noShow ?? 0 },
    { label: 'Cancelled', value: row?.cancelled ?? 0 },
  ].filter((p) => p.value > 0);

  return envelope(
    data,
    'registrations',
    looksUnrecorded
      ? `Only ${attended} of ${total} registrations are marked attended. Attendance recording stopped around 2018-19, so this year shows "no-show" for people who may well have attended.`
      : 'No-show = registered, not cancelled, not marked attended.',
  );
}

/** Workshops per category within a school year. Live: Teacher 955, Parent 510, Guided Obs 469. */
async function workshopsByCategory(schoolYearId: number | null): Promise<ChartSeries> {
  if (schoolYearId === null) {
    return envelope([], 'workshops', 'Choose a school year to see the category split.');
  }

  const r = await query<{ label: string; n: number }>(
    `SELECT TOP 12 ISNULL(c.CategoryCode, 'Uncategorised') AS label, COUNT(*) AS n
       FROM core.Workshop w
       LEFT JOIN ref.Category c ON c.CategoryID = w.CategoryID
      WHERE w.SchoolYearID = @sy
      GROUP BY ISNULL(c.CategoryCode, 'Uncategorised')
      ORDER BY n DESC`,
    { sy: { type: sql.Int, value: schoolYearId } },
  );

  return envelope(
    r.recordset.map((row) => ({ label: row.label, value: row.n })),
    'workshops',
    'Counts workshops, not seats — a 40-seat workshop counts the same as a 5-seat one.',
  );
}

/**
 * Revenue per school year. Deliberately ignores the year filter: it is a
 * cross-year comparison, and filtering it to one year would leave one bar.
 *
 * Refunds are included. Filtering `PaidAmount > 0` would make the total
 * disagree with the Payments screen, which is worse than a slightly odd bar.
 */
async function revenueByYear(): Promise<ChartSeries> {
  const r = await query<{ label: string; total: number }>(
    `SELECT sy.SchoolYear AS label, SUM(r.PaidAmount) AS total
       FROM core.Registration r
       JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
       JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
      WHERE r.IsCancelled = 0 AND r.PaidAmount IS NOT NULL
      GROUP BY sy.SchoolYear, sy.SchoolYearID
      ORDER BY sy.SchoolYearID`,
    {},
  );

  const data = r.recordset.map((row) => ({
    label: row.label,
    value: Math.round((Number(row.total) || 0) * 100) / 100,
  }));

  // The total is the sum of the bars, even though a single year's revenue is
  // not a meaningful quantity — the card header needs something to show, and
  // $0 next to a chart of millions looks broken.
  return envelope(data, 'USD', 'Includes refunds (negative amounts).');
}

/**
 * The agencies with the most registrations.
 *
 * Two things the live data forced:
 *
 *  - A `LEFT JOIN` is required, not an inner join: 10,120 of 41,345
 *    registrations (24%) have no agency, and an inner join would silently
 *    drop a quarter of the data.
 *  - Project Enlightenment (AgencyID 269) is excluded. It is the programme's
 *    own agency — staff registrations and internal bookings — and it ranks
 *    first at 2,695, three times the next agency, which would make the chart
 *    read as "our biggest customer is ourselves".
 */
async function topAgencies(schoolYearId: number | null, limit = 10): Promise<ChartSeries> {
  if (schoolYearId === null) {
    return envelope([], 'registrations', 'Choose a school year to see the top agencies.');
  }

  const r = await query<{ label: string; n: number }>(
    `SELECT TOP (@limit)
            ISNULL(a.AgencyName, 'No agency recorded') AS label,
            COUNT(*) AS n
       FROM core.Registration r
       JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
       JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
       LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
      WHERE w.SchoolYearID = @sy
        AND a.AgencyName <> 'Project Enlightenment'
      GROUP BY ISNULL(a.AgencyName, 'No agency recorded')
      ORDER BY n DESC`,
    {
      sy: { type: sql.Int, value: schoolYearId },
      limit: { type: sql.Int, value: Math.min(Math.max(limit, 1), 25) },
    },
  );

  return envelope(
    r.recordset.map((row) => ({ label: row.label, value: row.n })),
    'registrations',
    'Project Enlightenment (internal) is excluded.',
  );
}

export const CHARTS: Record<string, { title: string; run: ChartRunner }> = {
  'registrations-by-month': { title: 'Registrations by month', run: registrationsByMonth },
  'attendance-outcomes': { title: 'Attendance outcomes', run: attendanceOutcomes },
  'workshops-by-category': { title: 'Workshops by category', run: workshopsByCategory },
  'revenue-by-year': { title: 'Revenue by school year', run: () => revenueByYear() },
  'top-agencies': { title: 'Top agencies', run: (sy) => topAgencies(sy) },
};
export type { SqlParam };
