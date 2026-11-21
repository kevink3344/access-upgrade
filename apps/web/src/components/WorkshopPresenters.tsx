import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface Props {
  workshopId: number;
  canEdit: boolean;
}

/**
 * Presenters assigned to a workshop.
 *
 * A workshop can have several; the join table is `core.WorkshopPresenter`,
 * whose id is not IDENTITY (the legacy key was preserved by the ETL), so the
 * API allocates MAX+1 rather than letting SQL Server do it.
 */
export function WorkshopPresenters({ workshopId, canEdit }: Props) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);

  const assigned = useQuery({
    queryKey: ['workshop', workshopId, 'presenters'],
    queryFn: () => api.workshops.presenters(workshopId),
  });

  // Only fetched once the picker is open — no reason to load 158 names on
  // every drawer open.
  const all = useQuery({
    queryKey: ['presenters', 'all'],
    queryFn: () => api.presenters.list({ pageSize: 500 }),
    enabled: adding,
    staleTime: 5 * 60_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['workshop', workshopId, 'presenters'] });
  };

  const add = useMutation({
    mutationFn: (presenterStaffId: number) => api.workshops.addPresenter(workshopId, presenterStaffId),
    onSuccess: () => {
      setAdding(false);
      setPick('');
      setError(null);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: (rowId: number) => api.workshops.removePresenter(workshopId, rowId),
    onSuccess: invalidate,
    onError: (e: Error) => setError(e.message),
  });

  const rows = assigned.data?.data ?? [];
  const assignedIds = new Set(rows.map((r) => r.presenterStaffId));
  const choices = (all.data?.data ?? []).filter((p) => !assignedIds.has(p.PresenterStaffID));

  return (
    <div className="tab-section">
      <div className="tab-head">
        <p className="tab-summary">
          <strong>{rows.length}</strong> presenter{rows.length === 1 ? '' : 's'} assigned
        </p>
        {canEdit && !adding && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
            Add presenter
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
          <label htmlFor="presenter-pick" className="visually-hidden">Presenter</label>
          <select
            id="presenter-pick"
            className="input"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">Select a presenter…</option>
            {choices.map((p) => (
              <option key={p.PresenterStaffID} value={p.PresenterStaffID}>
                {[p.FirstName, p.LastName].filter(Boolean).join(' ') || `Presenter ${p.PresenterStaffID}`}
                {p.IsRetired ? ' (retired)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!pick || add.isPending}
            onClick={() => add.mutate(Number(pick))}
          >
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setAdding(false);
              setPick('');
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {assigned.isLoading ? (
        <div className="skeleton" style={{ height: 60 }} />
      ) : assigned.isError ? (
        <div className="alert alert-error" role="alert">
          <span>Could not load presenters. {(assigned.error as Error).message}</span>
        </div>
      ) : rows.length === 0 ? (
        <p className="tab-empty">No presenters assigned yet.</p>
      ) : (
        <ul className="presenter-list">
          {rows.map((p) => (
            <li key={p.workshopPresenterId}>
              <div className="presenter-main">
                <span className="presenter-name">{p.name}</span>
                <span className="presenter-meta">
                  {p.agencyName ?? '—'}
                  {p.isRetired && <span className="pill pill-muted">Retired</span>}
                </span>
              </div>
              {canEdit && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => remove.mutate(p.workshopPresenterId)}
                  disabled={remove.isPending}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
