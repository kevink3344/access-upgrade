import { query, sql } from '../db.js';
import { env } from '../env.js';

/**
 * Outbound webhooks triggered by app events.
 *
 * Separate from `routes/webhooks.ts`, which owns the CRUD and the manual
 * "send test" button. This module is the *sender*: it decides who receives an
 * event and what the body looks like, and records every attempt so a failing
 * endpoint is visible rather than silent.
 *
 * Nothing here throws. A webhook is a side channel — if it is down, the thing
 * that triggered it (a registration, a capacity check) must still succeed.
 */

/** Roles that count as "an admin" for notification purposes. */
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

export interface WebhookRow {
  WebhookID: number;
  Title: string;
  Url: string;
  PayloadFormat: string;
  Secret: string | null;
}

/**
 * The active webhook whose stored schema mentions `notifyType`.
 *
 * Matching on the schema rather than the title is deliberate: staff name
 * webhooks freely ("Email Notifications", "Admin mail"), but the schema is
 * what actually describes the payload. A webhook whose schema has no
 * `notify_type` property cannot be an admin-notification target, whatever it
 * is called.
 */
export async function findWebhookForNotifyType(notifyType: string): Promise<WebhookRow | null> {
  const r = await query<WebhookRow>(
    `SELECT WebhookID, Title, Url, PayloadFormat, Secret
       FROM core.Webhook
      WHERE IsActive = 1
        AND JsonSchema LIKE '%notify_type%'
      ORDER BY WebhookID`,
  );

  // Prefer one whose schema names this notify_type explicitly; fall back to
  // the first schema that has the field at all, since a single "email" hook
  // is the common case and its schema may not enumerate the values.
  for (const hook of r.recordset) {
    const full = await query<{ JsonSchema: string | null }>(
      'SELECT JsonSchema FROM core.Webhook WHERE WebhookID = @id',
      { id: { type: sql.Int, value: hook.WebhookID } },
    );
    const schema = full.recordset[0]?.JsonSchema ?? '';
    if (schema.includes(`"${notifyType}"`) || schema.includes(`'${notifyType}'`)) return hook;
  }

  return r.recordset[0] ?? null;
}

/**
 * Every active admin who has not opted out, as one semicolon-separated string.
 *
 * The receiving flow takes `email_to` as a single string, so this is the
 * shape it expects. Addresses are trimmed and de-duplicated; an admin with no
 * email on file is skipped rather than producing an empty entry.
 *
 * `ReceivesAdminEmail = 0` removes an admin from this list only. The in-app
 * bell is driven by the workshop's own threshold and is untouched, which is
 * what "opt out of the additional email" means.
 *
 * This is the single funnel for every admin notification email, so a future
 * notification type inherits the opt-out without changing this query.
 */
export async function adminEmailList(): Promise<string> {
  const r = await query<{ Email: string | null }>(
    `SELECT Email FROM core.AppUser
      WHERE IsActive = 1
        AND ReceivesAdminEmail = 1
        AND Role IN (${ADMIN_ROLES.map((_, i) => `@r${i}`).join(', ')})
      ORDER BY UserID`,
    Object.fromEntries(
      ADMIN_ROLES.map((role, i) => [`r${i}`, { type: sql.NVarChar(20), value: role }]),
    ),
  );

  const seen = new Set<string>();
  const emails: string[] = [];

  for (const row of r.recordset) {
    const email = row.Email?.trim();
    if (!email || !email.includes('@')) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }

  return emails.join('; ');
}

/**
 * Turns a route into an absolute URL on the deployed app.
 *
 * An email has no origin, so a relative `/workshops?edit=42` would be dead.
 * `WEB_ORIGIN` is the same value the API already uses for CORS, so the link
 * points at whichever environment sent the mail.
 */
export function absoluteLink(linkPath: string | null | undefined): string {
  const origin = env.WEB_ORIGIN.replace(/\/+$/, '');
  if (!linkPath) return origin;
  const path = linkPath.startsWith('/') ? linkPath : `/${linkPath}`;
  return `${origin}${path}`;
}

/** Records an attempt, so a failing endpoint shows up in the delivery log. */
async function recordDelivery(input: {
  webhookId: number;
  eventKind: string;
  payload: string;
  statusCode: number | null;
  succeeded: boolean;
  error: string | null;
  durationMs: number;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO core.WebhookDelivery
         (WebhookID, EventKind, Payload, StatusCode, Succeeded, Error, DurationMs)
       VALUES (@wid, @kind, @payload, @status, @ok, @err, @ms)`,
      {
        wid: { type: sql.Int, value: input.webhookId },
        kind: { type: sql.NVarChar(40), value: input.eventKind },
        payload: { type: sql.NVarChar(sql.MAX), value: input.payload },
        status: { type: sql.Int, value: input.statusCode },
        ok: { type: sql.Bit, value: input.succeeded ? 1 : 0 },
        err: { type: sql.NVarChar(1000), value: input.error },
        ms: { type: sql.Int, value: input.durationMs },
      },
    );
  } catch (e) {
    console.error('[webhook] could not record delivery:', (e as Error).message);
  }
}

/** POSTs a payload and never throws — the caller records the outcome. */
async function postWebhook(
  url: string,
  payload: unknown,
  secret: string | null,
): Promise<{ statusCode: number | null; ok: boolean; error: string | null; durationMs: number }> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Webhook-Secret': secret } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return {
      statusCode: res.status,
      ok: res.ok,
      error: res.ok ? null : `Endpoint returned ${res.status}`,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      statusCode: null,
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 1000) : 'Request failed',
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Sends an admin email notification through the matching webhook.
 *
 * Returns what happened rather than throwing, so the caller can log it and
 * carry on. Returns `{ sent: false, reason: 'no-webhook' }` when no active
 * webhook declares a `notify_type` — that is a configuration state, not an
 * error, and it must not look like a failure in the delivery log.
 *
 * `linkPath` is a route on this app, e.g. `/workshops?edit=42`. It is turned
 * into an absolute URL here, because an email has no origin to resolve a
 * relative link against. Defaults to the app root when the caller has no
 * specific destination.
 */
export async function sendAdminEmail(input: {
  subject: string;
  body: string;
  linkPath?: string | null;
}): Promise<{ sent: boolean; reason?: string; statusCode?: number | null; error?: string | null }> {
  const hook = await findWebhookForNotifyType('admin');
  if (!hook) return { sent: false, reason: 'no-webhook' };

  const emailTo = await adminEmailList();
  if (!emailTo) return { sent: false, reason: 'no-admin-emails' };

  // The body is the flat shape the receiving flow expects — not the
  // { event, sentAt, data } envelope the manual test uses, because that
  // envelope is this app's own convention and the flow reads named fields.
  const payload = {
    notify_type: 'admin',
    email_to: emailTo,
    email_subject: input.subject,
    email_body: input.body,
    app_link: absoluteLink(input.linkPath),
  };

  const result = await postWebhook(hook.Url, payload, hook.Secret);

  await recordDelivery({
    webhookId: hook.WebhookID,
    eventKind: 'admin-email',
    payload: JSON.stringify(payload),
    statusCode: result.statusCode,
    succeeded: result.ok,
    error: result.error,
    durationMs: result.durationMs,
  });

  return { sent: result.ok, statusCode: result.statusCode, error: result.error };
}
