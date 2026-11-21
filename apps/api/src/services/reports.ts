import { query, sql, type SqlParam } from '../db.js';

/**
 * Report catalogue.
 *
 * Adding a report means adding a definition here — no new route, no new page.
 * Every report returns a flat row set and a column list, so the same data
 * drives the on-screen table and the PDF.
 */

export type ReportGroup =
  | 'attendance'
  | 'workshops'
  | 'evaluations'
  | 'surveys'
  | 'demographics'
  | 'operational';

export interface ReportParameter {
  key: string;
  label: string;
  type: 'school-year' | 'date' | 'category' | 'workshop';
  required?: boolean;
}

export interface ReportColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
}

export type ReportRow = Record<string, string | number | null>;

export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  group: ReportGroup;
  replaces: string;
  parameters: ReportParameter[];
  columns: ReportColumn[];
  run: (params: ReportParams) => Promise<ReportRow[]>;
  /**
   * Most recent school year this report can actually produce rows for.
   *
   * A single global default is wrong: 2026-27 has no attendance yet, and
   * 2025-26 has one attended registration but no evaluations. Each report
   * knows its own data, so it reports its own best year.
   */
  latestSchoolYear?: () => Promise<number | null>;
}

export interface ReportParams {
  schoolYearId?: number;
  from?: string;
  to?: string;
  categoryId?: number;
  workshopId?: number;
}

/* ------------------------------------------------------------------ */
/*  Shared SQL fragments                                               */
/* ------------------------------------------------------------------ */

const SCHOOL_YEAR: ReportParameter = {
  key: 'schoolYearId',
  label: 'School year',
  type: 'school-year',
  required: true,
};

const DATE_RANGE: ReportParameter[] = [
  { key: 'from', label: 'From', type: 'date' },
  { key: 'to', label: 'To', type: 'date' },
];

function p(name: string, value: SqlParam['value'], type: SqlParam['type']): [string, SqlParam] {
  return [name, { type, value }];
}

function bind(entries: [string, SqlParam][]): Record<string, SqlParam> {
  return Object.fromEntries(entries);
}

/**
 * Builds a `latestSchoolYear` probe for a report.
 *
 * `source` is a FROM clause that already includes ref.SchoolYear aliased as
 * `sy`, and `where` proves the year has rows for this report. Returns the
 * newest matching year, so a report opens on data rather than on an empty
 * upcoming year.
 */
function latestYearFor(source: string, where: string): () => Promise<number | null> {
  return async () => {
    const r = await query<{ id: number }>(
      `SELECT TOP 1 sy.SchoolYearID AS id
         FROM ${source}
        WHERE ${where}
        ORDER BY sy.SchoolYear DESC`,
    );
    return r.recordset[0]?.id ?? null;
  };
}

/** Years with at least one attended, non-cancelled registration. */
const ATTENDED_SOURCE = `ref.SchoolYear sy
  JOIN core.Workshop w ON w.SchoolYearID = sy.SchoolYearID
  JOIN core.Registration r ON r.WorkshopID = w.WorkshopID`;
const ATTENDED_WHERE = `r.Attended = 1 AND r.IsCancelled = 0`;

/** Years with at least one evaluation rating recorded. */
const EVAL_SOURCE = `ref.SchoolYear sy
  JOIN core.Workshop w ON w.SchoolYearID = sy.SchoolYearID
  JOIN core.WorkshopEvalQuestion e ON e.WorkshopID = w.WorkshopID`;
const EVAL_WHERE = `e.WorkshopEvalRating IS NOT NULL`;

/** Years with at least one free-text evaluation comment in `table`. */
function freeTextSource(table: string): string {
  return `ref.SchoolYear sy
  JOIN core.Workshop w ON w.SchoolYearID = sy.SchoolYearID
  JOIN core.${table} t ON t.WorkshopID = w.WorkshopID`;
}

/** Years with at least one survey response. */
const SURVEY_TOPIC_SOURCE = `ref.SchoolYear sy
  JOIN core.Workshop w ON w.SchoolYearID = sy.SchoolYearID
  JOIN core.WorkshopDesiredTopic t ON t.WorkshopID = w.WorkshopID`;

const SURVEY_TIME_SOURCE = `ref.SchoolYear sy
  JOIN core.Workshop w ON w.SchoolYearID = sy.SchoolYearID
  JOIN core.WorkshopPreferredTime t ON t.WorkshopID = w.WorkshopID`;

/* ------------------------------------------------------------------ */
/*  Attendance                                                         */
/* ------------------------------------------------------------------ */

const attendanceByComponent: ReportDefinition = {
  key: 'attendance-by-component',
  title: 'Attendance by component',
  description: 'Attended registrations grouped by component.',
  group: 'attendance',
  replaces: 'rptAttendbyComponent',
  latestSchoolYear: latestYearFor(ATTENDED_SOURCE, ATTENDED_WHERE),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Component', label: 'Component' },
    { key: 'Workshops', label: 'Workshops', align: 'right' },
    { key: 'Attended', label: 'Attended', align: 'right' },
    { key: 'Participants', label: 'Participants', align: 'right' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT COALESCE(c.PrEComponent, '(none)') AS Component,
              COUNT(DISTINCT w.WorkshopID) AS Workshops,
              COUNT(*) AS Attended,
              COUNT(DISTINCT r.ParticipantID) AS Participants
         FROM core.Registration r
         JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         LEFT JOIN ref.Component c ON c.ComponentID = w.ComponentID
        WHERE w.SchoolYearID = @sy
          AND r.Attended = 1 AND r.IsCancelled = 0
        GROUP BY c.PrEComponent
        ORDER BY Attended DESC`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

const attendanceByCategory: ReportDefinition = {
  key: 'attendance-by-category',
  title: 'Attendance summary by category',
  description: 'Attended registrations and hours per category.',
  group: 'attendance',
  replaces: 'rptAttendSumByCategory',
  latestSchoolYear: latestYearFor(ATTENDED_SOURCE, ATTENDED_WHERE),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Category', label: 'Category' },
    { key: 'Workshops', label: 'Workshops', align: 'right' },
    { key: 'Attended', label: 'Attended', align: 'right' },
    { key: 'Participants', label: 'Participants', align: 'right' },
    { key: 'Hours', label: 'Hours', align: 'right' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT COALESCE(cat.CategoryCode, '(none)') AS Category,
              COUNT(DISTINCT w.WorkshopID) AS Workshops,
              COUNT(*) AS Attended,
              COUNT(DISTINCT r.ParticipantID) AS Participants,
              COALESCE(SUM(w.SessionHours), 0) AS Hours
         FROM core.Registration r
         JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         LEFT JOIN ref.Category cat ON cat.CategoryID = w.CategoryID
        WHERE w.SchoolYearID = @sy
          AND r.Attended = 1 AND r.IsCancelled = 0
        GROUP BY cat.CategoryCode
        ORDER BY Attended DESC`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

const attendanceByCategoryWorkshop: ReportDefinition = {
  key: 'attendance-by-category-workshop',
  title: 'Attendance by category and workshop',
  description: 'Every workshop with its category, attendance and fill rate.',
  group: 'attendance',
  replaces: 'rptAttendSumByCatWks',
  latestSchoolYear: latestYearFor(ATTENDED_SOURCE, ATTENDED_WHERE),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Category', label: 'Category' },
    { key: 'Code', label: 'Code' },
    { key: 'Workshop', label: 'Workshop' },
    { key: 'StartDate', label: 'Date' },
    { key: 'Capacity', label: 'Capacity', align: 'right' },
    { key: 'Attended', label: 'Attended', align: 'right' },
    { key: 'FillRate', label: 'Fill %', align: 'right' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT COALESCE(cat.CategoryCode, '(none)') AS Category,
              w.WorkshopCode AS Code,
              COALESCE(n.WorkshopName, '(untitled)') AS Workshop,
              CONVERT(varchar(10), w.StartDate, 23) AS StartDate,
              w.MaxEnrollment AS Capacity,
              SUM(CASE WHEN r.Attended = 1 AND r.IsCancelled = 0 THEN 1 ELSE 0 END) AS Attended,
              CASE WHEN w.MaxEnrollment IS NULL OR w.MaxEnrollment = 0 THEN NULL
                   ELSE CONVERT(decimal(5,1),
                        100.0 * SUM(CASE WHEN r.Attended = 1 AND r.IsCancelled = 0 THEN 1 ELSE 0 END)
                        / w.MaxEnrollment)
              END AS FillRate
         FROM core.Workshop w
         LEFT JOIN core.Registration r ON r.WorkshopID = w.WorkshopID
         LEFT JOIN ref.Category cat ON cat.CategoryID = w.CategoryID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
        WHERE w.SchoolYearID = @sy
        GROUP BY cat.CategoryCode, w.WorkshopCode, n.WorkshopName, w.StartDate, w.MaxEnrollment
        HAVING SUM(CASE WHEN r.Attended = 1 AND r.IsCancelled = 0 THEN 1 ELSE 0 END) > 0
        ORDER BY cat.CategoryCode, w.StartDate`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

/*
 * The Access database had rptAttendWCPCWorkshops and rptRegWCPCWorkshops, but
 * neither the 'WCPC' workshop-code prefix nor a WCPC component exists in the
 * migrated data — ref.Component has 14 entries and none is WCPC. Those two
 * reports are deliberately not rebuilt: a report that can only ever return
 * zero rows is worse than no report. Revisit if the component is reintroduced.
 */

const saturdayParticipants: ReportDefinition = {
  key: 'saturday-participants',
  title: 'Saturday participants',
  description: 'Participants attending a workshop that starts on a Saturday.',
  group: 'attendance',
  replaces: 'rptSaturdayParticipants',
  latestSchoolYear: latestYearFor(
    ATTENDED_SOURCE,
    `${ATTENDED_WHERE} AND DATENAME(WEEKDAY, w.StartDate) = 'Saturday'`,
  ),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Participant', label: 'Participant' },
    { key: 'Agency', label: 'Agency' },
    { key: 'Workshop', label: 'Workshop' },
    { key: 'StartDate', label: 'Date' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT DISTINCT
              CONCAT(pp.FirstName, ' ', pp.LastName) AS Participant,
              COALESCE(a.AgencyName, '') AS Agency,
              COALESCE(n.WorkshopName, '(untitled)') AS Workshop,
              CONVERT(varchar(10), w.StartDate, 23) AS StartDate
         FROM core.Registration r
         JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         JOIN core.Participant pp ON pp.ParticipantID = r.ParticipantID
         LEFT JOIN core.Agency a ON a.AgencyID = pp.AgencyID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
        WHERE w.SchoolYearID = @sy
          AND r.IsCancelled = 0
          AND DATENAME(WEEKDAY, w.StartDate) = 'Saturday'
        ORDER BY StartDate, Participant`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

/* ------------------------------------------------------------------ */
/*  Workshop listings                                                  */
/* ------------------------------------------------------------------ */

function workshopListing(
  key: string,
  title: string,
  description: string,
  replaces: string,
  audienceFilter: string,
): ReportDefinition {
  return {
    key,
    title,
    description,
    group: 'workshops',
    replaces,
    parameters: [SCHOOL_YEAR, ...DATE_RANGE],
    columns: [
      { key: 'Code', label: 'Code' },
      { key: 'Workshop', label: 'Workshop' },
      { key: 'StartDate', label: 'Start' },
      { key: 'EndDate', label: 'End' },
      { key: 'Category', label: 'Category' },
      { key: 'Capacity', label: 'Cap', align: 'right' },
      { key: 'Registered', label: 'Reg', align: 'right' },
    ],
    run: async (params) => {
      const where = ['1 = 1'];
      const params2: [string, SqlParam][] = [];
      // Scope to a school year when one is supplied. Without this the
      // date-range reports return every workshop ever scheduled.
      if (params.schoolYearId) {
        where.push('w.SchoolYearID = @sy');
        params2.push(p('sy', params.schoolYearId, sql.Int));
      }
      if (params.from) {
        where.push('w.StartDate >= @from');
        params2.push(p('from', params.from, sql.Date));
      }
      if (params.to) {
        where.push('w.StartDate <= @to');
        params2.push(p('to', params.to, sql.Date));
      }
      if (audienceFilter) where.push(audienceFilter);

      const r = await query<ReportRow>(
        `SELECT w.WorkshopCode AS Code,
                COALESCE(n.WorkshopName, '(untitled)') AS Workshop,
                CONVERT(varchar(10), w.StartDate, 23) AS StartDate,
                CONVERT(varchar(10), COALESCE(w.EndDate, w.StartDate), 23) AS EndDate,
                COALESCE(cat.CategoryCode, '') AS Category,
                w.MaxEnrollment AS Capacity,
                (SELECT COUNT(*) FROM core.Registration r
                  WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS Registered
           FROM core.Workshop w
           LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
           LEFT JOIN ref.Category cat ON cat.CategoryID = w.CategoryID
          WHERE ${where.join(' AND ')}
          ORDER BY w.StartDate, w.WorkshopCode`,
        bind(params2),
      );
      return r.recordset;
    },
    // Workshop listings describe what is scheduled, so the newest year with
    // any workshop at all is the right default — not the newest with attendance.
    latestSchoolYear: latestYearFor(
      `ref.SchoolYear sy JOIN core.Workshop w ON w.SchoolYearID = sy.SchoolYearID`,
      '1 = 1',
    ),
  };
}

/* ------------------------------------------------------------------ */
/*  Evaluations                                                        */
/* ------------------------------------------------------------------ */

const evalDistribution: ReportDefinition = {
  key: 'evaluation-distribution',
  title: 'Evaluation rating distribution',
  description:
    'How many 1–5 ratings each question received. A distribution, not an average — the ratings skew heavily to 4 and 5.',
  group: 'evaluations',
  replaces: 'rptWorkshopEvalScores, rptWorkshopEvalScoresSum',
  latestSchoolYear: latestYearFor(EVAL_SOURCE, EVAL_WHERE),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Question', label: 'Question' },
    { key: 'Responses', label: 'Responses', align: 'right' },
    { key: 'R1', label: '1★', align: 'right' },
    { key: 'R2', label: '2★', align: 'right' },
    { key: 'R3', label: '3★', align: 'right' },
    { key: 'R4', label: '4★', align: 'right' },
    { key: 'R5', label: '5★', align: 'right' },
    { key: 'Avg', label: 'Avg', align: 'right' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT q.EvalQuestion AS Question,
              COUNT(*) AS Responses,
              SUM(CASE WHEN e.WorkshopEvalRating = 1 THEN 1 ELSE 0 END) AS R1,
              SUM(CASE WHEN e.WorkshopEvalRating = 2 THEN 1 ELSE 0 END) AS R2,
              SUM(CASE WHEN e.WorkshopEvalRating = 3 THEN 1 ELSE 0 END) AS R3,
              SUM(CASE WHEN e.WorkshopEvalRating = 4 THEN 1 ELSE 0 END) AS R4,
              SUM(CASE WHEN e.WorkshopEvalRating = 5 THEN 1 ELSE 0 END) AS R5,
              CONVERT(decimal(4,2), AVG(CAST(e.WorkshopEvalRating AS decimal(4,2)))) AS Avg
         FROM core.WorkshopEvalQuestion e
         JOIN core.Workshop w ON w.WorkshopID = e.WorkshopID
         JOIN core.EvalQuestion q ON q.EvalQuestID = e.EvalQuestID
        WHERE w.SchoolYearID = @sy
          AND e.WorkshopEvalRating IS NOT NULL
        GROUP BY q.EvalQuestion
        ORDER BY Responses DESC`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

const evalSummary: ReportDefinition = {
  key: 'evaluation-summary',
  title: 'Evaluation summary by workshop',
  description: 'Response count and average rating per workshop.',
  group: 'evaluations',
  replaces: 'rptWorkshopEvalSummary',
  latestSchoolYear: latestYearFor(EVAL_SOURCE, EVAL_WHERE),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Code', label: 'Code' },
    { key: 'Workshop', label: 'Workshop' },
    { key: 'StartDate', label: 'Date' },
    { key: 'Responses', label: 'Responses', align: 'right' },
    { key: 'Avg', label: 'Avg rating', align: 'right' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT w.WorkshopCode AS Code,
              COALESCE(n.WorkshopName, '(untitled)') AS Workshop,
              CONVERT(varchar(10), w.StartDate, 23) AS StartDate,
              COUNT(*) AS Responses,
              CONVERT(decimal(4,2), AVG(CAST(e.WorkshopEvalRating AS decimal(4,2)))) AS Avg
         FROM core.WorkshopEvalQuestion e
         JOIN core.Workshop w ON w.WorkshopID = e.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
        WHERE w.SchoolYearID = @sy
          AND e.WorkshopEvalRating IS NOT NULL
        GROUP BY w.WorkshopCode, n.WorkshopName, w.StartDate
        ORDER BY Avg DESC`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

function freeTextReport(
  key: string,
  title: string,
  description: string,
  replaces: string,
  table: string,
  textColumn: string,
): ReportDefinition {
  return {
    key,
    title,
    description,
    group: 'evaluations',
    replaces,
    parameters: [SCHOOL_YEAR],
    columns: [
      { key: 'Code', label: 'Code' },
      { key: 'StartDate', label: 'Date' },
      { key: 'Comment', label: 'Comment' },
    ],
    run: async (params) => {
      const r = await query<ReportRow>(
        `SELECT w.WorkshopCode AS Code,
                CONVERT(varchar(10), w.StartDate, 23) AS StartDate,
                t.${textColumn} AS Comment
           FROM core.${table} t
           JOIN core.Workshop w ON w.WorkshopID = t.WorkshopID
          WHERE w.SchoolYearID = @sy
            AND t.${textColumn} IS NOT NULL
            AND LTRIM(RTRIM(t.${textColumn})) <> ''
          ORDER BY w.StartDate DESC`,
        bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
      );
      return r.recordset;
    },
    latestSchoolYear: latestYearFor(
      freeTextSource(table),
      `t.${textColumn} IS NOT NULL AND LTRIM(RTRIM(t.${textColumn})) <> ''`,
    ),
  };
}

/* ------------------------------------------------------------------ */
/*  Interest surveys                                                   */
/* ------------------------------------------------------------------ */

const desiredTopics: ReportDefinition = {
  key: 'desired-topics',
  title: 'Desired topics',
  description: 'What participants asked us to offer, most requested first.',
  group: 'surveys',
  replaces: 'rptDesiredTopics',
  latestSchoolYear: latestYearFor(SURVEY_TOPIC_SOURCE, '1 = 1'),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Category', label: 'Category' },
    { key: 'Topic', label: 'Topic' },
    { key: 'Requests', label: 'Requests', align: 'right' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT COALESCE(dc.DesiredTopicCategory, '(none)') AS Category,
              COALESCE(NULLIF(LTRIM(RTRIM(t.WorkshopDesiredTopics)), ''), '(blank)') AS Topic,
              COUNT(*) AS Requests
         FROM core.WorkshopDesiredTopic t
         JOIN core.Workshop w ON w.WorkshopID = t.WorkshopID
         LEFT JOIN ref.DesiredTopicCategory dc
                ON dc.DesiredTopicCategoryID = t.DesiredTopicCategoryID
        WHERE w.SchoolYearID = @sy
        GROUP BY dc.DesiredTopicCategory, t.WorkshopDesiredTopics
        ORDER BY Requests DESC`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

const preferredTimes: ReportDefinition = {
  key: 'preferred-times',
  title: 'Preferred times',
  description: 'When participants said they would prefer to attend.',
  group: 'surveys',
  replaces: 'rptPreferredTimes',
  latestSchoolYear: latestYearFor(SURVEY_TIME_SOURCE, '1 = 1'),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Time', label: 'Preferred time' },
    { key: 'Requests', label: 'Requests', align: 'right' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT COALESCE(pt.PreferredTimes, '(none)') AS Time,
              SUM(COALESCE(t.WorkshopPreferredTimeQty, 1)) AS Requests
         FROM core.WorkshopPreferredTime t
         JOIN core.Workshop w ON w.WorkshopID = t.WorkshopID
         LEFT JOIN ref.PreferredTime pt ON pt.PreferredTimesID = t.PreferredTimeID
        WHERE w.SchoolYearID = @sy
        GROUP BY pt.PreferredTimes
        ORDER BY Requests DESC`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

/* ------------------------------------------------------------------ */
/*  Demographics                                                       */
/* ------------------------------------------------------------------ */

const demoByAgency: ReportDefinition = {
  key: 'demographics-by-agency',
  title: 'Demographics by agency',
  description: 'Participant counts per agency for NCDHHS reporting.',
  group: 'demographics',
  replaces: 'rptNCDemoByAgency',
  latestSchoolYear: latestYearFor(ATTENDED_SOURCE, ATTENDED_WHERE),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Agency', label: 'Agency' },
    { key: 'Participants', label: 'Participants', align: 'right' },
    { key: 'Registrations', label: 'Registrations', align: 'right' },
    { key: 'Attended', label: 'Attended', align: 'right' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT COALESCE(a.AgencyName, '(none)') AS Agency,
              COUNT(DISTINCT r.ParticipantID) AS Participants,
              COUNT(*) AS Registrations,
              SUM(CASE WHEN r.Attended = 1 THEN 1 ELSE 0 END) AS Attended
         FROM core.Registration r
         JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
         LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
        WHERE w.SchoolYearID = @sy
          AND r.IsCancelled = 0
        GROUP BY a.AgencyName
        ORDER BY Participants DESC`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

const demoByWorkshop: ReportDefinition = {
  key: 'demographics-by-workshop',
  title: 'Demographics by workshop',
  description: 'Participant counts per workshop for NCDHHS reporting.',
  group: 'demographics',
  replaces: 'rptNCDemoByWorkshop',
  latestSchoolYear: latestYearFor(ATTENDED_SOURCE, ATTENDED_WHERE),
  parameters: [SCHOOL_YEAR],
  columns: [
    { key: 'Code', label: 'Code' },
    { key: 'Workshop', label: 'Workshop' },
    { key: 'StartDate', label: 'Date' },
    { key: 'Participants', label: 'Participants', align: 'right' },
    { key: 'Attended', label: 'Attended', align: 'right' },
  ],
  run: async (params) => {
    const r = await query<ReportRow>(
      `SELECT w.WorkshopCode AS Code,
              COALESCE(n.WorkshopName, '(untitled)') AS Workshop,
              CONVERT(varchar(10), w.StartDate, 23) AS StartDate,
              COUNT(DISTINCT r.ParticipantID) AS Participants,
              SUM(CASE WHEN r.Attended = 1 THEN 1 ELSE 0 END) AS Attended
         FROM core.Registration r
         JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
        WHERE w.SchoolYearID = @sy
          AND r.IsCancelled = 0
        GROUP BY w.WorkshopCode, n.WorkshopName, w.StartDate
        ORDER BY w.StartDate`,
      bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
    );
    return r.recordset;
  },
};

/* ------------------------------------------------------------------ */
/*  Operational                                                        */
/* ------------------------------------------------------------------ */

/**
 * Backup schedules.
 *
 * Access split these into "day" and "evening" reports, but the backup times
 * are free text ("4:00-5:15 PM", "8:45 AM"), so matching the word "Day" or
 * "Evening" finds nothing. Filter on the actual start hour instead: anything
 * beginning at or after 5 PM is evening.
 */
function backupSchedule(key: string, title: string, replaces: string, period: 'day' | 'evening'): ReportDefinition {
  const timeFilter =
    period === 'evening'
      ? `(bt.BackupTime LIKE '%PM%' AND (
            bt.BackupTime LIKE '5:%' OR bt.BackupTime LIKE '6:%' OR
            bt.BackupTime LIKE '7:%' OR bt.BackupTime LIKE '8:%' OR
            bt.BackupTime LIKE '9:%'))`
      : `(bt.BackupTime LIKE '%AM%' OR (bt.BackupTime LIKE '%PM%' AND (
            bt.BackupTime LIKE '12:%' OR bt.BackupTime LIKE '1:%' OR
            bt.BackupTime LIKE '2:%' OR bt.BackupTime LIKE '3:%' OR
            bt.BackupTime LIKE '4:%')))`;

  return {
    key,
    title,
    description:
      period === 'evening'
        ? 'Workshops with a backup session starting at 5 PM or later.'
        : 'Workshops with a backup session before 5 PM.',
    group: 'operational',
    replaces,
    parameters: [SCHOOL_YEAR],
    columns: [
      { key: 'Code', label: 'Code' },
      { key: 'Workshop', label: 'Workshop' },
      { key: 'StartDate', label: 'Date' },
      { key: 'BackupTime', label: 'Backup time' },
    ],
    run: async (params) => {
      const r = await query<ReportRow>(
        `SELECT w.WorkshopCode AS Code,
                COALESCE(n.WorkshopName, '(untitled)') AS Workshop,
                CONVERT(varchar(10), w.StartDate, 23) AS StartDate,
                MIN(bt.BackupTime) AS BackupTime
           FROM core.Workshop w
           LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
           JOIN core.WorkshopSession s ON s.WorkshopID = w.WorkshopID
           JOIN ref.BackupTime bt ON bt.BackupTimeID = s.BackUpTimeID
          WHERE w.SchoolYearID = @sy
            AND ${timeFilter}
          GROUP BY w.WorkshopCode, n.WorkshopName, w.StartDate
          ORDER BY w.StartDate`,
        bind([p('sy', params.schoolYearId ?? null, sql.Int)]),
      );
      return r.recordset;
    },
    latestSchoolYear: latestYearFor(
      `ref.SchoolYear sy
       JOIN core.Workshop w ON w.SchoolYearID = sy.SchoolYearID
       JOIN core.WorkshopSession s ON s.WorkshopID = w.WorkshopID
       JOIN ref.BackupTime bt ON bt.BackupTimeID = s.BackUpTimeID`,
      timeFilter,
    ),
  };
}

/* ------------------------------------------------------------------ */
/*  Catalogue                                                          */
/* ------------------------------------------------------------------ */

export const REPORTS: ReportDefinition[] = [
  attendanceByComponent,
  attendanceByCategory,
  attendanceByCategoryWorkshop,
  saturdayParticipants,

  workshopListing(
    'workshops-date-range',
    'Workshops in a date range',
    'Every workshop starting between two dates.',
    'rptWorkshopsDateRange',
    '',
  ),
  workshopListing(
    'workshops-date-range-parent',
    'Workshops in a date range — parents',
    'Parent-audience workshops starting between two dates.',
    'rptWorkshopsDateRangeParent',
    "cat.CategoryCode LIKE '%Parent%'",
  ),
  workshopListing(
    'workshops-date-range-teacher',
    'Workshops in a date range — teachers',
    'Teacher-audience workshops starting between two dates.',
    'rptWorkshopsDateRangeTeacher',
    "cat.CategoryCode LIKE '%Teacher%'",
  ),
  workshopListing(
    'workshops-current',
    'Current workshops',
    'Everything scheduled from today onward.',
    'rptWorkshopsCurrent',
    'w.StartDate >= CAST(SYSUTCDATETIME() AS date)',
  ),
  workshopListing(
    'workshops-checklist',
    'Workshop checklist',
    'Upcoming workshops with a place to tick off preparation.',
    'rptWorkshopsCurrentCheckList',
    'w.StartDate >= CAST(SYSUTCDATETIME() AS date)',
  ),

  evalDistribution,
  evalSummary,
  freeTextReport(
    'evaluation-liked-most',
    'Liked most',
    'Free-text positives from evaluations.',
    'srptWorkshopLikedMost',
    'WorkshopLikedMost',
    'LikedMost',
  ),
  freeTextReport(
    'evaluation-liked-least',
    'Liked least',
    'Free-text improvements from evaluations.',
    'srptWorkshopLikedLeast',
    'WorkshopLikedLeast',
    'LikedLeast',
  ),
  freeTextReport(
    'evaluation-practices',
    'Practices adopted',
    'What attendees said they will change in their practice.',
    'srptWorkshopPractices',
    'WorkshopPractice',
    'WorkshopPractice',
  ),

  desiredTopics,
  preferredTimes,
  demoByAgency,
  demoByWorkshop,

  backupSchedule('backup-schedule-day', 'Backup schedule — day', 'rptBackupScheduleDay', 'day'),
  backupSchedule('backup-schedule-evening', 'Backup schedule — evening', 'rptBackupScheduleEvening', 'evening'),
];

export const REPORT_BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));

/**
 * Financial reports are deliberately not rebuilt here. They are views over
 * data the Payments screen owns, and duplicating them would create a second
 * source of truth for money. The hub links out instead.
 */
export const FINANCIAL_LINKS = [
  {
    title: 'Unpaid registrations',
    description: 'Registrations with a balance outstanding.',
    href: '/payments?status=unpaid',
    replaces: 'rptNotPaidRegistrations',
  },
  {
    title: 'Registrations and payments',
    description: 'Every payment with its registration.',
    href: '/payments',
    replaces: 'rptPaymentRegistrationsCurrent',
  },
  {
    title: 'Refunds by agency',
    description: 'Refunded amounts grouped by agency.',
    href: '/payments?status=refunded',
    replaces: 'rptRefundAgency',
  },
  {
    title: 'Refunds by participant',
    description: 'Refunded amounts grouped by participant.',
    href: '/payments?status=refunded',
    replaces: 'rptRefundParticipant',
  },
];
