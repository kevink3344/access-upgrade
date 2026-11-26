import { useMemo } from 'react';
import type { TrainingRequestCalendarEntry } from '@pe/shared';
import { monthLabel, ymd } from './WorkshopCalendar';

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

/**
 * Tone of a chip, from the same workflow stages the table shows: a request is
 * "scheduled" because a workshop is linked to it and "invoiced" because it has
 * a number. Closed requests are struck through like cancelled workshops.
 */
function stageTone(e: TrainingRequestCalendarEntry): string {
  if (!e.isActive) return 'is-cancelled';
  if (e.invoiceNum) return 'is-full';
  if (e.scheduledCount > 0) return 'is-warn';
  return 'is-open';
}

interface Props {
  year: number;
  month: number;
  entries: TrainingRequestCalendarEntry[];
  selectedDate: string | null;
  onOpen: (trainingRequestId: number) => void;
  onPickDay: (date: string) => void;
}

/**
 * Month grid for the training requests calendar.
 *
 * One entry per request, placed on its RequestDate — the day the agency asked
 * for training. Shares the workshops calendar's markup and CSS so the two
 * screens behave identically.
 */
export function TrainingRequestCalendar({
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
    const map = new Map<string, TrainingRequestCalendarEntry[]>();
    for (const e of entries) {
      const list = map.get(e.date);
      if (list) list.push(e);
      else map.set(e.date, [e]);
    }
    return map;
  }, [entries]);

  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="cal cal--requests">
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
              })}, ${items.length} request${items.length === 1 ? '' : 's'}`}
            >
              <button
                type="button"
                className="cal-daynum"
                onClick={() => onPickDay(key)}
                aria-expanded={isSelected}
                title={`Show requests from ${key}`}
              >
                {d.getDate()}
              </button>

              <div className="cal-items">
                {items.slice(0, 3).map((e) => (
                  <button
                    key={e.trainingRequestId}
                    type="button"
                    className={`cal-chip ${stageTone(e)}`}
                    onClick={() => onOpen(e.trainingRequestId)}
                    title={`${e.agencyName ?? 'No agency recorded'}${
                      e.requestedBy ? ` — ${e.requestedBy}` : ''
                    }`}
                  >
                    <span className="cal-chip-code">{e.agencyName ?? '—'}</span>
                    <span className="cal-chip-name">{e.requestedBy ?? 'No contact'}</span>
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
                    <i key={e.trainingRequestId} className={stageTone(e)} />
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
