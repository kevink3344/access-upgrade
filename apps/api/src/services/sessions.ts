/**
 * Session rules shared by the workshop routes and their tests.
 *
 * Kept free of database access so the validation and the capacity fallback
 * can be unit-tested without a live SQL Server.
 */

/** Hard ceiling on the "add several sessions" helper. */
export const MAX_BULK_SESSIONS = 12;

/** Minutes since midnight for an `HH:mm` string, or null when it does not parse. */
export function minutesOf(time: string | null | undefined): number | null {
  if (!time) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** `HH:mm` for minutes since midnight. Wraps past midnight, as a session may. */
export function timeOf(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Effective capacity for a session.
 *
 * A session with its own MaxEnrollment uses it. A session without one
 * inherits the workshop's, so a workshop that never adopted per-session
 * capacity behaves exactly as it does today.
 */
export function sessionCapacity(
  sessionMax: number | null | undefined,
  workshopMax: number | null | undefined,
): number | null {
  if (sessionMax !== null && sessionMax !== undefined) return sessionMax;
  if (workshopMax !== null && workshopMax !== undefined) return workshopMax;
  return null;
}

export interface SessionValidationInput {
  startTime?: string | null;
  endTime?: string | null;
  minEnrollment?: number | null;
  maxEnrollment?: number | null;
}

/**
 * Cross-field session rules. Returns the first problem as a field/message
 * pair, or null when the input is consistent.
 *
 * A session with no times is valid — it is "date only", which is what every
 * legacy row is.
 */
export function validateSession(input: SessionValidationInput): {
  path: string;
  message: string;
} | null {
  const start = minutesOf(input.startTime);
  const end = minutesOf(input.endTime);

  if (input.startTime && start === null) {
    return { path: 'startTime', message: 'Start time must be HH:mm' };
  }
  if (input.endTime && end === null) {
    return { path: 'endTime', message: 'End time must be HH:mm' };
  }

  // A session ending after midnight is allowed to wrap; anything else that
  // does not move forward is a mistake.
  if (start !== null && end !== null && end <= start) {
    return { path: 'endTime', message: 'End time must be after the start time' };
  }

  if (
    input.minEnrollment !== null &&
    input.minEnrollment !== undefined &&
    input.maxEnrollment !== null &&
    input.maxEnrollment !== undefined &&
    input.minEnrollment > input.maxEnrollment
  ) {
    return { path: 'minEnrollment', message: 'Minimum cannot exceed the maximum' };
  }

  return null;
}

/**
 * Sessions the repeat helper will create, back to back from `startTime`.
 *
 * Returns the requested count, clamped to MAX_BULK_SESSIONS. Each entry is a
 * plain start/end pair; the caller inserts them as independent rows.
 */
export function planBulkSessions(
  startTime: string,
  count: number,
  durationMinutes: number,
): Array<{ startTime: string; endTime: string }> {
  const start = minutesOf(startTime);
  if (start === null) return [];

  const n = Math.min(Math.max(Math.trunc(count), 0), MAX_BULK_SESSIONS);
  const out: Array<{ startTime: string; endTime: string }> = [];

  for (let i = 0; i < n; i += 1) {
    const from = start + i * durationMinutes;
    out.push({ startTime: timeOf(from), endTime: timeOf(from + durationMinutes) });
  }

  return out;
}
