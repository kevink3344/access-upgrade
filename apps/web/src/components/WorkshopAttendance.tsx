import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface Props {
  workshopId: number;
  canEdit: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'No date';
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Per-session attendance checklist.
 *
 * A participant with no SessionParticipant row is *unmarked*, not absent —
 * the API returns `attended: null` for those. Clearing a tick deletes the row
 * rather than storing a false, so the two states stay distinguishable and a
 * fresh checklist is never mistaken for a session nobody attended.
 */
export function WorkshopAttendance({ workshopId, canEdit }: Props) {
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['workshop', workshopId, 'sessions'],
    queryFn: () => api.workshops.sessions(workshopId),
  });

  const sessionRows = sessions.data?.data ?? [];
  const activeSession = sessionId ?? sessionRows[0]?.WorkshopSessionID ?? null;

  const roster = useQuery({
    queryKey: ['workshop', workshopId, 'attendance', activeSession],
    queryFn: () => api.workshops.attendance(workshopId, activeSession!),
    enabled: activeSession !== null,
  });

  const setAttendance = useMutation({
    mutationFn: (v: { participantId: number; attended: boolean; isLate?: boolean }) =>
      api.workshops.setAttendance(workshopId, activeSession!, v.participantId, {
        attended: v.attended,
        isLate: v.isLate,
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['workshop', workshopId, 'attendance', activeSession] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const rows = roster.data?.data ?? [];
  const marked = useMemo(() => rows.filter((r) => r.attended === true).length, [rows]);

  if (sessions.isLoading) return <div className="skeleton" style={{ height: 80 }} />;

  if (sessionRows.length === 0) {
    return (
      <div className="tab-section">
        <p className="tab-empty">
          This workshop has no sessions yet. Add one on the Sessions tab to take attendance.
        </p>
      </div>
    );
  }

  return (
    <div className="tab-section">
      <div className="tab-head">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="att-session">Session</label>
          <select
            id="att-session"
            className="input"
            value={activeSession ?? ''}
            onChange={(e) => setSessionId(Number(e.target.value))}
          >
            {sessionRows.map((s) => (
              <option key={s.WorkshopSessionID} value={s.WorkshopSessionID}>
                {fmtDate(s.SessionDate)}
                {s.StartTime ? ` · ${s.StartTime}` : ''}
                {s.EndTime ? `–${s.EndTime}` : ''}
              </option>
            ))}
          </select>
        </div>
        <p className="tab-summary">
          <strong>{marked}</strong> of {rows.length} marked present
        </p>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {roster.isLoading ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : roster.isError ? (
        <div className="alert alert-error" role="alert">
          <span>Could not load the checklist. {(roster.error as Error).message}</span>
        </div>
      ) : rows.length === 0 ? (
        <p className="tab-empty">Nobody is registered for this workshop yet.</p>
      ) : (
        <ul className="att-list">
          {rows.map((r) => (
            <li key={r.participantId} className={r.attended ? 'is-present' : ''}>
              <label className="att-row">
                <input
                  type="checkbox"
                  checked={r.attended === true}
                  disabled={!canEdit || setAttendance.isPending}
                  onChange={(e) =>
                    setAttendance.mutate({ participantId: r.participantId, attended: e.target.checked })
                  }
                />
                <span className="att-main">
                  <span className="att-name">{r.name ?? 'Unnamed'}</span>
                  <span className="att-meta">
                    {r.email ?? '—'}
                    {r.agencyName ? ` · ${r.agencyName}` : ''}
                  </span>
                </span>
                {r.attended === null && <span className="pill pill-muted">Unmarked</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
