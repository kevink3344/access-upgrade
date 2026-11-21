import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

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

/**
 * Sessions on a workshop.
 *
 * A workshop usually has one session, but 311 have more than one. The date is
 * stored on the session, not the workshop, so this is where a multi-day series
 * is actually described.
 */
export function WorkshopSessions({ workshopId, canEdit }: Props) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState('');
  const [staff, setStaff] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['workshop', workshopId, 'sessions'],
    queryFn: () => api.workshops.sessions(workshopId),
  });

  const presenters = useQuery({
    queryKey: ['presenters', 'all'],
    queryFn: () => api.presenters.list({ pageSize: 500 }),
    enabled: adding,
    staleTime: 5 * 60_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['workshop', workshopId, 'sessions'] });
  };

  const add = useMutation({
    mutationFn: () =>
      api.workshops.addSession(workshopId, {
        sessionDate: date,
        staffId: staff ? Number(staff) : null,
      }),
    onSuccess: () => {
      setAdding(false);
      setDate('');
      setStaff('');
      setError(null);
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

  return (
    <div className="tab-section">
      <div className="tab-head">
        <p className="tab-summary">
          <strong>{rows.length}</strong> session{rows.length === 1 ? '' : 's'}
        </p>
        {canEdit && !adding && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
            Add session
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {adding && (
        <div className="tab-add">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="sess-date">Session date</label>
            <input
              id="sess-date"
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="sess-staff">Presenter (optional)</label>
            <select
              id="sess-staff"
              className="input"
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
            >
              <option value="">Not set</option>
              {(presenters.data?.data ?? []).map((p) => (
                <option key={p.PresenterStaffID} value={p.PresenterStaffID}>
                  {[p.FirstName, p.LastName].filter(Boolean).join(' ')}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!date || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setAdding(false);
              setDate('');
              setStaff('');
              setError(null);
            }}
          >
            Cancel
          </button>
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
              <th scope="col">Presenter</th>
              <th scope="col" className="num">Attended</th>
              <th scope="col" className="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.WorkshopSessionID}>
                <td data-label="Date">{fmtDate(s.SessionDate)}</td>
                <td data-label="Presenter" className="muted">
                  {s.PresenterName ?? '—'}
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
