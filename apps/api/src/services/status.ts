import { query } from '../db.js';
import { env } from '../env.js';
import { pdfCapability } from './pdf.js';
import { REPORT_BY_KEY } from './reports.js';

/**
 * The checks behind the Developer > Status page.
 *
 * Each check answers one question a staff member would otherwise have to ask
 * a developer: is the database there, can we render a PDF, is mail getting
 * out, is the scheduler running, and is the deployment pointed at the right
 * database. A failure should be visible here *before* someone reports it.
 *
 * Nothing here is destructive, and nothing returns a secret: a path is fine,
 * a connection string is not.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface StatusCheck {
  key: string;
  label: string;
  status: CheckStatus;
  /** One line a non-developer can act on. */
  detail: string;
  /** Extra facts for whoever is debugging. */
  facts?: Record<string, string | number | boolean | null>;
  latencyMs?: number;
}

export interface StatusReport {
  overall: CheckStatus;
  checkedAt: string;
  uptimeSeconds: number;
  version: string;
  checks: StatusCheck[];
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}

async function checkDatabase(): Promise<StatusCheck> {
  const started = Date.now();
  try {
    const r = await query<{ Db: string; Edition: string }>(
      `SELECT DB_NAME() AS Db, CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)) AS Edition`,
    );
    const row = r.recordset[0];
    return {
      key: 'database',
      label: 'Database',
      status: 'ok',
      detail: `Connected to ${row?.Db ?? 'the database'}.`,
      facts: {
        database: row?.Db ?? null,
        edition: row?.Edition ?? null,
        mode: env.MODE || 'production',
      },
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      key: 'database',
      label: 'Database',
      status: 'fail',
      detail: 'The database is unreachable. Nothing that reads or saves data will work.',
      facts: { error: err instanceof Error ? err.message : String(err) },
      latencyMs: Date.now() - started,
    };
  }
}

async function checkPdf(): Promise<StatusCheck> {
  try {
    const cap = await pdfCapability();
    return {
      key: 'pdf',
      label: 'PDF rendering',
      status: cap.available ? 'ok' : 'warn',
      detail: cap.available
        ? 'Certificates, folder packets and report PDFs can be rendered.'
        : 'No browser found, so PDFs cannot be rendered. Certificates and folder packets will fail.',
      facts: { browserPath: cap.browserPath, searchedDirs: cap.searchedDirs.join('; ') },
    };
  } catch (err) {
    return {
      key: 'pdf',
      label: 'PDF rendering',
      status: 'warn',
      detail: 'The PDF renderer could not be checked.',
      facts: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function checkMail(): Promise<StatusCheck> {
  try {
    const r = await query<{
      Url: string | null;
      IsActive: boolean | null;
      LastAttempt: Date | null;
      LastSucceeded: boolean | null;
      LastError: string | null;
      Failures24h: number;
    }>(
      `SELECT TOP 1 w.Url, w.IsActive,
              d.AttemptedAt AS LastAttempt, d.Succeeded AS LastSucceeded, d.Error AS LastError,
              (SELECT COUNT(*) FROM core.WebhookDelivery x
                WHERE x.WebhookID = w.WebhookID AND x.Succeeded = 0
                  AND x.AttemptedAt > DATEADD(hour, -24, SYSUTCDATETIME())) AS Failures24h
         FROM core.Webhook w
         LEFT JOIN core.WebhookDelivery d
           ON d.WebhookDeliveryID = (
                SELECT TOP 1 WebhookDeliveryID FROM core.WebhookDelivery
                 WHERE WebhookID = w.WebhookID ORDER BY WebhookDeliveryID DESC)
        WHERE w.IsActive = 1
          AND w.JsonSchema LIKE '%notify_type%'
        ORDER BY w.WebhookID`,
    );

    const hook = r.recordset[0];
    if (!hook) {
      return {
        key: 'mail',
        label: 'Outbound email',
        status: 'warn',
        detail: 'No admin notification webhook is configured, so no email can be sent.',
        facts: { webhook: null },
      };
    }

    const failing = hook.LastSucceeded === false;
    return {
      key: 'mail',
      label: 'Outbound email',
      status: failing ? 'warn' : 'ok',
      detail: failing
        ? 'The last email attempt failed. Notifications and report subscriptions are not reaching staff.'
        : hook.LastAttempt
          ? 'The last delivery succeeded.'
          : 'Configured, but nothing has been sent yet.',
      facts: {
        webhook: hook.Url,
        lastAttempt: hook.LastAttempt ? hook.LastAttempt.toISOString() : null,
        lastError: hook.LastError,
        failuresLast24h: hook.Failures24h,
      },
    };
  } catch (err) {
    return {
      key: 'mail',
      label: 'Outbound email',
      status: 'warn',
      detail: 'The email webhook could not be checked.',
      facts: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function checkScheduler(): Promise<StatusCheck> {
  try {
    const r = await query<{
      Due: number;
      FailedLast24h: number;
      LastSent: Date | null;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM core.ReportSubscription
           WHERE IsActive = 1 AND DisabledReason IS NULL) AS Due,
         (SELECT COUNT(*) FROM core.ReportSubscriptionSend
           WHERE Succeeded = 0 AND SentAt > DATEADD(hour, -24, SYSUTCDATETIME())) AS FailedLast24h,
         (SELECT MAX(SentAt) FROM core.ReportSubscriptionSend WHERE Succeeded = 1) AS LastSent`,
    );
    const row = r.recordset[0];
    const failing = (row?.FailedLast24h ?? 0) > 0;
    return {
      key: 'scheduler',
      label: 'Report scheduler',
      status: failing ? 'warn' : 'ok',
      detail: failing
        ? `${row!.FailedLast24h} report subscription send(s) failed in the last 24 hours.`
        : 'Running. Subscriptions are checked every 15 minutes.',
      facts: {
        activeSubscriptions: row?.Due ?? 0,
        failuresLast24h: row?.FailedLast24h ?? 0,
        lastSuccessfulSend: row?.LastSent ? row.LastSent.toISOString() : null,
      },
    };
  } catch (err) {
    return {
      key: 'scheduler',
      label: 'Report scheduler',
      status: 'warn',
      detail: 'The scheduler could not be checked.',
      facts: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function checkData(): Promise<StatusCheck> {
  try {
    const r = await query<{ Workshops: number; Participants: number }>(
      `SELECT (SELECT COUNT(*) FROM core.Workshop) AS Workshops,
              (SELECT COUNT(*) FROM core.Participant) AS Participants`,
    );
    const row = r.recordset[0];
    return {
      key: 'data',
      label: 'Data',
      status: 'ok',
      detail: `${(row?.Workshops ?? 0).toLocaleString()} workshops and ${(row?.Participants ?? 0).toLocaleString()} participants.`,
      facts: { workshops: row?.Workshops ?? 0, participants: row?.Participants ?? 0 },
    };
  } catch (err) {
    return {
      key: 'data',
      label: 'Data',
      status: 'fail',
      detail: 'The core tables could not be read.',
      facts: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

function checkDeployment(): StatusCheck {
  const mode = env.MODE || null;
  const prodLike = !mode || /prod/i.test(mode);
  return {
    key: 'deployment',
    label: 'Deployment',
    status: 'ok',
    detail: mode
      ? `Running in ${mode} mode.`
      : 'No deployment label is set, so this looks like production.',
    facts: {
      mode,
      looksLikeProduction: prodLike,
      webOrigin: env.WEB_ORIGIN,
      nodeVersion: process.version,
      reports: REPORT_BY_KEY.size,
    },
  };
}

/** Runs every check and folds them into one verdict. */
export async function statusReport(): Promise<StatusReport> {
  const checks = await Promise.all([
    checkDatabase(),
    checkData(),
    checkPdf(),
    checkMail(),
    checkScheduler(),
  ]);
  checks.push(checkDeployment());

  return {
    overall: worst(checks.map((c) => c.status)),
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    version: process.env.npm_package_version ?? '0.1.0',
    checks,
  };
}
