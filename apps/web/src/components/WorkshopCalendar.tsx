import { useMemo } from 'react';
import type { WorkshopCalendarEntry } from '@pe/shared';

/** Local YYYY-MM-DD. Never use toISOString() here — it shifts by timezone. */
export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

/** The 42 cells (6 weeks) of a month grid, Sunday-first. */
function gridDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function capacityTone(e: WorkshopCalendarEntry): string {
  if (e.isCancelled) return 'is-cancelled';
  if (e.capacity && e.capacity > 0) {
    const pct = (e.registered / e.capacity) * 100;
    if (pct >= 100) return 'is-full';
    if (pct >= 80) return 'is-warn';
  }
  return 'is-open';
}

interface Props {
  year: number;
  month: number;
  entries: WorkshopCalendarEntry[];
  selectedDate: string | null;
  onOpen: (workshopId: number) => void;
  onPickDay: (date: string) => void;
}

/**
 * Month grid for the workshops calendar.
 *
 * One entry per workshop, placed on its StartDate. Days outside the current
 * month are rendered muted so the grid keeps a stable 6-row height and does
 * not jump as you page between months.
 */
export function WorkshopCalendar({
  year,
  month,
  entries,
  selectedDate,
  onOpen,
  onPickDay,
}: Props) {
  const today = ymd(new Date());
  const days = useMemo(() => gridDays(year, month), [year, month]);

  const byDate = useMemo(() => {
    const map = new Map<string, WorkshopCalendarEntry[]>();
    for (const e of entries) {
      const list = map.get(e.date);
      if (list) list.push(e);
      else map.set(e.date, [e]);
    }
    return map;
  }, [entries]);

  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="cal">
      <div className="cal-weekdays" aria-hidden="true">
        {weekdayNames.map((d) => (
          <div key={d} className="cal-weekday">{d}</div>
        ))}
      </div>

      <div className="cal-grid" role="grid" aria-label={monthLabel(year, month)}>
        {days.map((d) => {
          const key = ymd(d);
          const inMonth = d.getMonth() === month;
          const items = byDate.get(key) ?? [];
          const isToday = key === today;
          const isSelected = key === selectedDate;

          return (
            <div
              key={key}
              role="gridcell"
              className={[
                'cal-day',
                inMonth ? '' : 'is-outside',
                isToday ? 'is-today' : '',
                isSelected ? 'is-selected' : '',
              ].join(' ').trim()}
              aria-selected={isSelected}
              aria-label={`${d.toLocaleDateString('en-US', {
                weekday: 'long', month: 'long', day: 'numeric',
              })}, ${items.length} workshop${items.length === 1 ? '' : 's'}`}
            >
              <button
                type="button"
                className="cal-daynum"
                onClick={() => onPickDay(key)}
                aria-expanded={isSelected}
                title={`Show workshops on ${key}`}
              >
                {d.getDate()}
              </button>

              <div className="cal-items">
                {items.slice(0, 3).map((e) => (
                  <button
                    key={e.workshopId}
                    type="button"
                    className={`cal-chip ${capacityTone(e)}`}
                    onClick={() => onOpen(e.workshopId)}
                    title={`${e.workshopName ?? e.workshopCode ?? 'Workshop'}${
                      e.capacity ? ` — ${e.registered}/${e.capacity}` : ''
                    }`}
                  >
                    <span className="cal-chip-code">{e.workshopCode ?? '—'}</span>
                    <span className="cal-chip-name">{e.workshopName ?? 'Untitled'}</span>
                  </button>
                ))}
                {items.length > 3 && (
                  <button
                    type="button"
                    className="cal-more"
                    onClick={() => onPickDay(key)}
                  >
                    +{items.length - 3} more
                  </button>
                )}
              </div>

              {/* Phones: dots instead of chips, tapping the day opens a sheet. */}
              {items.length > 0 && (
                <div className="cal-dots" aria-hidden="true">
                  {items.slice(0, 3).map((e) => (
                    <i key={e.workshopId} className={capacityTone(e)} />
                  ))}
                  {items.length > 3 && <span className="cal-dots-more">+{items.length - 3}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
