import { describe, expect, it } from 'vitest';
import {
  buildCalendar,
  escapeText,
  foldLine,
  parseTimesText,
  utcStamp,
  workshopEvents,
  type FeedOptions,
  type FeedWorkshop,
} from '../src/services/calendar-feed.js';

/**
 * The iCalendar rules, with no database.
 *
 * A malformed feed is rejected by Google Calendar silently — it simply shows
 * nothing — so the formatting details (folding, escaping, the exclusive
 * DTEND of an all-day event) are worth asserting directly.
 */

const NOW = new Date('2026-11-26T16:00:00Z');

const OPTIONS: FeedOptions = {
  uidDomain: 'example.test',
  calendarName: 'Project Enlightenment — Workshops',
  appUrl: 'https://training.example.test',
  now: NOW,
  refreshInterval: 'PT1H',
};

function workshop(overrides: Partial<FeedWorkshop> = {}): FeedWorkshop {
  return {
    workshopId: 1,
    workshopCode: 'TPB2775',
    workshopName: 'Sensory Play',
    startDate: '2026-12-01',
    endDate: null,
    startTime: null,
    endTime: null,
    timesText: null,
    datesText: null,
    room: null,
    presenters: [],
    registered: 0,
    capacity: null,
    isCancelled: false,
    updatedAt: null,
    ...overrides,
  };
}

describe('escapeText', () => {
  it('escapes the backslash before the characters it introduces', () => {
    expect(escapeText('a\\b')).toBe('a\\\\b');
    expect(escapeText('a,b;c')).toBe('a\\,b\\;c');
  });

  it('turns every newline shape into a literal \\n', () => {
    expect(escapeText('one\ntwo')).toBe('one\\ntwo');
    expect(escapeText('one\r\ntwo')).toBe('one\\ntwo');
  });
});

describe('foldLine', () => {
  it('leaves a short line alone', () => {
    expect(foldLine('SUMMARY:Short')).toBe('SUMMARY:Short');
  });

  it('folds at 75 octets with a leading space on continuations', () => {
    const line = `DESCRIPTION:${'x'.repeat(200)}`;
    const parts = foldLine(line).split('\r\n');

    expect(parts.length).toBeGreaterThan(1);
    expect(new TextEncoder().encode(parts[0]).length).toBeLessThanOrEqual(75);
    for (const part of parts.slice(1)) {
      expect(part.startsWith(' ')).toBe(true);
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    // Unfolding must give back exactly the original.
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
  });

  it('never splits a multi-byte character', () => {
    // 3-byte characters land on the boundary rather than around it.
    const line = `SUMMARY:${'é'.repeat(60)}`;
    const unfolded = foldLine(line)
      .split('\r\n')
      .map((p, i) => (i === 0 ? p : p.slice(1)))
      .join('');
    expect(unfolded).toBe(line);
    expect(unfolded).not.toContain('\uFFFD');
  });
});

describe('utcStamp', () => {
  it('formats a UTC stamp in the iCalendar shape', () => {
    expect(utcStamp(new Date('2026-12-01T09:05:07Z'))).toBe('20261201T090507Z');
  });
});

describe('parseTimesText', () => {
  it('reads a 24-hour range', () => {
    expect(parseTimesText('10:00 - 11:30')).toEqual({ start: '10:00', end: '11:30' });
  });

  it('reads a 12-hour range with meridiem', () => {
    expect(parseTimesText('1:00 PM - 3:30 PM')).toEqual({ start: '13:00', end: '15:30' });
  });

  it('converts noon and midnight correctly', () => {
    expect(parseTimesText('12:00 PM - 1:00 PM')).toEqual({ start: '12:00', end: '13:00' });
    expect(parseTimesText('12:00 AM - 2:00 AM')).toEqual({ start: '00:00', end: '02:00' });
  });

  it('refuses free text it cannot read rather than guessing', () => {
    expect(parseTimesText('Morning')).toBeNull();
    expect(parseTimesText('TBD')).toBeNull();
    expect(parseTimesText(null)).toBeNull();
  });
});

describe('workshopEvents', () => {
  it('publishes a workshop with no time as a single all-day event', () => {
    const [event] = workshopEvents(workshop(), []);
    expect(event.allDayDate).toBe('2026-12-01');
    expect(event.start).toBeUndefined();
    expect(event.uid).toBe('workshop-1');
  });

  it('prefers a typed time over the legacy free text', () => {
    const [event] = workshopEvents(
      workshop({ startTime: '09:00', endTime: '10:00', timesText: '8:00 - 9:00' }),
      [],
    );
    expect(event.start).toBe('20261201T090000');
    expect(event.end).toBe('20261201T100000');
  });

  it('falls back to TimesText when no typed time is recorded', () => {
    const [event] = workshopEvents(workshop({ timesText: '10:00 - 11:30' }), []);
    expect(event.start).toBe('20261201T100000');
    expect(event.end).toBe('20261201T113000');
  });

  it('creates one event per timed session, keyed on the session id', () => {
    const events = workshopEvents(workshop(), [
      { sessionId: 41, sessionDate: '2026-12-01', startTime: '10:00', endTime: '11:00' },
      { sessionId: 42, sessionDate: '2026-12-01', startTime: '11:00', endTime: '12:00' },
    ]);
    expect(events.map((e) => e.uid)).toEqual(['session-41', 'session-42']);
    expect(events[1].start).toBe('20261201T110000');
  });

  it('gives a timed session with no end a one-hour default', () => {
    const [event] = workshopEvents(workshop(), [
      { sessionId: 41, sessionDate: '2026-12-01', startTime: '23:30', endTime: null },
    ]);
    expect(event.end).toBe('20261202T003000');
  });

  it('runs past midnight when the end is earlier than the start', () => {
    const [event] = workshopEvents(workshop(), [
      { sessionId: 41, sessionDate: '2026-12-01', startTime: '23:00', endTime: '01:00' },
    ]);
    expect(event.end).toBe('20261202T010000');
  });

  it('uses the session dates for a workshop spanning several days', () => {
    const [event] = workshopEvents(workshop({ endDate: '2026-12-03' }), [
      { sessionId: 1, sessionDate: '2026-12-01', startTime: null, endTime: null },
      { sessionId: 2, sessionDate: '2026-12-03', startTime: null, endTime: null },
    ]);
    expect(event.allDayDate).toBe('2026-12-01');
  });
});

describe('buildCalendar', () => {
  const doc = buildCalendar(
    [
      {
        workshop: workshop({ presenters: ['Ada Lovelace'], registered: 3, capacity: 10 }),
        sessions: [],
      },
    ],
    OPTIONS,
  );

  it('is a well-formed calendar document with CRLF line endings', () => {
    expect(doc.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(doc.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(doc).not.toContain('\n\n');
    expect(doc.split('\r\n').filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('makes an all-day DTEND exclusive, so the event lasts one day', () => {
    expect(doc).toContain('DTSTART;VALUE=DATE:20261201');
    expect(doc).toContain('DTEND;VALUE=DATE:20261202');
  });

  it('qualifies the UID with the deployment domain', () => {
    expect(doc).toContain('UID:workshop-1@example.test');
  });

  it('links back to the workshop and names the calendar', () => {
    expect(doc).toContain('URL:https://training.example.test/workshops?edit=1');
    expect(doc).toContain('X-WR-CALNAME:');
  });

  it('carries presenters and capacity into the description', () => {
    expect(doc).toContain('3 of 10 places taken');
    expect(doc).toContain('Presenter: Ada Lovelace');
  });

  it('lists the other meeting dates of a multi-date workshop', () => {
    const series = buildCalendar(
      [
        {
          workshop: workshop({
            startDate: '2026-12-01',
            datesText: '12/1, 12/8 & 12/15/2026',
          }),
          sessions: [],
        },
      ],
      OPTIONS,
    );
    expect(series).toContain('Dates: 12/1\\, 12/8 & 12/15/2026');
  });

  it('does not repeat the start date when DatesText is only that date', () => {
    const single = buildCalendar(
      [{ workshop: workshop({ datesText: '2026-12-01' }), sessions: [] }],
      OPTIONS,
    );
    expect(single).not.toContain('Dates:');

    // The legacy field usually holds the same day in its own format.
    const legacy = buildCalendar(
      [{ workshop: workshop({ datesText: '12/1/2026' }), sessions: [] }],
      OPTIONS,
    );
    expect(legacy).not.toContain('Dates:');
  });

  it('marks a cancelled workshop as CANCELLED rather than dropping it', () => {
    const cancelled = buildCalendar(
      [{ workshop: workshop({ isCancelled: true }), sessions: [] }],
      OPTIONS,
    );
    expect(cancelled).toContain('STATUS:CANCELLED');
    expect(cancelled).toContain('has been cancelled');
  });
});
