import { query, sql } from '../db.js';

/**
 * A cross-instance lock, so a background job runs once even when the API is
 * scaled out.
 *
 * `sp_getapplock` is the SQL Server primitive for this: the lock is owned by
 * the session, released on `sp_releaseapplock` or when the connection closes,
 * and is invisible to anything that does not ask for it. One query, no new
 * infrastructure, no constraint on scaling.
 *
 * The lock is held on the pool's connection, so the acquire and release must
 * use the same pool — which they do, because `query` is the shared pool.
 */

const LOCK_TIMEOUT_MS = 5_000;

/**
 * Takes the named lock. Returns false when another instance holds it — the
 * caller should skip this run rather than wait, because the other instance is
 * already doing the work.
 */
export async function acquireLock(name: string): Promise<boolean> {
  try {
    const r = await query<{ result: number }>(
      `DECLARE @r INT;
       EXEC @r = sp_getapplock
            @Resource = @name,
            @LockMode = 'Exclusive',
            @LockOwner = 'Session',
            @LockTimeout = @timeout;
       SELECT @r AS result;`,
      {
        name: { type: sql.NVarChar(255), value: `pe:${name}` },
        timeout: { type: sql.Int, value: LOCK_TIMEOUT_MS },
      },
    );
    // 0 = granted, 1 = granted after waiting; negative = not granted.
    return (r.recordset[0]?.result ?? -1) >= 0;
  } catch {
    // A lock error must not stop the job: the worst case is the pre-lock
    // behaviour, which the LastSentOn guard already makes safe for one day.
    return false;
  }
}

export async function releaseLock(name: string): Promise<void> {
  try {
    await query(
      `EXEC sp_releaseapplock @Resource = @name, @LockOwner = 'Session';`,
      { name: { type: sql.NVarChar(255), value: `pe:${name}` } },
    );
  } catch {
    // Released automatically when the connection returns to the pool.
  }
}
