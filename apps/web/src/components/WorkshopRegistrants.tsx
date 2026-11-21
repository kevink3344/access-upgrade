import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

type Status = 'active' | 'cancelled' | 'all';

const PAGE_SIZE = 50;

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtMoney(v: number | null): string {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function StatusPill({ cancelled, attended }: { cancelled: boolean; attended: boolean }) {
  if (cancelled) return <span className="pill pill-cancelled">Cancelled</span>;
  if (attended) return <span className="pill pill-open">Attended</span>;
  return <span className="pill pill-closed">Registered</span>;
}

/**
 * Read-only roster for a workshop. Rows open the registration in the
 * Registrations screen rather than editing inline — attendance is managed
 * there, not here.
 */
export function WorkshopRegistrants({
  workshopId,
  capacity,
  onOpenRegistration,
}: {
  workshopId: number;
  capacity: number | null;
  onOpenRegistration: (registrationId: number) => void;
}) {
  const [status, setStatus] = useState<Status>('active');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [status, debounced]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['workshop-registrants', workshopId, status, debounced, page],
    queryFn: () => api.workshops.registrants(workshopId, { status, q: debounced, page, pageSize: PAGE_SIZE }),
  });

  const rows = data?.data ?? [];
  const counts = data?.counts;
  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const tabs: { key: Status; label: string; count: number | undefined }[] = [
    { key: 'active', label: 'Registered', count: counts?.active },
    { key: 'cancelled', label: 'Cancelled', count: counts?.cancelled },
    { key: 'all', label: 'All', count: counts?.all },
  ];

  return (
    <div>
      <p className="roster-summary">
        <strong>{counts?.active ?? 0}</strong> registered
        {capacity !== null && capacity > 0 && <> of <strong>{capacity}</strong> places</>}
        {' · '}
        <strong>{counts?.attended ?? 0}</strong> attended
        {counts && counts.cancelled > 0 && (
          <>
            {' · '}
            <strong>{counts.cancelled}</strong> cancelled
          </>
        )}
      </p>

      <div className="roster-head">
        <div className="roster-filters" role="group" aria-label="Filter registrants">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className="roster-filter"
              onClick={() => setStatus(t.key)}
              aria-pressed={status === t.key}
            >
              {t.label}
              {t.count !== undefined && <span className="roster-filter-count">{t.count}</span>}
            </button>
          ))}
        </div>
        <input
          className="input roster-search"
          type="search"
          placeholder="Search name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search registrants"
        />
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>Could not load registrants. {String((error as Error).message)}</span>
        </div>
      )}

      {isLoading ? (
        <div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton" style={{ height: 38, marginBottom: 8 }} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="roster-empty">
          <strong>
            {debounced
              ? 'No registrants match that search'
              : status === 'cancelled'
                ? 'No cancelled registrations'
                : 'No one has registered yet'}
          </strong>
          {status === 'active' && !debounced && (
            <span>Share the registration link to start taking sign-ups.</span>
          )}
        </div>
      ) : (
        <>
          <table className="roster-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Agency</th>
                <th scope="col">Registered</th>
                <th scope="col" className="num">Paid</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.RegistrationID}
                  className={`is-clickable${r.IsCancelled ? ' is-cancelled' : ''}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open registration for ${r.ParticipantName ?? 'participant'}`}
                  onClick={() => onOpenRegistration(r.RegistrationID)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenRegistration(r.RegistrationID);
                    }
                  }}
                >
                  <td>
                    <span className="roster-name">{r.ParticipantName?.trim() || '—'}</span>
                    {r.Email && <span className="roster-email">{r.Email}</span>}
                  </td>
                  <td>{r.AgencyName ?? '—'}</td>
                  <td>{fmtDate(r.RegistrationDate)}</td>
                  <td className="num">{fmtMoney(r.PaidAmount)}</td>
                  <td>
                    <StatusPill cancelled={r.IsCancelled} attended={r.Attended} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {lastPage > 1 && (
            <div className="roster-foot">
              <span>
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
                {isFetching && ' · updating…'}
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={page >= lastPage}
                  onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
                >
                  Next
                </button>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
