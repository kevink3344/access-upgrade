import { describe, expect, it } from 'vitest';
import {
  MAX_BULK_SESSIONS,
  minutesOf,
  planBulkSessions,
  sessionCapacity,
  timeOf,
  validateSession,
} from '../src/services/sessions.js';

/**
 * Pure session rules. No database, so these run anywhere — including behind
 * a firewall with no access to the Azure SQL test database.
 */

describe('sessionCapacity', () => {
  it('prefers the session value over the workshop value', () => {
    expect(sessionCapacity(8, 40)).toBe(8);
  });

  it('falls back to the workshop when the session has none', () => {
    expect(sessionCapacity(null, 40)).toBe(40);
    expect(sessionCapacity(undefined, 40)).toBe(40);
  });

  it('is uncapped only when neither level states a limit', () => {
    expect(sessionCapacity(null, null)).toBeNull();
    expect(sessionCapacity(undefined, undefined)).toBeNull();
  });

  it('treats a session capacity of zero as a real limit, not a missing one', () => {
    expect(sessionCapacity(0, 40)).toBe(0);
  });
});

describe('time helpers', () => {
  it('parses HH:mm to minutes and back', () => {
    expect(minutesOf('10:00')).toBe(600);
    expect(minutesOf('00:00')).toBe(0);
    expect(minutesOf('23:59')).toBe(1439);
    expect(timeOf(600)).toBe('10:00');
    expect(timeOf(1439)).toBe('23:59');
  });

  it('rejects malformed or out-of-range times', () => {
    expect(minutesOf('24:00')).toBeNull();
    expect(minutesOf('10:60')).toBeNull();
    expect(minutesOf('1000')).toBeNull();
    expect(minutesOf('')).toBeNull();
    expect(minutesOf(null)).toBeNull();
  });

  it('wraps past midnight so a late session still has an end', () => {
    expect(timeOf(1440 + 60)).toBe('01:00');
  });
});

describe('validateSession', () => {
  it('accepts a session with no times — legacy rows are date only', () => {
    expect(validateSession({ startTime: null, endTime: null })).toBeNull();
  });

  it('accepts a normal window', () => {
    expect(validateSession({ startTime: '10:00', endTime: '11:00' })).toBeNull();
  });

  it('rejects an end time that is not after the start', () => {
    expect(validateSession({ startTime: '11:00', endTime: '10:00' })?.path).toBe('endTime');
    expect(validateSession({ startTime: '10:00', endTime: '10:00' })?.path).toBe('endTime');
  });

  it('rejects a malformed time', () => {
    expect(validateSession({ startTime: '9:00', endTime: '11:00' })?.path).toBe('startTime');
    expect(validateSession({ startTime: '10:00', endTime: '25:00' })?.path).toBe('endTime');
  });

  it('rejects a minimum above the maximum', () => {
    expect(validateSession({ minEnrollment: 12, maxEnrollment: 8 })?.path).toBe('minEnrollment');
    expect(validateSession({ minEnrollment: 8, maxEnrollment: 8 })).toBeNull();
  });

  it('ignores the min/max check when only one is set', () => {
    expect(validateSession({ minEnrollment: 12 })).toBeNull();
    expect(validateSession({ maxEnrollment: 8 })).toBeNull();
  });
});

describe('planBulkSessions', () => {
  it('lays three one-hour sessions back to back', () => {
    expect(planBulkSessions('10:00', 3, 60)).toEqual([
      { startTime: '10:00', endTime: '11:00' },
      { startTime: '11:00', endTime: '12:00' },
      { startTime: '12:00', endTime: '13:00' },
    ]);
  });

  it('honours a duration that is not a whole hour', () => {
    expect(planBulkSessions('09:00', 2, 90)).toEqual([
      { startTime: '09:00', endTime: '10:30' },
      { startTime: '10:30', endTime: '12:00' },
    ]);
  });

  it('caps the count so a typo cannot create hundreds of rows', () => {
    expect(planBulkSessions('10:00', 99, 60)).toHaveLength(MAX_BULK_SESSIONS);
  });

  it('returns nothing for an unparseable start time', () => {
    expect(planBulkSessions('nope', 3, 60)).toEqual([]);
  });

  it('returns nothing for a zero count', () => {
    expect(planBulkSessions('10:00', 0, 60)).toEqual([]);
  });
});
