import { query, sql } from '../db.js';
import { REPORT_BY_KEY, type ReportParams, type ReportRow } from './reports.js';

/**
 * Scheduled report subscriptions.
 *
 * A subscription stores which report, with which parameters, on which
 * weekday. The parameters are stored as JSON, and date parameters are stored
 * as **tokens** rather than literal dates — see `resolveParams`. Storing a
 * literal `from`/`to` would make a "weekly" report repeat the same week
 * forever, which is the most likely way this feature would fail in practice.
 *
 * Docs: docs/plans/report-subscriptions.md
 */

/** Date tokens a subscription may store in place of a literal date. */
export const DATE_TOKENS = ['last-7-days', 'last-week', 'this-week'] as const;
export type DateToken = (typeof DATE_TOKENS)[number];

/**
 * What a subscription stores. `schoolYearId` may be a number (pinned) or the
 * token `current`, which resolves to the newest school year at send time.
 */
export interface SubscriptionParams {
  schoolYearId?: number | 'current';
  from?: DateToken;
  to?: DateToken;
  categoryId?: number;
  workshopId?: number;
}

export interface SubscriptionRow {
  reportSubscriptionId: number;
  userId: number;
  reportKey: string;
  reportTitle: string;
  params: SubscriptionParams;
  dayOfWeek: number;
  sendHour: number;
  isActive: boolean;
  lastSentOn: string | null;
  disabledReason: string | null;
  createdAt: string;
  /** The most recent delivery, so the UI can show whether it worked. */
  lastSend: {
    sentAt: string;
    rowsInReport: number | null;
    succeeded: boolean;
    error: string | null;
  } | null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayName(day: number): string {
  return DAY_NAMES[day] ?? 'Unknown';
}

/** `YYYY-MM-DD` for a Date, in UTC. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Resolves a stored parameter set into the one the report should run with
 * **today**.
 *
 * `now` is the workspace's local date, passed in so the scheduler and the
 * tests agree on what "today" means.
 */
export function resolveParams(
  stored: SubscriptionParams,
  now: Date,
): { params: ReportParams; description: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const params: ReportParams = {};
  const parts: string[] = [];

  if (typeof stored.schoolYearId === 'number') {
    params.schoolYearId = stored.schoolYearId;
  } else if (stored.schoolYearId === 'current') {
    // Left unset: each report already defaults to the newest year it can
    // produce rows for, which is what "current" means here.
    parts.push('current school year');
  }

  if (stored.categoryId) params.categoryId = stored.categoryId;
  if (stored.workshopId) params.workshopId = stored.workshopId;

  const range = (token: DateToken | undefined): { from: string; to: string } | null => {
    switch (token) {
      case 'last-7-days':
        return { from: isoDate(addDays(today, -7)), to: isoDate(addDays(today, -1)) };
      case 'last-week': {
        // The previous Monday to Sunday. getUTCDay(): 0 = Sunday.
        const dow = today.getUTCDay();
        const mondayThisWeek = addDays(today, -((dow + 6) % 7));
        return { from: isoDate(addDays(mondayThisWeek, -7)), to: isoDate(addDays(mondayThisWeek, -1)) };
      }
      case 'this-week': {
        const dow = today.getUTCDay();
        const mondayThisWeek = addDays(today, -((dow + 6) % 7));
        return { from: isoDate(mondayThisWeek), to: isoDate(today) };
      }
      default:
        return null;
    }
  };

  const r = range(stored.from ?? stored.to);
  if (r) {
    params.from = r.from;
    params.to = r.to;
    parts.push(`${r.from} to ${r.to}`);
  }

  return { params, description: parts.join(' · ') };
}

/** A one-line summary of the rows, so the email is useful even unopened. */
export function summarise(rows: ReportRow[]): string {
  if (rows.length === 0) return 'No data for this period.';
  const first = rows[0]!;
  // The first numeric column is the count the report exists to show.
  const numericKey = Object.keys(first).find((k) => typeof first[k] === 'number');
  if (!numericKey) return `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}.`;
  const total = rows.reduce((n, row) => n + (typeof row[numericKey] === 'number' ? (row[numericKey] as number) : 0), 0);
  return `${rows.length} ${rows.length === 1 ? 'row' : 'rows'} · ${numericKey} total ${total}.`;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

interface RawRow {
  ReportSubscriptionID: number;
  UserID: number;
  ReportKey: string;
  ParamsJson: string | null;
  DayOfWeek: number;
  SendHour: number;
  IsActive: boolean;
  LastSentOn: Date | null;
  DisabledReason: string | null;
  CreatedAt: Date;
  SentAt: Date | null;
  RowsInReport: number | null;
  Succeeded: boolean | null;
  Error: string | null;
}

function parseParams(raw: string | null): SubscriptionParams {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as SubscriptionParams) : {};
  } catch {
    return {};
  }
}

function toRow(x: RawRow): SubscriptionRow {
  return {
    reportSubscriptionId: x.ReportSubscriptionID,
    userId: x.UserID,
    reportKey: x.ReportKey,
    reportTitle: REPORT_BY_KEY.get(x.ReportKey)?.title ?? x.ReportKey,
    params: parseParams(x.ParamsJson),
    dayOfWeek: x.DayOfWeek,
    sendHour: x.SendHour,
    isActive: x.IsActive,
    lastSentOn: x.LastSentOn ? isoDate(x.LastSentOn) : null,
    disabledReason: x.DisabledReason,
    createdAt: x.CreatedAt.toISOString(),
    lastSend: x.SentAt
      ? {
          sentAt: x.SentAt.toISOString(),
          rowsInReport: x.RowsInReport,
          succeeded: x.Succeeded === true,
          error: x.Error,
        }
      : null,
  };
}

const SELECT_COLUMNS = `
  s.ReportSubscriptionID, s.UserID, s.ReportKey, s.ParamsJson, s.DayOfWeek, s.SendHour,
  s.IsActive, s.LastSentOn, s.DisabledReason, s.CreatedAt,
  d.SentAt, d.RowsInReport, d.Succeeded, d.Error`;

/** The most recent delivery per subscription, joined in. */
const LATEST_SEND_JOIN = `
  LEFT JOIN core.ReportSubscriptionSend d
    ON d.ReportSubscriptionSendID = (
         SELECT TOP 1 ReportSubscriptionSendID
           FROM core.ReportSubscriptionSend
          WHERE ReportSubscriptionID = s.ReportSubscriptionID
          ORDER BY ReportSubscriptionSendID DESC)`;

/** One user's subscriptions, newest first. */
export async function listForUser(userId: number): Promise<SubscriptionRow[]> {
  const r = await query<RawRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM core.ReportSubscription s
       ${LATEST_SEND_JOIN}
      WHERE s.UserID = @uid
      ORDER BY s.CreatedAt DESC`,
    { uid: { type: sql.Int, value: userId } },
  );
  return r.recordset.map(toRow);
}

/** One subscription, or null. Scoped to the owner so a path id cannot reach another user's row. */
export async function getForUser(id: number, userId: number): Promise<SubscriptionRow | null> {
  const r = await query<RawRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM core.ReportSubscription s
       ${LATEST_SEND_JOIN}
      WHERE s.ReportSubscriptionID = @id AND s.UserID = @uid`,
    {
      id: { type: sql.Int, value: id },
      uid: { type: sql.Int, value: userId },
    },
  );
  const row = r.recordset[0];
  return row ? toRow(row) : null;
}

/** Every subscription due today that has not already been sent. */
export async function dueToday(now: Date): Promise<SubscriptionRow[]> {
  const r = await query<RawRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM core.ReportSubscription s
       ${LATEST_SEND_JOIN}
      WHERE s.IsActive = 1
        AND s.DisabledReason IS NULL
        AND s.DayOfWeek = @dow
        AND (s.LastSentOn IS NULL OR s.LastSentOn <> @today)
      ORDER BY s.ReportSubscriptionID`,
    {
      dow: { type: sql.TinyInt, value: now.getUTCDay() },
      today: { type: sql.Date, value: isoDate(now) },
    },
  );
  return r.recordset.map(toRow);
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

export async function create(input: {
  userId: number;
  reportKey: string;
  params: SubscriptionParams;
  dayOfWeek: number;
  sendHour: number;
  createdBy: string;
}): Promise<number> {
  // Upsert on (user, report, params): subscribing twice with the same filters
  // changes the day rather than creating a second email.
  const r = await query<{ id: number }>(
    `MERGE core.ReportSubscription AS target
       USING (SELECT @uid AS UserID, @key AS ReportKey,
                     CONVERT(CHAR(64), HASHBYTES('SHA2_256', ISNULL(@params, '')), 2) AS ParamsHash) AS src
          ON target.UserID = src.UserID
         AND target.ReportKey = src.ReportKey
         AND target.ParamsHash = src.ParamsHash
     WHEN MATCHED THEN
       UPDATE SET DayOfWeek = @dow, SendHour = @hour, IsActive = 1,
                  DisabledReason = NULL, LastSentOn = NULL
     WHEN NOT MATCHED THEN
       INSERT (UserID, ReportKey, ParamsJson, DayOfWeek, SendHour, IsActive, CreatedBy)
       VALUES (@uid, @key, @params, @dow, @hour, 1, @by)
     OUTPUT INSERTED.ReportSubscriptionID AS id;`,
    {
      uid: { type: sql.Int, value: input.userId },
      key: { type: sql.NVarChar(60), value: input.reportKey },
      params: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(input.params) },
      dow: { type: sql.TinyInt, value: input.dayOfWeek },
      hour: { type: sql.TinyInt, value: input.sendHour },
      by: { type: sql.NVarChar(200), value: input.createdBy },
    },
  );
  return r.recordset[0]!.id;
}

export async function update(
  id: number,
  userId: number,
  patch: { dayOfWeek?: number; sendHour?: number; isActive?: boolean },
): Promise<boolean> {
  const sets: string[] = [];
  const params: Record<string, { type: sql.ISqlTypeFactoryWithNoParams; value: unknown }> = {
    id: { type: sql.Int, value: id },
    uid: { type: sql.Int, value: userId },
  };

  if (patch.dayOfWeek !== undefined) {
    sets.push('DayOfWeek = @dow');
    params.dow = { type: sql.TinyInt, value: patch.dayOfWeek };
  }
  if (patch.sendHour !== undefined) {
    sets.push('SendHour = @hour');
    params.hour = { type: sql.TinyInt, value: patch.sendHour };
  }
  if (patch.isActive !== undefined) {
    sets.push('IsActive = @active');
    params.active = { type: sql.Bit, value: patch.isActive ? 1 : 0 };
  }
  if (sets.length === 0) return true;

  const r = await query(
    `UPDATE core.ReportSubscription SET ${sets.join(', ')}
      OUTPUT INSERTED.ReportSubscriptionID
      WHERE ReportSubscriptionID = @id AND UserID = @uid`,
    params,
  );
  return r.recordset.length > 0;
}

export async function remove(id: number, userId: number): Promise<boolean> {
  const r = await query(
    `DELETE FROM core.ReportSubscription
      OUTPUT DELETED.ReportSubscriptionID
      WHERE ReportSubscriptionID = @id AND UserID = @uid`,
    {
      id: { type: sql.Int, value: id },
      uid: { type: sql.Int, value: userId },
    },
  );
  return r.recordset.length > 0;
}

/** Marks the day it fired. Called only after a successful send. */
export async function markSent(id: number, day: Date): Promise<void> {
  await query(
    `UPDATE core.ReportSubscription SET LastSentOn = @day WHERE ReportSubscriptionID = @id`,
    {
      id: { type: sql.Int, value: id },
      day: { type: sql.Date, value: isoDate(day) },
    },
  );
}

export async function disable(id: number, reason: string): Promise<void> {
  await query(
    `UPDATE core.ReportSubscription SET IsActive = 0, DisabledReason = @reason
      WHERE ReportSubscriptionID = @id`,
    {
      id: { type: sql.Int, value: id },
      reason: { type: sql.NVarChar(300), value: reason },
    },
  );
}

export async function recordSend(input: {
  id: number;
  rows: number | null;
  succeeded: boolean;
  error: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO core.ReportSubscriptionSend
       (ReportSubscriptionID, RowsInReport, Succeeded, Error)
     VALUES (@id, @rows, @ok, @err)`,
    {
      id: { type: sql.Int, value: input.id },
      rows: { type: sql.Int, value: input.rows },
      ok: { type: sql.Bit, value: input.succeeded ? 1 : 0 },
      err: { type: sql.NVarChar(1000), value: input.error },
    },
  );
}
