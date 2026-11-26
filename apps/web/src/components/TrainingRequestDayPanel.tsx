import { useEffect } from 'react';
import type { TrainingRequestCalendarEntry } from '@pe/shared';

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

/** Mirrors the table's Stage column: invoiced, then scheduled, then quoted. */
function stageOf(e: TrainingRequestCalendarEntry): { label: string; cls: string } {
  if (!e.isActive) return { label: 'Closed', cls: 'pill-closed' };
  if (e.invoiceNum) return { label: 'Invoiced', cls: 'pill-open' };
  if (e.scheduledCount > 0) return { label: 'Scheduled', cls: 'pill-closed' };
  if (e.quoteCount > 0) return { label: 'Quoted', cls: 'pill-full' };
  return { label: 'New', cls: 'pill-cancelled' };
}

interface Props {
  date: string;
  entries: TrainingRequestCalendarEntry[];
  onOpen: (trainingRequestId: number) => void;
  onClose: () => void;
}

/**
 * The training requests made on one day.
 *
 * Rendered as a side panel on desktop and a bottom sheet on phones from the
 * same markup — the CSS decides which, matching the workshops calendar.
 */
export function TrainingRequestDayPanel({ date, entries, onOpen, onClose }: Props) {
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
        aria-label={`Training requests on ${longDate(date)}`}
      >
        <header className="cal-day-panel-head">
          <div>
            <h3>{longDate(date)}</h3>
            <p>
              {entries.length === 0
                ? 'No requests'
                : `${entries.length} request${entries.length === 1 ? '' : 's'}`}
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
            <p className="cal-day-empty">No requests were made on this day.</p>
          ) : (
            <ul className="cal-day-list">
              {entries.map((e) => {
                const s = stageOf(e);
                return (
                  <li key={e.trainingRequestId}>
                    <button
                      type="button"
                      className="cal-day-item"
                      onClick={() => onOpen(e.trainingRequestId)}
                    >
                      <span className="cal-day-item-top">
                        <span className="cal-day-item-code">
                          {e.agencyName ?? 'No agency recorded'}
                        </span>
                        <span className={`pill ${s.cls}`}>{s.label}</span>
                      </span>
                      <span className="cal-day-item-name">
                        {e.requestedBy ?? 'No contact recorded'}
                      </span>
                      <span className="cal-day-item-meta">
                        {e.participantCount
                          ? `${e.participantCount} participants`
                          : 'Participant count not recorded'}
                        {e.invoiceNum && ` · invoice ${e.invoiceNum}`}
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
