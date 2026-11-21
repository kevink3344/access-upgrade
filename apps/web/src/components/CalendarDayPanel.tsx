import { useEffect } from 'react';
import type { WorkshopCalendarEntry } from '@pe/shared';

function longDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusOf(e: WorkshopCalendarEntry): { label: string; cls: string } {
  if (e.isCancelled) return { label: 'Cancelled', cls: 'pill-cancelled' };
  if (e.isClosed) return { label: 'Closed', cls: 'pill-closed' };
  if (e.capacity && e.capacity > 0 && e.registered >= e.capacity) {
    return { label: 'Full', cls: 'pill-full' };
  }
  return { label: 'Open', cls: 'pill-open' };
}

interface Props {
  date: string;
  entries: WorkshopCalendarEntry[];
  onOpen: (workshopId: number) => void;
  onClose: () => void;
}

/**
 * The workshops on one day.
 *
 * Rendered as a side panel on desktop and a bottom sheet on phones from the
 * same markup — the CSS decides which, so there is one implementation to keep
 * correct rather than two.
 */
export function CalendarDayPanel({ date, entries, onOpen, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="cal-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="cal-day-panel"
        role="dialog"
        aria-label={`Workshops on ${longDate(date)}`}
      >
        <header className="cal-day-panel-head">
          <div>
            <h3>{longDate(date)}</h3>
            <p>
              {entries.length === 0
                ? 'No workshops'
                : `${entries.length} workshop${entries.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="cal-day-panel-body">
          {entries.length === 0 ? (
            <p className="cal-day-empty">Nothing scheduled for this day.</p>
          ) : (
            <ul className="cal-day-list">
              {entries.map((e) => {
                const s = statusOf(e);
                return (
                  <li key={e.workshopId}>
                    <button
                      type="button"
                      className="cal-day-item"
                      onClick={() => onOpen(e.workshopId)}
                    >
                      <span className="cal-day-item-top">
                        <span className="cal-day-item-code">{e.workshopCode ?? '—'}</span>
                        <span className={`pill ${s.cls}`}>{s.label}</span>
                      </span>
                      <span className="cal-day-item-name">
                        {e.workshopName ?? 'Untitled workshop'}
                      </span>
                      <span className="cal-day-item-meta">
                        {e.capacity && e.capacity > 0
                          ? `${e.registered} of ${e.capacity} registered`
                          : `${e.registered} registered`}
                        {e.endDate && e.endDate !== e.date && ` · ends ${e.endDate}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
