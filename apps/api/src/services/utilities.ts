import { createHash, randomBytes } from 'node:crypto';
import type {
  DuplicateGroup,
  MergeBlockers,
  MergePreview,
  MergeResult,
  NegativePaymentRow,
  OrphanRegistrationRow,
  UtilityParticipant,
  UtilityRunRow,
  UtilityYearOption,
} from '@pe/shared';
import { getPool, query, sql, txQuery, type SqlParam } from '../db.js';

/* ------------------------------------------------------------------ */
/*  Participant shape                                                  */
/* ------------------------------------------------------------------ */

/**
 * Counts and flags for one participant, used by both the merge picker and the
 * duplicate groups. Kept as one fragment so the two screens cannot disagree
 * about what "has history" means.
 */
const PARTICIPANT_SELECT = `
  p.ParticipantID, p.FirstName, p.LastName, p.Email, a.AgencyName,
  p.DateOfEntry, p.UpdatedAt, p.HasCeuCertificate, p.HasChcCertificate,
  (SELECT COUNT(*) FROM core.Registration r
    WHERE r.ParticipantID = p.ParticipantID) AS RegistrationCount,
  (SELECT COUNT(*) FROM core.SessionParticipant sp
    WHERE sp.ParticipantID = p.ParticipantID) AS AttendanceCount,
  (SELECT COUNT(*) FROM core.CreditSlip cs
    WHERE cs.ParticipantID = p.ParticipantID) AS CreditSlipCount,
  (SELECT COUNT(*) FROM core.CertificateIssue ci
    WHERE ci.ParticipantID = p.ParticipantID) AS CertificateCount`;

interface ParticipantRow {
  ParticipantID: number;
  FirstName: string | null;
  LastName: string | null;
  Email: string | null;
  AgencyName: string | null;
  DateOfEntry: Date | null;
  UpdatedAt: Date | null;
  HasCeuCertificate: boolean;
  HasChcCertificate: boolean;
  RegistrationCount: number;
  AttendanceCount: number;
  CreditSlipCount: number;
  CertificateCount: number;
}

function toParticipant(r: ParticipantRow): UtilityParticipant {
  return {
    participantId: r.ParticipantID,
    firstName: r.FirstName,
    lastName: r.LastName,
    email: r.Email,
    agencyName: r.AgencyName,
    registrationCount: r.RegistrationCount,
    attendanceCount: r.AttendanceCount,
    creditSlipCount: r.CreditSlipCount,
    certificateCount: r.CertificateCount,
    hasCeuCertificate: r.HasCeuCertificate === true,
    hasChcCertificate: r.HasChcCertificate === true,
    dateOfEntry: r.DateOfEntry ? r.DateOfEntry.toISOString() : null,
    updatedAt: r.UpdatedAt ? r.UpdatedAt.toISOString() : null,
  };
}

export function displayName(p: { firstName: string | null; lastName: string | null }): string {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  return name || 'Unnamed participant';
}

/**
 * A participant row with nothing on it at all - the Access import artefacts.
 * The same test the Participants list uses to hide them; merging into one of
 * these would move real history onto a blank record.
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

/* ------------------------------------------------------------------ */
/*  Participant picker                                                 */
/* ------------------------------------------------------------------ */

export async function listParticipants(opts: {
  q?: string;
  page: number;
  pageSize: number;
}): Promise<{ data: UtilityParticipant[]; page: number; pageSize: number; total: number }> {
  const params: Record<string, SqlParam> = {};
  const where: string[] = [];

  if (opts.q) {
    where.push(
      `(p.FirstName LIKE @q OR p.LastName LIKE @q OR p.Email LIKE @q
        OR CONCAT(p.FirstName, ' ', p.LastName) LIKE @q
        OR CONCAT(p.LastName, ', ', p.FirstName) LIKE @q)`,
    );
    params.q = { type: sql.NVarChar(260), value: `%${opts.q}%` };
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `FROM core.Participant p LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID ${whereSql}`;

  const count = await query<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, params);
  const rows = await query<ParticipantRow>(
    `SELECT ${PARTICIPANT_SELECT}
       ${base}
      ORDER BY p.LastName, p.FirstName, p.ParticipantID
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    {
      ...params,
      offset: { type: sql.Int, value: (opts.page - 1) * opts.pageSize },
      limit: { type: sql.Int, value: opts.pageSize },
    },
  );

  return {
    data: rows.recordset.map(toParticipant),
    page: opts.page,
    pageSize: opts.pageSize,
    total: count.recordset[0]?.n ?? 0,
  };
}

export async function getParticipant(id: number): Promise<UtilityParticipant | null> {
  const r = await query<ParticipantRow>(
    `SELECT ${PARTICIPANT_SELECT}
       FROM core.Participant p
       LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
      WHERE p.ParticipantID = @id`,
    { id: { type: sql.Int, value: id } },
  );
  const row = r.recordset[0];
  return row ? toParticipant(row) : null;
}

/* ------------------------------------------------------------------ */
/*  Duplicate groups                                                   */
/* ------------------------------------------------------------------ */

/**
 * Participants that share an email address.
 *
 * Grouped on the normalised address, because the duplicates came from
 * differing case as well as genuine repeats. Blank addresses are excluded:
 * every participant with no email is not a duplicate of every other one.
 *
 * Empty participant rows are excluded too - they have no email by definition,
 * but the guard makes the intent explicit and survives a future change to
 * IS_EMPTY.
 *
 * `schoolYearId` scopes the list to participants who registered for a
 * workshop in that year. The whole backlog is 937 groups and almost all of it
 * is history nobody will ever merge, so the screen opens on the current year
 * and offers the rest deliberately. The year filter is applied to the
 * *participants* in a group, not to the groups themselves: a group is still a
 * duplicate only because two people share the address, and showing one of
 * them alone would invite a merge with a record that is not on screen.
 */
export async function duplicateGroups(opts: {
  page: number;
  pageSize: number;
  schoolYearId?: number | null;
}): Promise<{
  data: DuplicateGroup[];
  page: number;
  pageSize: number;
  totalGroups: number;
  totalParticipants: number;
  schoolYear: { id: number; label: string } | null;
}> {
  const year = opts.schoolYearId ?? null;

  // A participant is "in" the year when they hold a registration for a
  // workshop in it. Cancelled registrations still count: the duplicate
  // exists because the address was reused, not because the enrolment stuck.
  const IN_YEAR = year
    ? `EXISTS (SELECT 1 FROM core.Registration r
                 JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
                WHERE r.ParticipantID = p.ParticipantID
                  AND w.SchoolYearID = @year)`
    : '1 = 1';

  const yearParam: Record<string, SqlParam> = year
    ? { year: { type: sql.Int, value: year } }
    : {};

  const totals = await query<{ groups: number; participants: number }>(
    `SELECT COUNT(*) AS groups, ISNULL(SUM(cnt), 0) AS participants
       FROM (
         SELECT COUNT(*) AS cnt
           FROM core.Participant p
          WHERE NULLIF(LTRIM(RTRIM(ISNULL(p.Email, ''))), '') IS NOT NULL
            AND NOT ${IS_EMPTY}
            AND ${IN_YEAR}
          GROUP BY LOWER(LTRIM(RTRIM(p.Email)))
         HAVING COUNT(*) > 1
       ) g`,
    yearParam,
  );

  const totalGroups = totals.recordset[0]?.groups ?? 0;
  const totalParticipants = totals.recordset[0]?.participants ?? 0;

  const yearInfo = year ? await schoolYearLabel(year) : null;

  if (totalGroups === 0) {
    return {
      data: [],
      page: opts.page,
      pageSize: opts.pageSize,
      totalGroups,
      totalParticipants,
      schoolYear: yearInfo,
    };
  }

  // One page of addresses, then every participant on those addresses. Two
  // queries rather than a join so the page size counts groups, not rows.
  const emails = await query<{ Email: string }>(
    `SELECT LOWER(LTRIM(RTRIM(p.Email))) AS Email
       FROM core.Participant p
      WHERE NULLIF(LTRIM(RTRIM(ISNULL(p.Email, ''))), '') IS NOT NULL
        AND NOT ${IS_EMPTY}
        AND ${IN_YEAR}
      GROUP BY LOWER(LTRIM(RTRIM(p.Email)))
     HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, LOWER(LTRIM(RTRIM(p.Email)))
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    {
      ...yearParam,
      offset: { type: sql.Int, value: (opts.page - 1) * opts.pageSize },
      limit: { type: sql.Int, value: opts.pageSize },
    },
  );

  const keys = emails.recordset.map((r) => r.Email);
  if (keys.length === 0) {
    return {
      data: [],
      page: opts.page,
      pageSize: opts.pageSize,
      totalGroups,
      totalParticipants,
      schoolYear: yearInfo,
    };
  }

  const params: Record<string, SqlParam> = { ...yearParam };
  const inList = keys.map((k, i) => {
    params[`e${i}`] = { type: sql.NVarChar(100), value: k };
    return `@e${i}`;
  });

  // The counts are repeated as correlated subqueries rather than reusing
  // PARTICIPANT_SELECT: that fragment's aliases are referenced in an ORDER BY,
  // and SQL Server rejects an alias in ORDER BY when the same name also
  // appears inside a subquery in the select list.
  const rows = await query<ParticipantRow & { GroupEmail: string }>(
    `SELECT p.ParticipantID, p.FirstName, p.LastName, p.Email, a.AgencyName,
            p.DateOfEntry, p.UpdatedAt, p.HasCeuCertificate, p.HasChcCertificate,
            (SELECT COUNT(*) FROM core.Registration r
              WHERE r.ParticipantID = p.ParticipantID) AS RegistrationCount,
            (SELECT COUNT(*) FROM core.SessionParticipant sp
              WHERE sp.ParticipantID = p.ParticipantID) AS AttendanceCount,
            (SELECT COUNT(*) FROM core.CreditSlip cs
              WHERE cs.ParticipantID = p.ParticipantID) AS CreditSlipCount,
            (SELECT COUNT(*) FROM core.CertificateIssue ci
              WHERE ci.ParticipantID = p.ParticipantID) AS CertificateCount,
            LOWER(LTRIM(RTRIM(p.Email))) AS GroupEmail
       FROM core.Participant p
       LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
      WHERE LOWER(LTRIM(RTRIM(p.Email))) IN (${inList.join(', ')})
        AND ${IN_YEAR}
      ORDER BY LOWER(LTRIM(RTRIM(p.Email))),
               (SELECT COUNT(*) FROM core.Registration r2
                 WHERE r2.ParticipantID = p.ParticipantID) DESC,
               p.LastName, p.FirstName`,
    params,
  );

  const byEmail = new Map<string, DuplicateGroup>();
  for (const key of keys) byEmail.set(key, { email: key, participants: [], registrationCount: 0 });

  for (const row of rows.recordset) {
    const group = byEmail.get(row.GroupEmail);
    if (!group) continue;
    group.participants.push(toParticipant(row));
    group.registrationCount += row.RegistrationCount;
  }

  return {
    data: keys.map((k) => byEmail.get(k)!),
    page: opts.page,
    pageSize: opts.pageSize,
    totalGroups,
    totalParticipants,
    schoolYear: yearInfo,
  };
}

async function schoolYearLabel(id: number): Promise<{ id: number; label: string } | null> {
  const r = await query<{ id: number; label: string | null }>(
    `SELECT SchoolYearID AS id, SchoolYear AS label FROM ref.SchoolYear WHERE SchoolYearID = @id`,
    { id: { type: sql.Int, value: id } },
  );
  const row = r.recordset[0];
  return row ? { id: row.id, label: row.label ?? String(row.id) } : null;
}

/**
 * School years for the Participants-by-year dropdown, newest first, each with
 * the number of duplicate groups that have a participant in it.
 *
 * The counts are what make the dropdown useful: staff can see at a glance
 * that the current year has a handful to work through while 2019-20 has
 * hundreds they will probably never touch.
 */
export async function schoolYears(): Promise<UtilityYearOption[]> {
  const r = await query<{
    SchoolYearID: number;
    SchoolYear: string | null;
    IsPastYear: boolean;
    DuplicateGroups: number;
  }>(
    `SELECT sy.SchoolYearID, sy.SchoolYear, sy.IsPastYear,
            (SELECT COUNT(*) FROM (
               SELECT LOWER(LTRIM(RTRIM(p.Email))) AS e
                 FROM core.Participant p
                WHERE NULLIF(LTRIM(RTRIM(ISNULL(p.Email, ''))), '') IS NOT NULL
                  AND NOT ${IS_EMPTY}
                  AND EXISTS (SELECT 1 FROM core.Registration r
                                JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
                               WHERE r.ParticipantID = p.ParticipantID
                                 AND w.SchoolYearID = sy.SchoolYearID)
                GROUP BY LOWER(LTRIM(RTRIM(p.Email)))
               HAVING COUNT(*) > 1) g) AS DuplicateGroups
       FROM ref.SchoolYear sy
      ORDER BY sy.SchoolYearID DESC`,
  );

  return r.recordset.map((row) => ({
    id: row.SchoolYearID,
    label: row.SchoolYear ?? String(row.SchoolYearID),
    isPastYear: row.IsPastYear === true,
    duplicateGroups: row.DuplicateGroups,
  }));
}

/* ------------------------------------------------------------------ */
/*  Merge                                                              */
/* ------------------------------------------------------------------ */

/**
 * Confirmation tokens.
 *
 * The token binds a preview to the exact pair and the exact counts the admin
 * saw, so a stale preview cannot authorise a different-sized change. They
 * live in memory: a restart invalidates them, which is the safe direction -
 * the admin previews again rather than running against a count nobody saw.
 */
interface MergeToken {
  sourceId: number;
  targetId: number;
  fingerprint: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 10 * 60_000;
const mergeTokens = new Map<string, MergeToken>();

function fingerprint(m: MergePreview['moves']): string {
  return createHash('sha256')
    .update(
      [
        m.registrations,
        m.attendance,
        m.creditSlips,
        m.usedCreditSlips,
        m.certificateOverrides,
        m.certificateIssues,
      ].join('|'),
    )
    .digest('hex');
}

/** Drops expired tokens so the map cannot grow without bound. */
function pruneTokens(now = Date.now()): void {
  for (const [token, entry] of mergeTokens) {
    if (entry.expiresAt <= now) mergeTokens.delete(token);
  }
}

async function countMoves(sourceId: number, targetId: number): Promise<MergePreview['moves']> {
  const r = await query<{
    Registrations: number;
    Attendance: number;
    CreditSlips: number;
    UsedCreditSlips: number;
    CertificateOverrides: number;
    CertificateIssues: number;
    SharedOverrides: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM core.Registration        WHERE ParticipantID = @src) AS Registrations,
       (SELECT COUNT(*) FROM core.SessionParticipant  WHERE ParticipantID = @src) AS Attendance,
       (SELECT COUNT(*) FROM core.CreditSlip          WHERE ParticipantID = @src) AS CreditSlips,
       (SELECT COUNT(*) FROM core.CreditSlip          WHERE UsedParticipantID = @src) AS UsedCreditSlips,
       (SELECT COUNT(*) FROM core.CertificateOverride
         WHERE ParticipantID = @src
           AND NOT EXISTS (SELECT 1 FROM core.CertificateOverride t
                            WHERE t.ParticipantID = @tgt
                              AND t.SchoolYearID = core.CertificateOverride.SchoolYearID
                              AND t.CertificateType = core.CertificateOverride.CertificateType)
       ) AS CertificateOverrides,
       (SELECT COUNT(*) FROM core.CertificateIssue    WHERE ParticipantID = @src) AS CertificateIssues,
       (SELECT COUNT(*) FROM core.CertificateOverride o
         WHERE o.ParticipantID = @src
           AND EXISTS (SELECT 1 FROM core.CertificateOverride t
                        WHERE t.ParticipantID = @tgt
                          AND t.SchoolYearID = o.SchoolYearID
                          AND t.CertificateType = o.CertificateType)
       ) AS SharedOverrides`,
    {
      src: { type: sql.Int, value: sourceId },
      tgt: { type: sql.Int, value: targetId },
    },
  );

  const row = r.recordset[0]!;
  return {
    registrations: row.Registrations,
    attendance: row.Attendance,
    creditSlips: row.CreditSlips,
    usedCreditSlips: row.UsedCreditSlips,
    certificateOverrides: row.CertificateOverrides,
    certificateIssues: row.CertificateIssues,
  };
}

async function findBlockers(sourceId: number, targetId: number): Promise<MergeBlockers> {
  const shared = await query<{
    WorkshopID: number | null;
    WorkshopCode: string | null;
    WorkshopName: string | null;
    StartDate: Date | null;
  }>(
    `SELECT DISTINCT w.WorkshopID, w.WorkshopCode, n.WorkshopName, w.StartDate
       FROM core.Registration s
       JOIN core.Registration t
         ON t.WorkshopID = s.WorkshopID
        AND t.ParticipantID = @tgt
        AND t.IsCancelled = 0
       LEFT JOIN core.Workshop w ON w.WorkshopID = s.WorkshopID
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      WHERE s.ParticipantID = @src
        AND s.WorkshopID IS NOT NULL
        AND s.IsCancelled = 0`,
    {
      src: { type: sql.Int, value: sourceId },
      tgt: { type: sql.Int, value: targetId },
    },
  );

  const notes: string[] = [];

  // Attendance is keyed (ParticipantID, WorkshopSessionID). A session both
  // attended would collide on the primary key, so those rows are dropped -
  // the target's row already records the same fact.
  const attendanceClash = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM core.SessionParticipant s
       JOIN core.SessionParticipant t
         ON t.WorkshopSessionID = s.WorkshopSessionID
        AND t.ParticipantID = @tgt
      WHERE s.ParticipantID = @src`,
    {
      src: { type: sql.Int, value: sourceId },
      tgt: { type: sql.Int, value: targetId },
    },
  );
  const clash = attendanceClash.recordset[0]?.n ?? 0;
  if (clash > 0) {
    notes.push(
      `${clash} attendance record(s) are for sessions both participants attended. ` +
        `They are dropped, because the target already records attendance for those sessions.`,
    );
  }

  const overrideClash = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM core.CertificateOverride s
       JOIN core.CertificateOverride t
         ON t.SchoolYearID = s.SchoolYearID
        AND t.CertificateType = s.CertificateType
        AND t.ParticipantID = @tgt
      WHERE s.ParticipantID = @src`,
    {
      src: { type: sql.Int, value: sourceId },
      tgt: { type: sql.Int, value: targetId },
    },
  );
  const oClash = overrideClash.recordset[0]?.n ?? 0;
  if (oClash > 0) {
    notes.push(
      `${oClash} certificate override(s) exist for both participants in the same school year. ` +
        `The target's override is kept and the source's is dropped.`,
    );
  }

  return {
    sharedWorkshops: shared.recordset.map((r) => ({
      workshopId: r.WorkshopID,
      workshopCode: r.WorkshopCode,
      workshopName: r.WorkshopName,
      startDate: r.StartDate ? r.StartDate.toISOString().slice(0, 10) : null,
    })),
    notes,
  };
}

export class UtilityError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'UtilityError';
  }
}

export async function previewMerge(
  sourceId: number,
  targetId: number,
): Promise<MergePreview> {
  if (sourceId === targetId) {
    throw new UtilityError(422, 'validation_failed', 'Choose two different participants.');
  }

  const [source, target] = await Promise.all([getParticipant(sourceId), getParticipant(targetId)]);

  if (!source) throw new UtilityError(404, 'not_found', `Participant ${sourceId} was not found.`);
  if (!target) throw new UtilityError(404, 'not_found', `Participant ${targetId} was not found.`);

  const moves = await countMoves(sourceId, targetId);
  const blockers = await findBlockers(sourceId, targetId);

  // A source with nothing on it has no reason to exist; deleting it is the
  // whole point. One with history is kept, and only its history moves.
  const hasHistory =
    source.registrationCount +
      source.attendanceCount +
      source.creditSlipCount +
      source.certificateCount >
    0;

  pruneTokens();
  const token = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  mergeTokens.set(token, {
    sourceId,
    targetId,
    fingerprint: fingerprint(moves),
    expiresAt,
  });

  return {
    source,
    target,
    moves,
    deletesSource: !hasHistory,
    blockers,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Reassigns every row from one participant to another, then deletes the
 * orphan when it has nothing left.
 *
 * The order matters. Registrations move first because the shared-workshop
 * check reads them; attendance and credit slips follow; overrides are moved
 * only where the target has none for that year and type, because the unique
 * key would reject the second. Everything runs in one transaction, so a
 * failure part-way leaves both participants exactly as they were.
 */
export async function runMerge(
  sourceId: number,
  targetId: number,
  token: string,
  runBy: string,
): Promise<MergeResult> {
  pruneTokens();

  const entry = mergeTokens.get(token);
  if (!entry || entry.sourceId !== sourceId || entry.targetId !== targetId) {
    throw new UtilityError(
      409,
      'stale_preview',
      'This confirmation has expired or does not match the participants. Preview the merge again.',
    );
  }

  const current = await countMoves(sourceId, targetId);
  if (fingerprint(current) !== entry.fingerprint) {
    mergeTokens.delete(token);
    throw new UtilityError(
      409,
      'stale_preview',
      'The data changed since the preview was taken. Preview the merge again before running it.',
    );
  }

  const blockers = await findBlockers(sourceId, targetId);
  if (blockers.sharedWorkshops.length > 0) {
    const names = blockers.sharedWorkshops
      .map((w) => w.workshopName ?? w.workshopCode ?? `Workshop ${w.workshopId}`)
      .join(', ');
    throw new UtilityError(
      409,
      'shared_workshop',
      `Both participants are registered for the same workshop (${names}). ` +
        'Merging would create a duplicate enrolment, so cancel one of those registrations first.',
    );
  }

  const source = await getParticipant(sourceId);
  if (!source) throw new UtilityError(404, 'not_found', `Participant ${sourceId} was not found.`);

  const pool = await getPool();
  const tx = pool.transaction();
  await tx.begin();

  let affected = 0;
  const warnings = [...blockers.notes];

  try {
    const params = {
      src: { type: sql.Int, value: sourceId },
      tgt: { type: sql.Int, value: targetId },
    };

    const reg = await txQuery(tx, `UPDATE core.Registration SET ParticipantID = @tgt WHERE ParticipantID = @src`, params);
    affected += reg.rowsAffected[0] ?? 0;

    // Attendance that would collide with the target's own row is deleted
    // first; the remaining rows are then safe to move.
    const attDropped = await txQuery(
      tx,
      `DELETE s
         FROM core.SessionParticipant s
         JOIN core.SessionParticipant t
           ON t.WorkshopSessionID = s.WorkshopSessionID
          AND t.ParticipantID = @tgt
        WHERE s.ParticipantID = @src`,
      params,
    );
    const att = await txQuery(
      tx,
      `UPDATE core.SessionParticipant SET ParticipantID = @tgt WHERE ParticipantID = @src`,
      params,
    );
    affected += att.rowsAffected[0] ?? 0;
    // Dropped rows are still a change to the source, so they count.
    affected += attDropped.rowsAffected[0] ?? 0;

    const cs = await txQuery(tx, `UPDATE core.CreditSlip SET ParticipantID = @tgt WHERE ParticipantID = @src`, params);
    affected += cs.rowsAffected[0] ?? 0;

    const csUsed = await txQuery(
      tx,
      `UPDATE core.CreditSlip SET UsedParticipantID = @tgt WHERE UsedParticipantID = @src`,
      params,
    );
    affected += csUsed.rowsAffected[0] ?? 0;

    const ovDropped = await txQuery(
      tx,
      `DELETE s
         FROM core.CertificateOverride s
         JOIN core.CertificateOverride t
           ON t.SchoolYearID = s.SchoolYearID
          AND t.CertificateType = s.CertificateType
          AND t.ParticipantID = @tgt
        WHERE s.ParticipantID = @src`,
      params,
    );
    const ov = await txQuery(
      tx,
      `UPDATE core.CertificateOverride SET ParticipantID = @tgt WHERE ParticipantID = @src`,
      params,
    );
    affected += ov.rowsAffected[0] ?? 0;
    affected += ovDropped.rowsAffected[0] ?? 0;

    const ci = await txQuery(tx, `UPDATE core.CertificateIssue SET ParticipantID = @tgt WHERE ParticipantID = @src`, params);
    affected += ci.rowsAffected[0] ?? 0;

    // Certificate flags are "has one been issued", so the merged record keeps
    // either participant's flag rather than losing one.
    await txQuery(
      tx,
      `UPDATE core.Participant
          SET HasCeuCertificate = CASE WHEN HasCeuCertificate = 1 OR @srcCeu = 1 THEN 1 ELSE 0 END,
              HasChcCertificate = CASE WHEN HasChcCertificate = 1 OR @srcChc = 1 THEN 1 ELSE 0 END,
              UpdatedAt = SYSUTCDATETIME()
        WHERE ParticipantID = @tgt`,
      {
        tgt: { type: sql.Int, value: targetId },
        srcCeu: { type: sql.Bit, value: source.hasCeuCertificate ? 1 : 0 },
        srcChc: { type: sql.Bit, value: source.hasChcCertificate ? 1 : 0 },
      },
    );

    // Delete the orphan only when nothing points at it any more. Checking
    // rather than assuming means a table added later cannot silently block
    // the delete with a foreign key error after the moves have committed.
    const remaining = await txQuery<{ n: number }>(
      tx,
      `SELECT
         (SELECT COUNT(*) FROM core.Registration        WHERE ParticipantID = @src) +
         (SELECT COUNT(*) FROM core.SessionParticipant  WHERE ParticipantID = @src) +
         (SELECT COUNT(*) FROM core.CreditSlip          WHERE ParticipantID = @src OR UsedParticipantID = @src) +
         (SELECT COUNT(*) FROM core.CertificateOverride WHERE ParticipantID = @src) +
         (SELECT COUNT(*) FROM core.CertificateIssue    WHERE ParticipantID = @src) AS n`,
      params,
    );

    let deleted = false;
    if ((remaining.recordset[0]?.n ?? 0) === 0) {
      await txQuery(tx, `DELETE FROM core.Participant WHERE ParticipantID = @src`, params);
      deleted = true;
      affected += 1;
    } else {
      warnings.push(
        'The source participant still has linked records after the merge, so it was kept.',
      );
    }

    await tx.commit();
    mergeTokens.delete(token);

    return {
      sourceParticipantId: sourceId,
      targetParticipantId: targetId,
      affectedRows: affected,
      moves: current,
      deletedSource: deleted,
      warnings,
    };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/*  Review lists                                                       */
/* ------------------------------------------------------------------ */

export async function negativePayments(): Promise<{
  data: NegativePaymentRow[];
  summary: { count: number; total: number; onCancelled: number; onActive: number };
}> {
  const r = await query<{
    RegistrationID: number;
    ParticipantID: number | null;
    FirstName: string | null;
    LastName: string | null;
    Email: string | null;
    WorkshopID: number | null;
    WorkshopCode: string | null;
    WorkshopName: string | null;
    StartDate: Date | null;
    PaidAmount: number;
    PaidDate: Date | null;
    RegistrationDate: Date | null;
    ReceiptNumber: number | null;
    PaymentMethod: string | null;
    IsCancelled: boolean;
    Source: string;
    Notes: string | null;
  }>(
    `SELECT r.RegistrationID, r.ParticipantID, p.FirstName, p.LastName, p.Email,
            r.WorkshopID, w.WorkshopCode, n.WorkshopName, w.StartDate,
            r.PaidAmount, r.PaidDate, r.RegistrationDate, r.ReceiptNumber,
            pm.PaymentMethod, r.IsCancelled, r.Source, r.Notes
       FROM core.Registration r
       LEFT JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
       LEFT JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
       LEFT JOIN ref.PaymentMethod pm ON pm.PaymentMethodID = r.PaymentMethodID
      WHERE r.PaidAmount < 0
      ORDER BY r.PaidAmount ASC, r.PaidDate DESC`,
  );

  const data: NegativePaymentRow[] = r.recordset.map((row) => ({
    registrationId: row.RegistrationID,
    participantId: row.ParticipantID,
    participantName: displayName({ firstName: row.FirstName, lastName: row.LastName }),
    participantEmail: row.Email,
    workshopId: row.WorkshopID,
    workshopCode: row.WorkshopCode,
    workshopName: row.WorkshopName,
    startDate: row.StartDate ? row.StartDate.toISOString().slice(0, 10) : null,
    paidAmount: Number(row.PaidAmount),
    paidDate: row.PaidDate ? row.PaidDate.toISOString().slice(0, 10) : null,
    registrationDate: row.RegistrationDate
      ? row.RegistrationDate.toISOString().slice(0, 10)
      : null,
    receiptNumber: row.ReceiptNumber,
    paymentMethod: row.PaymentMethod,
    isCancelled: row.IsCancelled === true,
    source: row.Source,
    notes: row.Notes,
  }));

  return {
    data,
    summary: {
      count: data.length,
      total: data.reduce((sum, row) => sum + row.paidAmount, 0),
      onCancelled: data.filter((row) => row.isCancelled).length,
      onActive: data.filter((row) => !row.isCancelled).length,
    },
  };
}

export async function orphanRegistrations(): Promise<{
  data: OrphanRegistrationRow[];
  summary: { count: number; withPayment: number; totalPaid: number };
}> {
  const r = await query<{
    RegistrationID: number;
    ParticipantID: number | null;
    FirstName: string | null;
    LastName: string | null;
    Email: string | null;
    RegistrationDate: Date | null;
    PaidAmount: number | null;
    IsCancelled: boolean;
    Attended: boolean;
    Source: string;
    Notes: string | null;
  }>(
    `SELECT r.RegistrationID, r.ParticipantID, p.FirstName, p.LastName, p.Email,
            r.RegistrationDate, r.PaidAmount, r.IsCancelled, r.Attended, r.Source, r.Notes
       FROM core.Registration r
       LEFT JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
      WHERE r.WorkshopID IS NULL
      ORDER BY r.RegistrationDate DESC, r.RegistrationID DESC`,
  );

  const data: OrphanRegistrationRow[] = r.recordset.map((row) => ({
    registrationId: row.RegistrationID,
    participantId: row.ParticipantID,
    participantName: row.ParticipantID
      ? displayName({ firstName: row.FirstName, lastName: row.LastName })
      : null,
    participantEmail: row.Email,
    registrationDate: row.RegistrationDate
      ? row.RegistrationDate.toISOString().slice(0, 10)
      : null,
    paidAmount: row.PaidAmount === null ? null : Number(row.PaidAmount),
    isCancelled: row.IsCancelled === true,
    attended: row.Attended === true,
    source: row.Source,
    notes: row.Notes,
  }));

  const paid = data.filter((row) => (row.paidAmount ?? 0) !== 0);

  return {
    data,
    summary: {
      count: data.length,
      withPayment: paid.length,
      totalPaid: paid.reduce((sum, row) => sum + (row.paidAmount ?? 0), 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Overview and audit                                                 */
/* ------------------------------------------------------------------ */

export async function overview(): Promise<{
  duplicateGroups: number;
  duplicateParticipants: number;
  negativePayments: number;
  orphanRegistrations: number;
}> {
  const r = await query<{
    DuplicateGroups: number;
    DuplicateParticipants: number;
    NegativePayments: number;
    OrphanRegistrations: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM (
          SELECT 1 AS one FROM core.Participant p
           WHERE NULLIF(LTRIM(RTRIM(ISNULL(p.Email, ''))), '') IS NOT NULL
             AND NOT ${IS_EMPTY}
           GROUP BY LOWER(LTRIM(RTRIM(p.Email)))
          HAVING COUNT(*) > 1) g) AS DuplicateGroups,
       (SELECT ISNULL(SUM(cnt), 0) FROM (
          SELECT COUNT(*) AS cnt FROM core.Participant p
           WHERE NULLIF(LTRIM(RTRIM(ISNULL(p.Email, ''))), '') IS NOT NULL
             AND NOT ${IS_EMPTY}
           GROUP BY LOWER(LTRIM(RTRIM(p.Email)))
          HAVING COUNT(*) > 1) g2) AS DuplicateParticipants,
       (SELECT COUNT(*) FROM core.Registration WHERE PaidAmount < 0) AS NegativePayments,
       (SELECT COUNT(*) FROM core.Registration WHERE WorkshopID IS NULL) AS OrphanRegistrations`,
  );

  const row = r.recordset[0]!;
  return {
    duplicateGroups: row.DuplicateGroups,
    duplicateParticipants: row.DuplicateParticipants,
    negativePayments: row.NegativePayments,
    orphanRegistrations: row.OrphanRegistrations,
  };
}

export async function recordRun(input: {
  key: string;
  parameters: Record<string, unknown> | null;
  affectedRows: number;
  runBy: string;
  succeeded: boolean;
  error: string | null;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO audit.UtilityRun
              (UtilityKey, Parameters, AffectedRows, RunBy, Succeeded, Error)
       VALUES (@key, @params, @affected, @by, @ok, @err)`,
      {
        key: { type: sql.NVarChar(60), value: input.key },
        params: {
          type: sql.NVarChar(sql.MAX),
          value: input.parameters ? JSON.stringify(input.parameters) : null,
        },
        affected: { type: sql.Int, value: input.affectedRows },
        by: { type: sql.NVarChar(200), value: input.runBy },
        ok: { type: sql.Bit, value: input.succeeded ? 1 : 0 },
        err: { type: sql.NVarChar(1000), value: input.error },
      },
    );
  } catch (err) {
    // The audit row is important, but it must never turn a refused merge into
    // a 500: the admin would see "something went wrong" when the real answer
    // is "that merge is blocked". Log it loudly instead - a missing table
    // means migration 028 has not been applied to this database.
    console.error('[utilities] audit write failed:', (err as Error).message);
  }
}

export async function runs(key: string | undefined, limit: number): Promise<UtilityRunRow[]> {
  try {
    const r = await query<{
      UtilityRunID: number;
      UtilityKey: string;
      Parameters: string | null;
      AffectedRows: number;
      RunBy: string | null;
      RunAt: Date;
      Succeeded: boolean;
      Error: string | null;
    }>(
      `SELECT TOP (@limit) UtilityRunID, UtilityKey, Parameters, AffectedRows,
              RunBy, RunAt, Succeeded, Error
         FROM audit.UtilityRun
        ${key ? 'WHERE UtilityKey = @key' : ''}
        ORDER BY RunAt DESC, UtilityRunID DESC`,
      {
        limit: { type: sql.Int, value: limit },
        ...(key ? { key: { type: sql.NVarChar(60), value: key } } : {}),
      },
    );

    return r.recordset.map((row) => ({
      utilityRunId: row.UtilityRunID,
      utilityKey: row.UtilityKey,
      parameters: row.Parameters,
      affectedRows: row.AffectedRows,
      runBy: row.RunBy,
      runAt: row.RunAt.toISOString(),
      succeeded: row.Succeeded === true,
      error: row.Error,
    }));
  } catch (err) {
    // An empty history is the honest answer when the table is missing; a 500
    // would make the whole Utilities screen look broken. Logged, not hidden.
    console.error('[utilities] history read failed:', (err as Error).message);
    return [];
  }
}
