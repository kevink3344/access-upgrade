/**
 * iCalendar (RFC 5545) output for the workshop calendar feed.
 *
 * Kept free of database access so the formatting rules — folding, escaping,
 * all-day versus timed events, cancellation — can be unit-tested without a
 * live SQL Server. The route supplies plain rows; this module decides what
 * the calendar app sees.
 */

export interface FeedSession {
  sessionId: number;
  sessionDate: string | null;
  /** HH:mm, or null for a session recorded with a date but no time. */
  startTime: string | null;
  endTime: string | null;
}

export interface FeedWorkshop {
  workshopId: number;
  workshopCode: string | null;
  workshopName: string | null;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD, or null when the workshop is a single day. */
  endDate: string | null;
  /** HH:mm on core.Workshop; the fallback when a workshop has no sessions. */
  startTime: string | null;
  endTime: string | null;
  timesText: string | null;
  /** Legacy free text listing every meeting date, e.g. "9/12 & 10/10/2007". */
  datesText: string | null;
  room: string | null;
  presenters: string[];
  registered: number;
  capacity: number | null;
  isCancelled: boolean;
  /** Last modification, for SEQUENCE and LAST-MODIFIED. */
  updatedAt: Date | null;
}

export interface FeedOptions {
  /** Domain used for event UIDs, e.g. "projectenlightenment.org". */
  uidDomain: string;
  /** Display name of the subscribed calendar. */
  calendarName: string;
  /** Base URL of the app, so events can link back to the workshop. */
  appUrl: string | null;
  /** Stamped on every event and on the calendar itself. */
  now: Date;
  /** How long a subscriber should wait before refetching. */
  refreshInterval: string;
}

/** One VEVENT, before serialisation. */
export interface FeedEvent {
  uid: string;
  sequence: number;
  lastModified: Date;
  /** YYYY-MM-DD for an all-day event. */
  allDayDate?: string;
  /** Local wall-clock stamps for a timed event, e.g. 2026-12-01T10:00:00. */
  start?: string;
  end?: string;
  summary: string;
  description: string;
  location: string | null;
  url: string | null;
  cancelled: boolean;
}

/* ------------------------------------------------------------------ */
/*  Text rules                                                         */
/* ------------------------------------------------------------------ */

/**
 * Escapes a TEXT value.
 *
 * Order matters: the backslash must be escaped first, or the escapes added
 * for the other characters would themselves be escaped.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds a content line at 75 octets, as RFC 5545 requires.
 *
 * Counts bytes rather than characters and never splits a multi-byte
 * character, so a name with an accent or a curly apostrophe does not become
 * mojibake in the subscriber's calendar. Continuation lines start with a
 * single space.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = '';
  let bytes = 0;
  // Continuation lines carry the leading space, so they hold 74 bytes of text.
  let limit = 75;

  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
      limit = 74;
    }
    current += char;
    bytes += size;
  }
  if (current) out.push(current);

  return out.join('\r\n ');
}

/* ------------------------------------------------------------------ */
/*  Date rules                                                         */
/* ------------------------------------------------------------------ */

/** `YYYYMMDD` from a `YYYY-MM-DD` string. */
function compactDate(date: string): string {
  return date.replace(/-/g, '');
}

/** Adds days to a `YYYY-MM-DD` string, in UTC so DST cannot shift it. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `YYYYMMDDTHHMMSS` local wall-clock, which is what DTSTART;TZID wants. */
function localStamp(date: string, time: string): string {
  const [h = '00', m = '00'] = time.split(':');
  return `${compactDate(date)}T${h.padStart(2, '0')}${m.padStart(2, '0')}00`;
}

/** `YYYYMMDDTHHMMSSZ` for UTC stamps such as DTSTAMP. */
export function utcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/**
 * Minutes since midnight for an `HH:mm` string, or null when it does not
 * parse. Mirrors `minutesOf` in services/sessions.ts, duplicated here so
 * this module stays free of any other service.
 */
function minutesOf(time: string | null): number | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The time window recorded in the legacy free-text `TimesText` field.
 *
 * Only the unambiguous "10:00 - 11:30" and "10:00 AM - 11:30 AM" shapes are
 * recognised. Anything else (e.g. "Morning", "TBD") returns null, and the
 * event is published as all-day rather than with a guessed time.
 */
export function parseTimesText(
  text: string | null,
): { start: string; end: string | null } | null {
  if (!text) return null;

  const m =
    /(\d{1,2}(?::\d{2})?)\s*([ap]\.?m\.?)?\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?)\s*([ap]\.?m\.?)?/i.exec(
      text,
    );
  if (!m) return null;

  const to24 = (value: string, meridiem: string | undefined): string | null => {
    const [hRaw, mRaw] = value.split(':');
    let h = Number(hRaw);
    const minutes = mRaw === undefined ? 0 : Number(mRaw);
    const pm = meridiem ? /^p/i.test(meridiem) : null;
    if (pm === true && h < 12) h += 12;
    if (pm === false && h === 12) h = 0;
    if (h > 23 || minutes > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  };

  const start = to24(m[1] ?? '', m[2]);
  const end = to24(m[3] ?? '', m[4]);
  if (!start || !end) return null;

  return { start, end };
}

/* ------------------------------------------------------------------ */
/*  Events                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_DURATION_MINUTES = 60;

/**
 * Turns one workshop into its calendar events.
 *
 * A workshop with sessions becomes one event per session, because a day with
 * three sittings is three things to show up to. A workshop without sessions
 * becomes a single event, timed when the workshop records a time and all-day
 * otherwise.
 *
 * Cancelled workshops are still published, as CANCELLED events: a
 * subscriber that simply stops seeing an event has no way to tell a
 * cancellation from a workshop that was never scheduled, and staff would
 * keep turning up.
 */
export function workshopEvents(w: FeedWorkshop, sessions: FeedSession[]): FeedEvent[] {
  const title = w.workshopName ?? w.workshopCode ?? `Workshop ${w.workshopId}`;
  const summary = w.workshopCode ? `${w.workshopCode} ${title}` : title;

  const description = describe(w);
  const url = null;

  const sequence = w.updatedAt ? Math.floor(w.updatedAt.getTime() / 1000) : 0;
  const lastModified = w.updatedAt ?? new Date(0);

  const dated = sessions.filter((s) => s.sessionDate);
  const timed = dated.filter((s) => s.startTime);

  if (timed.length > 0) {
    return timed.map((s) => {
      const date = s.sessionDate!;
      const start = s.startTime!;
      const end = sessionEnd(date, start, s.endTime);
      return {
        // Keyed on the session's own id, so editing a time moves the event
        // rather than creating a second one next to the old.
        uid: `session-${s.sessionId}`,
        sequence,
        lastModified,
        start: localStamp(date, start),
        end: localStamp(end.date, end.time),
        summary,
        description,
        location: w.room,
        url,
        cancelled: w.isCancelled,
      };
    });
  }

  // Sessions with a date but no time — the whole day is the best we know.
  const firstDate = dated.length > 0 ? dated[0]!.sessionDate! : w.startDate;
  const lastDate =
    dated.length > 0
      ? dated[dated.length - 1]!.sessionDate!
      : w.endDate && w.endDate >= w.startDate
        ? w.endDate
        : w.startDate;

  const workshopTimes =
    w.startTime && w.endTime
      ? { start: w.startTime, end: w.endTime }
      : parseTimesText(w.timesText);

  if (workshopTimes) {
    const end = sessionEnd(lastDate, workshopTimes.start, workshopTimes.end);
    return [
      {
        uid: `workshop-${w.workshopId}`,
        sequence,
        lastModified,
        start: localStamp(firstDate, workshopTimes.start),
        end: localStamp(end.date, end.time),
        summary,
        description,
        location: w.room,
        url,
        cancelled: w.isCancelled,
      },
    ];
  }

  return [
    {
      uid: `workshop-${w.workshopId}`,
      sequence,
      lastModified,
      allDayDate: firstDate,
      summary,
      description,
      location: w.room,
      url,
      cancelled: w.isCancelled,
    },
  ];
}

/**
 * End stamp for a timed event.
 *
 * A missing end time gets a one-hour default rather than a zero-length event,
 * which most calendar apps render as a thin line. An end at or before the
 * start is treated as running past midnight, matching how the session
 * validation already allows a wrap.
 */
function sessionEnd(
  date: string,
  start: string,
  endTime: string | null,
): { date: string; time: string } {
  const startMinutes = minutesOf(start) ?? 0;
  const endMinutes = minutesOf(endTime);

  if (endMinutes === null) {
    const total = startMinutes + DEFAULT_DURATION_MINUTES;
    return { date: addDays(date, Math.floor(total / 1440)), time: hhmm(total % 1440) };
  }

  if (endMinutes <= startMinutes) {
    // Past midnight only when it is genuinely later in the day.
    return endMinutes === startMinutes
      ? { date, time: hhmm((startMinutes + DEFAULT_DURATION_MINUTES) % 1440) }
      : { date: addDays(date, 1), time: hhmm(endMinutes) };
  }

  return { date, time: hhmm(endMinutes) };
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * True when `DatesText` only restates the start date, e.g. "12/2/2025" for
 * 2025-12-02. Those rows need no extra line; the event already sits there.
 */
function isSameDayText(datesText: string, startDate: string): boolean {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(datesText.trim());
  if (!m) return false;

  const [, mo, day, yr] = m;
  const year = yr!.length === 2 ? `20${yr}` : yr;
  return `${year}-${mo!.padStart(2, '0')}-${day!.padStart(2, '0')}` === startDate;
}

function describe(w: FeedWorkshop): string {
  const parts: string[] = [];

  // A workshop can meet on several dates (e.g. a series of evenings). The
  // event sits on the first date, so the rest are spelled out here rather
  // than silently dropped — staff would otherwise turn up once and miss the
  // remaining sittings.
  const extraDates = w.datesText?.trim();
  if (
    extraDates &&
    extraDates !== w.startDate &&
    !isSameDayText(extraDates, w.startDate)
  ) {
    parts.push(`Dates: ${extraDates}`);
  }

  if (w.capacity && w.capacity > 0) {
    parts.push(`${w.registered} of ${w.capacity} places taken`);
  } else {
    parts.push(`${w.registered} registered`);
  }
  if (w.presenters.length > 0) parts.push(`Presenter: ${w.presenters.join(', ')}`);
  if (w.isCancelled) parts.push('This workshop has been cancelled.');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Serialisation                                                      */
/* ------------------------------------------------------------------ */

/** The whole feed as an iCalendar document. */
export function buildCalendar(
  workshops: Array<{ workshop: FeedWorkshop; sessions: FeedSession[] }>,
  options: FeedOptions,
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Project Enlightenment//Workshop Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.calendarName)}`,
    `X-WR-CALDESC:${escapeText('Scheduled workshops from the Project Enlightenment training database.')}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${options.refreshInterval}`,
    `X-PUBLISHED-TTL:${options.refreshInterval}`,
  ];

  for (const { workshop, sessions } of workshops) {
    for (const event of workshopEvents(workshop, sessions)) {
      lines.push(
        ...eventLines(
          { ...event, uid: `${event.uid}@${options.uidDomain}` },
          options.now,
          options.appUrl,
          workshop.workshopId,
        ),
      );
    }
  }

  lines.push('END:VCALENDAR');

  // Every line is folded on its own, so a long description cannot push the
  // following property past the limit.
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

function eventLines(
  e: FeedEvent,
  now: Date,
  appUrl: string | null,
  workshopId: number,
): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `SEQUENCE:${e.sequence}`,
    `LAST-MODIFIED:${utcStamp(e.lastModified)}`,
  ];

  if (e.allDayDate) {
    // DTEND is exclusive for DATE values, so a single day ends the next day.
    lines.push(
      `DTSTART;VALUE=DATE:${compactDate(e.allDayDate)}`,
      `DTEND;VALUE=DATE:${compactDate(addDays(e.allDayDate, 1))}`,
    );
  } else {
    lines.push(
      `DTSTART;TZID=America/New_York:${e.start}`,
      `DTEND;TZID=America/New_York:${e.end}`,
    );
  }

  lines.push(`SUMMARY:${escapeText(e.summary)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);

  const link = appUrl ? `${appUrl.replace(/\/+$/, '')}/workshops?edit=${workshopId}` : null;
  if (link) lines.push(`URL:${link}`);

  if (e.cancelled) lines.push('STATUS:CANCELLED');
  lines.push('TRANSP:TRANSPARENT');
  lines.push('END:VEVENT');

  return lines;
}
