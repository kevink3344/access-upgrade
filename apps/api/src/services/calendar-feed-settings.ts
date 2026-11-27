import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { query, sql } from '../db.js';
import { env } from '../env.js';

/**
 * The workshop calendar feed's switch and secret.
 *
 * Both live in `core.NotificationSetting`, which already holds the other
 * workspace-wide on/off settings. The feed gets its own key rather than
 * reusing `channel:` or `kind:` so the notification keys keep meaning what
 * they meant.
 *
 * Google's calendar fetcher cannot present a bearer token, so the URL is the
 * credential. Two forms of it are stored:
 *
 *  - `SecretHash` is what the public feed checks. A database dump cannot be
 *    replayed against the endpoint from it.
 *  - `SecretEncrypted` is the same token, sealed with AES-256-GCM under a key
 *    derived from `JWT_SECRET`, so the settings screen can show the current
 *    link. A hash cannot be read back, and staff were issuing a new link —
 *    breaking every existing subscriber — just to see the URL again.
 *
 * The hash remains the only thing the feed trusts, so the endpoint's
 * behaviour is unchanged.
 */

export const FEED_SETTING_KEY = 'calendar:workshop-feed';

export interface FeedState {
  enabled: boolean;
  /** True once a link has been issued. */
  hasLink: boolean;
  /**
   * The subscription token, decrypted from `SecretEncrypted`, or null when
   * no link exists or it predates migration 033. Server-side only — the
   * route turns it into a URL for signed-in administrators.
   */
  token: string | null;
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

/**
 * Key for the sealed token, derived from the app secret.
 *
 * A separate derivation means the JWT signing key itself is never used as an
 * encryption key, and rotating `JWT_SECRET` invalidates sealed links rather
 * than silently reusing a key for a different purpose.
 */
function sealKey(): Buffer {
  return createHash('sha256').update(`calendar-feed:${env.JWT_SECRET}`).digest();
}

/** Seals a token as `iv.tag.ciphertext`, all base64url. */
export function sealToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((b) => b.toString('base64url'))
    .join('.');
}

/**
 * Opens a sealed token. Returns null when the value is missing, malformed or
 * was sealed under a different key — the caller then treats the link as
 * unreadable and offers to issue a new one.
 */
export function openToken(sealed: string | null): string | null {
  if (!sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;

  try {
    const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', sealKey(), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

interface FeedRow {
  IsEnabled: boolean;
  SecretHash: string | null;
  SecretEncrypted: string | null;
  UpdatedAt: Date | null;
  UpdatedBy: string | null;
}

async function readRow(): Promise<FeedRow | null> {
  const r = await query<FeedRow>(
    `SELECT IsEnabled, SecretHash, SecretEncrypted, UpdatedAt, UpdatedBy
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
    // Null for a link issued before migration 033: only the hash exists, so
    // the screen offers to issue a new one instead of showing a blank.
    token: openToken(row?.SecretEncrypted ?? null),
    updatedAt: row?.UpdatedAt ? row.UpdatedAt.toISOString() : null,
    updatedBy: row?.UpdatedBy ?? null,
  };
}

/**
 * Writes the row, keeping any existing secret when `secret` is omitted.
 *
 * The hash and the sealed copy are written together so they cannot drift
 * apart: the hash is what the feed checks, the sealed copy is what the
 * screen shows.
 */
async function write(
  enabled: boolean,
  updatedBy: string,
  secret?: { hash: string; sealed: string },
): Promise<void> {
  await query(
    `MERGE core.NotificationSetting AS target
       USING (SELECT @key AS SettingKey) AS source
          ON target.SettingKey = source.SettingKey
     WHEN MATCHED THEN
       UPDATE SET IsEnabled       = @enabled,
                  SecretHash      = COALESCE(@hash, target.SecretHash),
                  SecretEncrypted = COALESCE(@sealed, target.SecretEncrypted),
                  UpdatedAt       = SYSUTCDATETIME(),
                  UpdatedBy       = @by
     WHEN NOT MATCHED THEN
       INSERT (SettingKey, IsEnabled, SecretHash, SecretEncrypted, UpdatedAt, UpdatedBy)
       VALUES (@key, @enabled, @hash, @sealed, SYSUTCDATETIME(), @by);`,
    {
      key: { type: sql.NVarChar(80), value: FEED_SETTING_KEY },
      enabled: { type: sql.Bit, value: enabled },
      hash: { type: sql.Char(64), value: secret?.hash ?? null },
      sealed: { type: sql.NVarChar(400), value: secret?.sealed ?? null },
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
 * Returns the token only when one was just created. A link issued before
 * migration 033 has a hash but no sealed copy; it is left alone, because
 * re-sealing it would mean knowing the plaintext, which by definition was
 * never stored.
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
  await write(true, updatedBy, { hash: hashToken(token), sealed: sealToken(token) });
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
  await write(row?.IsEnabled === true, updatedBy, {
    hash: hashToken(token),
    sealed: sealToken(token),
  });
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
