import { createHash, randomBytes } from 'node:crypto';
import { query, sql } from '../db.js';

/**
 * The workshop calendar feed's switch and secret.
 *
 * Both live in `core.NotificationSetting`, which already holds the other
 * workspace-wide on/off settings. The feed gets its own key rather than
 * reusing `channel:` or `kind:` so the notification keys keep meaning what
 * they meant.
 *
 * The secret is stored only as a SHA-256 hash. Google's calendar fetcher
 * cannot present a bearer token, so the URL is the credential — and a hash
 * means a database dump cannot be replayed against the endpoint. The
 * plaintext is returned to the administrator once, when the feed is switched
 * on or the link is regenerated.
 */

export const FEED_SETTING_KEY = 'calendar:workshop-feed';

export interface FeedState {
  enabled: boolean;
  /** True once a link has been issued. The link itself is never returned. */
  hasLink: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A 256-bit URL-safe secret. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

interface FeedRow {
  IsEnabled: boolean;
  SecretHash: string | null;
  UpdatedAt: Date | null;
  UpdatedBy: string | null;
}

async function readRow(): Promise<FeedRow | null> {
  const r = await query<FeedRow>(
    `SELECT IsEnabled, SecretHash, UpdatedAt, UpdatedBy
       FROM core.NotificationSetting
      WHERE SettingKey = @key`,
    { key: { type: sql.NVarChar(80), value: FEED_SETTING_KEY } },
  );
  return r.recordset[0] ?? null;
}

/**
 * Current state for the settings screen.
 *
 * A missing row means the feed is off — the opposite of the notification
 * default. A public feed must never appear because a row failed to be
 * written, so the safe default is the closed one.
 */
export async function getFeedState(): Promise<FeedState> {
  const row = await readRow();
  return {
    enabled: row?.IsEnabled === true,
    hasLink: !!row?.SecretHash,
    updatedAt: row?.UpdatedAt ? row.UpdatedAt.toISOString() : null,
    updatedBy: row?.UpdatedBy ?? null,
  };
}

/** Writes the row, keeping any existing hash when `secretHash` is omitted. */
async function write(
  enabled: boolean,
  updatedBy: string,
  secretHash?: string,
): Promise<void> {
  await query(
    `MERGE core.NotificationSetting AS target
       USING (SELECT @key AS SettingKey) AS source
          ON target.SettingKey = source.SettingKey
     WHEN MATCHED THEN
       UPDATE SET IsEnabled  = @enabled,
                  SecretHash = COALESCE(@hash, target.SecretHash),
                  UpdatedAt  = SYSUTCDATETIME(),
                  UpdatedBy  = @by
     WHEN NOT MATCHED THEN
       INSERT (SettingKey, IsEnabled, SecretHash, UpdatedAt, UpdatedBy)
       VALUES (@key, @enabled, @hash, SYSUTCDATETIME(), @by);`,
    {
      key: { type: sql.NVarChar(80), value: FEED_SETTING_KEY },
      enabled: { type: sql.Bit, value: enabled },
      hash: { type: sql.Char(64), value: secretHash ?? null },
      by: { type: sql.NVarChar(200), value: updatedBy },
    },
  );
}

/**
 * Switches the feed on or off.
 *
 * Switching on with no link issues one, so the administrator never has to
 * make two trips. Switching off keeps the link, so turning it back on
 * restores the calendar staff already subscribed to instead of silently
 * breaking it.
 *
 * Returns the plaintext token only when one was just created.
 */
export async function setFeedEnabled(
  enabled: boolean,
  updatedBy: string,
): Promise<{ token: string | null }> {
  const row = await readRow();

  if (!enabled) {
    await write(false, updatedBy);
    return { token: null };
  }

  if (row?.SecretHash) {
    await write(true, updatedBy);
    return { token: null };
  }

  const token = newToken();
  await write(true, updatedBy, hashToken(token));
  return { token };
}

/**
 * Issues a new link, invalidating the old one.
 *
 * This is the remedy for a URL that has been shared too widely: existing
 * subscribers stop receiving updates until they are given the new URL.
 */
export async function regenerateLink(updatedBy: string): Promise<{ token: string }> {
  const token = newToken();
  const row = await readRow();
  await write(row?.IsEnabled === true, updatedBy, hashToken(token));
  return { token };
}

/** True when a presented token matches the stored hash and the feed is on. */
export async function isFeedTokenValid(token: string): Promise<boolean> {
  if (!token) return false;

  const r = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM core.NotificationSetting
      WHERE SettingKey = @key
        AND IsEnabled = 1
        AND SecretHash = @hash`,
    {
      key: { type: sql.NVarChar(80), value: FEED_SETTING_KEY },
      hash: { type: sql.Char(64), value: hashToken(token) },
    },
  );

  return (r.recordset[0]?.n ?? 0) > 0;
}
