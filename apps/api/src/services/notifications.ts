import { query, sql, type SqlParam } from '../db.js';
import { sendAdminEmail } from './webhooks.js';

/**
 * In-app notifications.
 *
 * Email is not wired up yet (blocked on Microsoft Graph credentials), so a
 * notification is a row the bell reads. Adding email later means hooking into
 * `createNotification`, not changing the call sites.
 */

export interface NotificationRow {
  NotificationID: number;
  Kind: string;
  Title: string;
  Body: string | null;
  LinkPath: string | null;
  WorkshopID: number | null;
  CreatedAt: Date;
  IsRead: boolean;
  IsArchived: boolean;
}

/** Roles that receive operational notifications. */
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

/* ------------------------------------------------------------------ */
/*  Switches                                                           */
/* ------------------------------------------------------------------ */

/**
 * On/off switches for notification types and delivery channels.
 *
 * Stored in `core.NotificationSetting`, one row per switch, and **a missing
 * row means on**. That default matters: a notification kind added in code is
 * live immediately without a matching INSERT, and if the settings table were
 * ever unreadable the system keeps alerting rather than going quiet.
 */
export type NotificationChannel = 'in-app' | 'email';

export function kindSettingKey(kind: string): string {
  return `kind:${kind}`;
}

export function channelSettingKey(channel: NotificationChannel): string {
  return `channel:${channel}`;
}

/** Every switch that has been set, keyed by SettingKey. Absent means on. */
export async function loadSettings(): Promise<Map<string, boolean>> {
  const r = await query<{ SettingKey: string; IsEnabled: boolean }>(
    'SELECT SettingKey, IsEnabled FROM core.NotificationSetting',
  );
  return new Map(r.recordset.map((row) => [row.SettingKey, row.IsEnabled === true]));
}

/** True unless the switch has been explicitly turned off. */
export async function isKindEnabled(kind: string): Promise<boolean> {
  const settings = await loadSettings();
  return settings.get(kindSettingKey(kind)) !== false;
}

/** True unless the channel has been explicitly turned off. */
export async function isChannelEnabled(channel: NotificationChannel): Promise<boolean> {
  const settings = await loadSettings();
  return settings.get(channelSettingKey(channel)) !== false;
}

/**
 * Sends the admin email for a notification, unless the email channel is off.
 *
 * Every notification goes through here rather than calling `sendAdminEmail`
 * directly, so the channel switch is honoured in one place. Fire-and-forget:
 * mail being down must never stop the in-app record from being written.
 */
async function emailAdmins(input: {
  subject: string;
  body: string;
  linkPath: string | null;
}): Promise<void> {
  if (!(await isChannelEnabled('email'))) return;
  void sendAdminEmail(input).catch((e: Error) => {
    console.error('[notifications] admin email failed:', e.message);
  });
}

/** Writes one switch. Upsert, so the first change on a default state works. */
export async function setSetting(
  key: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  await query(
    `MERGE core.NotificationSetting AS target
       USING (SELECT @key AS SettingKey) AS source
          ON target.SettingKey = source.SettingKey
     WHEN MATCHED THEN
       UPDATE SET IsEnabled = @enabled, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @by
     WHEN NOT MATCHED THEN
       INSERT (SettingKey, IsEnabled, UpdatedAt, UpdatedBy)
       VALUES (@key, @enabled, SYSUTCDATETIME(), @by);`,
    {
      key: { type: sql.NVarChar(80), value: key },
      enabled: { type: sql.Bit, value: enabled },
      by: { type: sql.NVarChar(200), value: updatedBy },
    },
  );
}

/**
 * Creates a notification and fans it out to every active admin.
 *
 * Returns null when there is nobody to notify, so callers can skip work.
 * Also returns null when the kind has been switched off in Settings — the
 * check lives here rather than at each call site so a new kind cannot forget
 * it, and so turning one off takes effect everywhere at once.
 */
export async function createNotification(input: {
  kind: string;
  title: string;
  body?: string | null;
  linkPath?: string | null;
  workshopId?: number | null;
}): Promise<number | null> {
  if (!(await isKindEnabled(input.kind))) return null;

  const recipients = await query<{ UserID: number }>(
    `SELECT UserID FROM core.AppUser
      WHERE IsActive = 1 AND Role IN (${ADMIN_ROLES.map((_, i) => `@r${i}`).join(', ')})`,
    Object.fromEntries(
      ADMIN_ROLES.map((role, i) => [`r${i}`, { type: sql.NVarChar(20), value: role }]),
    ),
  );

  if (recipients.recordset.length === 0) return null;

  const created = await query<{ id: number }>(
    `INSERT INTO core.Notification (Kind, Title, Body, LinkPath, WorkshopID)
     OUTPUT INSERTED.NotificationID AS id
     VALUES (@kind, @title, @body, @link, @wid)`,
    {
      kind: { type: sql.NVarChar(40), value: input.kind },
      title: { type: sql.NVarChar(200), value: input.title },
      body: { type: sql.NVarChar(1000), value: input.body ?? null },
      link: { type: sql.NVarChar(400), value: input.linkPath ?? null },
      wid: { type: sql.Int, value: input.workshopId ?? null },
    },
  );

  const notificationId = created.recordset[0]!.id;

  // One INSERT for all recipients rather than a loop.
  const params: Record<string, SqlParam> = {
    nid: { type: sql.Int, value: notificationId },
  };
  const values = recipients.recordset.map((r, i) => {
    params[`u${i}`] = { type: sql.Int, value: r.UserID };
    return `(@nid, @u${i})`;
  });

  await query(
    `INSERT INTO core.NotificationRecipient (NotificationID, UserID) VALUES ${values.join(', ')}`,
    params,
  );

  return notificationId;
}

/**
 * Checks whether a workshop has crossed its capacity threshold and, if so,
 * raises a notification exactly once.
 *
 * "Once" matters: without the NotifyFiredAt guard a 40-seat workshop would
 * raise an alert on every registration past 80%. The flag is cleared when the
 * workshop drops back below the threshold, so a later refill can alert again.
 *
 * Called after any registration change — manual or web — because staff need
 * to know either way.
 */
export async function checkWorkshopCapacity(workshopId: number): Promise<void> {
  const r = await query<{
    WorkshopID: number;
    WorkshopCode: string | null;
    WorkshopName: string | null;
    MaxEnrollment: number | null;
    NotifyPercentFull: number | null;
    NotifyFiredAt: Date | null;
    Registered: number;
  }>(
    `SELECT w.WorkshopID, w.WorkshopCode, n.WorkshopName,
            w.MaxEnrollment, w.NotifyPercentFull, w.NotifyFiredAt,
            (SELECT COUNT(*) FROM core.Registration r
              WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS Registered
       FROM core.Workshop w
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      WHERE w.WorkshopID = @id`,
    { id: { type: sql.Int, value: workshopId } },
  );

  const w = r.recordset[0];
  if (!w) return;

  // No capacity or no threshold means the feature is off for this workshop.
  if (!w.MaxEnrollment || w.MaxEnrollment <= 0) return;
  if (w.NotifyPercentFull === null) return;

  const percent = (w.Registered / w.MaxEnrollment) * 100;
  const crossed = percent >= w.NotifyPercentFull;

  if (!crossed) {
    // Dropped back below (a cancellation) — allow a future alert.
    if (w.NotifyFiredAt !== null) {
      await query(
        `UPDATE core.Workshop SET NotifyFiredAt = NULL WHERE WorkshopID = @id`,
        { id: { type: sql.Int, value: workshopId } },
      );
    }
    return;
  }

  if (w.NotifyFiredAt !== null) return;

  const label = w.WorkshopName ?? w.WorkshopCode ?? `Workshop ${w.WorkshopID}`;
  const pct = Math.round(percent);

  const title = `${label} is ${pct}% full`;
  const body = `${w.Registered} of ${w.MaxEnrollment} places taken. The alert threshold for this workshop is ${w.NotifyPercentFull}%.`;

  // The same destination as the in-app notification, so one alert does not
  // send staff to two different places.
  const linkPath = `/workshops?edit=${w.WorkshopID}`;

  await createNotification({
    kind: 'workshop-capacity',
    title,
    body,
    linkPath,
    workshopId: w.WorkshopID,
  });

  // The same alert also goes out by email, through whatever webhook declares
  // `notify_type: admin`. Fire-and-forget: a mail flow being down must not
  // stop the in-app notification above from being recorded, and must not
  // stop the fired flag below from being set — otherwise every subsequent
  // registration would retry the alert.
  void emailAdmins({ subject: title, body, linkPath });


  await query(
    `UPDATE core.Workshop SET NotifyFiredAt = SYSUTCDATETIME() WHERE WorkshopID = @id`,
    { id: { type: sql.Int, value: workshopId } },
  );
}

/**
 * Tells administrators that a School Cash upload has been applied.
 *
 * The apply screen shows its result once and then it is gone; this is the
 * record that survives. It is written after the transaction commits, so a
 * notification can never describe an apply that rolled back.
 *
 * The summary leads with what staff need to act on — rows still needing
 * review, and items with no workshop — because a bare "applied 13 payments"
 * reads as finished when it may not be.
 */
export async function notifySchoolCashApplied(input: {
  importId: number;
  fileName: string;
  applied: number;
  skipped: number;
  unresolved: number;
  needsReview: number;
  appliedBy: string;
  stillStaged: boolean;
}): Promise<number | null> {
  const payments = `${input.applied.toLocaleString()} payment${input.applied === 1 ? '' : 's'}`;

  const title = `School Cash: ${payments} applied from ${input.fileName}`;

  const parts: string[] = [`${input.appliedBy} applied ${payments}.`];
  if (input.skipped > 0) {
    parts.push(`${input.skipped} row${input.skipped === 1 ? '' : 's'} could not be applied.`);
  }
  if (input.needsReview > 0) {
    parts.push(
      `${input.needsReview} row${input.needsReview === 1 ? '' : 's'} still need review.`,
    );
  }
  if (input.unresolved > 0) {
    parts.push(
      `${input.unresolved} item${input.unresolved === 1 ? '' : 's'} had no workshop, so their rows were not matched.`,
    );
  }
  if (input.stillStaged) {
    parts.push('The upload stays staged so the remainder can be finished.');
  }

  const body = parts.join(' ');

  const notificationId = await createNotification({
    kind: 'school-cash-applied',
    title: title.slice(0, 200),
    body: body.slice(0, 1000),
    linkPath: `/school-cash?import=${input.importId}`,
  });

  // The same summary goes out by email, unless that channel is switched off.
  void emailAdmins({ subject: title, body, linkPath: `/school-cash?import=${input.importId}` });

  return notificationId;
}

/** Unread count for the bell badge. */
export async function unreadCount(userId: number): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM core.NotificationRecipient nr
       JOIN core.Notification n ON n.NotificationID = nr.NotificationID
      WHERE nr.UserID = @uid AND nr.ReadAt IS NULL AND nr.DismissedAt IS NULL`,
    { uid: { type: sql.Int, value: userId } },
  );
  return r.recordset[0]?.n ?? 0;
}

/**
 * Which slice of a user's notifications to return.
 *
 * `archived` is the inverse of the other two: archiving is the only state
 * that hides a row from both the bell and the default list, and it is
 * reversible, so it gets its own view rather than a separate endpoint.
 */
export type NotificationView = 'all' | 'unread' | 'archived';

const VIEW_FILTER: Record<NotificationView, string> = {
  all: 'nr.DismissedAt IS NULL',
  unread: 'nr.DismissedAt IS NULL AND nr.ReadAt IS NULL',
  archived: 'nr.DismissedAt IS NOT NULL',
};

/** Most recent notifications for one user. */
export async function listForUser(
  userId: number,
  limit = 20,
  opts: { offset?: number; view?: NotificationView } = {},
): Promise<NotificationRow[]> {
  const r = await query<NotificationRow>(
    `SELECT n.NotificationID, n.Kind, n.Title, n.Body, n.LinkPath, n.WorkshopID, n.CreatedAt,
            CASE WHEN nr.ReadAt IS NULL THEN 0 ELSE 1 END AS IsRead,
            CASE WHEN nr.DismissedAt IS NULL THEN 0 ELSE 1 END AS IsArchived
       FROM core.NotificationRecipient nr
       JOIN core.Notification n ON n.NotificationID = nr.NotificationID
      WHERE nr.UserID = @uid AND ${VIEW_FILTER[opts.view ?? 'all']}
      ORDER BY n.CreatedAt DESC, n.NotificationID DESC
     OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    {
      uid: { type: sql.Int, value: userId },
      limit: { type: sql.Int, value: limit },
      offset: { type: sql.Int, value: opts.offset ?? 0 },
    },
  );
  return r.recordset;
}

/** Total notifications for one user in a view, for the "view all" page's pager. */
export async function countForUser(
  userId: number,
  view: NotificationView = 'all',
): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM core.NotificationRecipient nr
      WHERE nr.UserID = @uid AND ${VIEW_FILTER[view]}`,
    { uid: { type: sql.Int, value: userId } },
  );
  return r.recordset[0]?.n ?? 0;
}
