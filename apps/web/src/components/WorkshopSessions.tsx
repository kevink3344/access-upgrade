import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { WorkshopSessionRow } from '@pe/shared';

interface Props {
  workshopId: number;
  canEdit: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtTime(time: string | null): string {
  if (!time) return '—';
  const [h, m] = time.split(':').map(Number);
  const suffix = (h ?? 0) >= 12 ? 'PM' : 'AM';
  const hour = (h ?? 0) % 12 || 12;
  return `${hour}:${String(m ?? 0).padStart(2, '0')} ${suffix}`;
}

/** Minutes since midnight for `HH:mm`, used to preview the repeat helper. */
function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function timeOf(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

const inputStyle = { marginBottom: 0 } as const;

/**
 * Sessions on a workshop.
 *
 * A workshop usually has one session, but some have more than one. The date,
 * time window and seat count live on the session, not the workshop, so this
 * is where a multi-session day is described.
 *
 * Sessions are descriptive: registrants still book the workshop, so capacity
 * here is for staff planning and never blocks a registration.
 */
export function WorkshopSessions({ workshopId, canEdit }: Props) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<'one' | 'several' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [capacity, setCapacity] = useState('');

  const [bulkCount, setBulkCount] = useState('3');
  const [bulkDuration, setBulkDuration] = useState('60');

  const sessions = useQuery({
    queryKey: ['workshop', workshopId, 'sessions'],
    queryFn: () => api.workshops.sessions(workshopId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['workshop', workshopId, 'sessions'] });
  };

  const resetForm = () => {
    setAdding(null);
    setDate('');
    setStartTime('');
    setEndTime('');
    setCapacity('');
    setBulkCount('3');
    setBulkDuration('60');
    setError(null);
  };

  const add = useMutation({
    mutationFn: () =>
      api.workshops.addSession(workshopId, {
        sessionDate: date,
        startTime: startTime || null,
        endTime: endTime || null,
        maxEnrollment: capacity ? Number(capacity) : null,
      }),
    onSuccess: (res) => {
      resetForm();
      // The session was created; the warning explains a scheduling mismatch
      // rather than a failure, so it is shown after the form closes.
      if (res.warning) setWarning(res.warning);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const addBulk = useMutation({
    mutationFn: () =>
      api.workshops.addSessionsBulk(workshopId, {
        sessionDate: date,
        startTime,
        count: Number(bulkCount),
        durationMinutes: Number(bulkDuration),
        maxEnrollment: capacity ? Number(capacity) : null,
      }),
    onSuccess: (res) => {
      resetForm();
      if (res.warning) setWarning(res.warning);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: (sessionId: number) => api.workshops.removeSession(workshopId, sessionId),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const rows = sessions.data?.data ?? [];

  // Incomplete rows (no time) sort first so they are easy to find and fix.
  const sorted = [...rows].sort((a, b) => {
    if (!a.StartTime && b.StartTime) return -1;
    if (a.StartTime && !b.StartTime) return 1;
    return 0;
  });

  // Preview of what the repeat helper will create.
  const bulkPreview =
    adding === 'several' && date && startTime && Number(bulkCount) > 0 && Number(bulkDuration) >= 5
      ? Array.from({ length: Math.min(Number(bulkCount), 12) }, (_, i) => {
          const from = minutesOf(startTime) + i * Number(bulkDuration);
          return `${fmtTime(timeOf(from))} – ${fmtTime(timeOf(from + Number(bulkDuration)))}`;
        })
      : [];

  return (
    <div className="tab-section">
      <div className="tab-head">
        <p className="tab-summary">
          <strong>{rows.length}</strong> session{rows.length === 1 ? '' : 's'}
        </p>
        {canEdit && adding === null && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding('several')}>
              Add several
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding('one')}>
              Add session
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {warning && (
        <div className="alert alert-warn" role="status">
          <span>{warning}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setWarning(null)}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {adding !== null && (
        <div className="tab-add">
          <div className="field" style={inputStyle}>
            <label htmlFor="sess-date">Session date</label>
            <input
              id="sess-date"
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field" style={inputStyle}>
            <label htmlFor="sess-start">Start</label>
            <input
              id="sess-start"
              type="time"
              className="input"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          {adding === 'one' && (
            <div className="field" style={inputStyle}>
              <label htmlFor="sess-end">End</label>
              <input
                id="sess-end"
                type="time"
                className="input"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          )}
          {adding === 'several' && (
            <>
              <div className="field" style={inputStyle}>
                <label htmlFor="sess-count">How many</label>
                <input
                  id="sess-count"
                  type="number"
                  min={1}
                  max={12}
                  className="input"
                  value={bulkCount}
                  onChange={(e) => setBulkCount(e.target.value)}
                />
              </div>
              <div className="field" style={inputStyle}>
                <label htmlFor="sess-duration">Minutes each</label>
                <input
                  id="sess-duration"
                  type="number"
                  min={5}
                  max={600}
                  step={5}
                  className="input"
                  value={bulkDuration}
                  onChange={(e) => setBulkDuration(e.target.value)}
                />
              </div>
            </>
          )}
          <div className="field" style={inputStyle}>
            <label htmlFor="sess-capacity">Capacity</label>
            <input
              id="sess-capacity"
              type="number"
              min={0}
              className="input"
              placeholder="Workshop default"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!date || !startTime || add.isPending || addBulk.isPending}
            onClick={() => (adding === 'several' ? addBulk.mutate() : add.mutate())}
          >
            {add.isPending || addBulk.isPending ? 'Adding…' : adding === 'several' ? 'Add all' : 'Add'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={resetForm}>
            Cancel
          </button>

          <p className="tab-summary" style={{ flexBasis: '100%' }}>
            Capacity is for planning. Registrations are taken against the workshop's capacity.
          </p>

          {bulkPreview.length > 0 && (
            <p className="tab-summary" style={{ flexBasis: '100%' }}>
              Will create: {bulkPreview.join(' · ')}
            </p>
          )}
        </div>
      )}

      {sessions.isLoading ? (
        <div className="skeleton" style={{ height: 60 }} />
      ) : sessions.isError ? (
        <div className="alert alert-error" role="alert">
          <span>Could not load sessions. {(sessions.error as Error).message}</span>
        </div>
      ) : rows.length === 0 ? (
        <p className="tab-empty">No sessions recorded yet.</p>
      ) : (
        <table className="data-table tab-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Start</th>
              <th scope="col">End</th>
              <th scope="col" className="num">Capacity</th>
              <th scope="col" className="num">Workshop regs</th>
              <th scope="col" className="num">Attended</th>
              <th scope="col" className="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s: WorkshopSessionRow) => (
              <tr key={s.WorkshopSessionID}>
                <td data-label="Date">{fmtDate(s.SessionDate)}</td>
                <td data-label="Start">{fmtTime(s.StartTime)}</td>
                <td data-label="End">{fmtTime(s.EndTime)}</td>
                <td data-label="Capacity" className="num">
                  {s.EffectiveCapacity ?? '—'}
                  {s.CapacityInherited && <span className="muted"> (from workshop)</span>}
                </td>
                <td data-label="Workshop regs" className="num">
                  {s.WorkshopRegistered}
                </td>
                <td data-label="Attended" className="num">
                  {s.RegAttend ?? 0}
                </td>
                <td data-label="Actions" className="num">
                  {canEdit && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => remove.mutate(s.WorkshopSessionID)}
                      disabled={remove.isPending}
                      title="Sessions with attendance recorded cannot be deleted"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
