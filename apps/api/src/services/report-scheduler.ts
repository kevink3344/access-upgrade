import { REPORT_BY_KEY } from './reports.js';
import { sendAdminEmail } from './webhooks.js';
import {
  DATE_TOKENS,
  dayName,
  disable,
  dueToday,
  markSent,
  recordSend,
  resolveParams,
  summarise,
  type SubscriptionRow,
} from './report-subscriptions.js';

/**
 * The daily poll that emails due report subscriptions.
 *
 * Shape follows the existing timer in routes/public.ts: a `setInterval` on the
 * API process, `.unref()`ed so it never holds the process open. There is no
 * job host on the App Service, and a weekly digest does not need one.
 *
 * Two guards make it safe:
 *
 *  - `LastSentOn` means a restart or redeploy cannot send the same day twice.
 *  - `sp_getapplock` means a second instance cannot send while the first is
 *    working. Without it, scaling out would double every email.
 */

/** How often to look for due subscriptions. */
const POLL_MS = 15 * 60_000;

/** The workspace's local time, matching the calendar feed's assumption. */
const WORKSPACE_TZ = 'America/New_York';

/**
 * "Now" in the workspace's time zone, as a Date whose UTC fields are the
 * local wall-clock values. The scheduler compares `getUTCDay()` against
 * `DayOfWeek`, so this keeps "Friday" meaning Friday in Raleigh.
 */
export function workspaceNow(at: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORKSPACE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // `hour12: false` can report 24 for midnight in some ICU versions.
  const hour = get('hour') % 24;
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), hour));
}

/**
 * Runs one subscription and emails it.
 *
 * Returns what happened, so the caller can log and the tests can assert.
 */
export async function sendSubscription(
  sub: SubscriptionRow,
  now: Date,
): Promise<{ sent: boolean; reason?: string }> {
  const def = REPORT_BY_KEY.get(sub.reportKey);
  if (!def) {
    // A report removed from the registry leaves a subscription pointing at
    // nothing. Turn it off and say so, rather than skipping silently.
    await disable(
      sub.reportSubscriptionId,
      `The report "${sub.reportKey}" is no longer available, so this subscription was turned off.`,
    );
    await recordSend({
      id: sub.reportSubscriptionId,
      rows: null,
      succeeded: false,
      error: 'report-missing',
    });
    return { sent: false, reason: 'report-missing' };
  }

  const { params, description } = resolveParams(sub.params, now);

  let rows;
  try {
    rows = await def.run(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSend({ id: sub.reportSubscriptionId, rows: null, succeeded: false, error: message });
    return { sent: false, reason: 'report-failed' };
  }

  const summary = summarise(rows);
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) query.set(k, String(v));
  }
  const link = `/reports?report=${encodeURIComponent(def.key)}&${query.toString()}`;

  const body = [
    `Your report: ${def.title}`,
    '',
    description ? `Parameters: ${description}` : 'Parameters: current school year',
    summary,
    '',
    'Open the report in the app using the link below.',
  ].join('\n');

  const result = await sendAdminEmail({
    subject: `${def.title} — ${dayName(sub.dayOfWeek)} report`,
    body,
    linkPath: link,
  });

  if (!result.sent) {
    await recordSend({
      id: sub.reportSubscriptionId,
      rows: rows.length,
      succeeded: false,
      error: result.reason ?? result.error ?? 'send-failed',
    });
    return { sent: false, reason: result.reason ?? 'send-failed' };
  }

  await recordSend({ id: sub.reportSubscriptionId, rows: rows.length, succeeded: true, error: null });
  // Marked only after a successful send: marking first and failing would lose
  // the week silently.
  await markSent(sub.reportSubscriptionId, now);
  return { sent: true };
}

/** One poll: everything due today that has not been sent yet. */
export async function runDueSubscriptions(now: Date = workspaceNow()): Promise<{
  due: number;
  sent: number;
}> {
  const due = await dueToday(now);
  let sent = 0;
  for (const sub of due) {
    const r = await sendSubscription(sub, now);
    if (r.sent) sent++;
  }
  return { due: due.length, sent };
}

/**
 * Starts the poll. Safe to call once at boot.
 *
 * The app lock is taken around each poll so a second instance waits rather
 * than sending the same digest twice.
 */
export function startReportScheduler(): void {
  const tick = async () => {
    try {
      const now = workspaceNow();
      // Only send during the configured hour, so the digest arrives at the
      // time the subscriber chose rather than at the next poll after it.
      const due = await dueToday(now);
      const ready = due.filter((s) => s.sendHour <= now.getUTCHours());
      if (ready.length === 0) return;

      const { acquireLock, releaseLock } = await import('./app-lock.js');
      const locked = await acquireLock('report-subscriptions');
      if (!locked) return;
      try {
        await runDueSubscriptions(now);
      } finally {
        await releaseLock('report-subscriptions');
      }
    } catch (err) {
      console.error('[reports] scheduler error:', err instanceof Error ? err.message : err);
    }
  };

  // Poll on the same cadence as the rate-limit sweep; `.unref()` so a test
  // run or a CLI import never waits on it.
  setInterval(() => void tick(), POLL_MS).unref();
}

/** Exported for the tests: the tokens a subscription may store. */
export { DATE_TOKENS };
