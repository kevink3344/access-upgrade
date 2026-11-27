import { describe, expect, it } from 'vitest';
import {
  dayName,
  resolveParams,
  summarise,
} from '../src/services/report-subscriptions.js';
import { workspaceNow } from '../src/services/report-scheduler.js';

/**
 * The date tokens are the part of report subscriptions most likely to fail
 * quietly: a weekly report that repeats the same week forever looks fine in
 * the UI and is wrong in every email. These assertions pin what "last week"
 * means on a known Friday.
 */

// Friday 27 November 2026.
const FRIDAY = new Date('2026-11-27T12:00:00Z');

describe('resolveParams', () => {
  it('resolves last-7-days to the seven days before today', () => {
    const { params } = resolveParams({ from: 'last-7-days', to: 'last-7-days' }, FRIDAY);
    expect(params).toEqual({ from: '2026-11-20', to: '2026-11-26' });
  });

  it('resolves last-week to the previous Monday to Sunday', () => {
    const { params } = resolveParams({ from: 'last-week', to: 'last-week' }, FRIDAY);
    expect(params).toEqual({ from: '2026-11-16', to: '2026-11-22' });
  });

  it('resolves this-week to Monday through today', () => {
    const { params } = resolveParams({ from: 'this-week', to: 'this-week' }, FRIDAY);
    expect(params).toEqual({ from: '2026-11-23', to: '2026-11-27' });
  });

  it('gives a different range a week later', () => {
    const next = new Date('2026-12-04T12:00:00Z');
    const a = resolveParams({ from: 'last-7-days', to: 'last-7-days' }, FRIDAY).params;
    const b = resolveParams({ from: 'last-7-days', to: 'last-7-days' }, next).params;
    expect(a).not.toEqual(b);
  });

  it('leaves the school year unset for "current" so each report picks its own', () => {
    const { params } = resolveParams({ schoolYearId: 'current' }, FRIDAY);
    expect(params.schoolYearId).toBeUndefined();
  });

  it('passes a pinned school year through', () => {
    const { params } = resolveParams({ schoolYearId: 3 }, FRIDAY);
    expect(params.schoolYearId).toBe(3);
  });
});

describe('summarise', () => {
  it('totals the first numeric column', () => {
    expect(summarise([{ A: 'x', N: 3 }, { A: 'y', N: 4 }])).toBe('2 rows · N total 7.');
  });

  it('says so when there is no data', () => {
    expect(summarise([])).toBe('No data for this period.');
  });
});

describe('workspaceNow', () => {
  it('reports the workspace wall clock, not UTC', () => {
    // 12:00 UTC in late November is 07:00 in Raleigh.
    expect(workspaceNow(new Date('2026-11-27T12:00:00Z')).getUTCHours()).toBe(7);
  });

  it('rolls to the previous day when UTC is already tomorrow', () => {
    // 02:00 UTC on the 28th is still the evening of the 27th locally.
    const local = workspaceNow(new Date('2026-11-28T02:00:00Z'));
    expect(local.getUTCDate()).toBe(27);
    expect(local.getUTCHours()).toBe(21);
  });
});

describe('dayName', () => {
  it('maps the stored day number', () => {
    expect(dayName(5)).toBe('Friday');
  });
});
