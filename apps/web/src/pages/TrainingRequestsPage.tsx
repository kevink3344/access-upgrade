import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TrainingRequestRow } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconRequests } from '../components/icons';
import { TrainingRequestDrawer } from '../components/TrainingRequestDrawer';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtMoney(n: number | null): string {
  if (n === null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Where a request is in the quote -> schedule -> invoice workflow.
 *
 * The steps are read from the child rows rather than stored, because the
 * legacy tables never carried a status column: a request is "scheduled"
 * because a workshop is linked to it, and "invoiced" because it has a number.
 */
function StageCell({ r }: { r: TrainingRequestRow }) {
  if (r.InvoiceNum) return <span className="pill pill-open">Invoiced</span>;
  if (r.ScheduledCount > 0) return <span className="pill pill-closed">Scheduled</span>;
  if (r.QuoteCount > 0) return <span className="pill pill-full">Quoted</span>;
  return <span className="pill pill-cancelled">New</span>;
}

const STATUS_OPTIONS = [
  ['all', 'All requests'],
  ['active', 'Active'],
  ['inactive', 'Closed'],
  ['invoiced', 'Invoiced'],
  ['uninvoiced', 'Not invoiced'],
] as const;

type Status = (typeof STATUS_OPTIONS)[number][0];

export function TrainingRequestsPage() {
  const { user } = useAuth();
  const canEdit = user && ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'].includes(user.role);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [sort, setSort] = useState<'recent' | 'oldest' | 'agency'>('recent');
  const [page, setPage] = useState(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const pageSize = 25;

  // Deep links: /training-requests?edit=<id>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const edit = params.get('edit');
    if (edit && /^\d+$/.test(edit)) {
      setEditingId(Number(edit));
      setDrawerOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['training-requests', debounced, status, sort, page],
    queryFn: () =>
      api.trainingRequests.list({
        page,
        pageSize,
        q: debounced || undefined,
        status,
        sort,
      }),
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  function openCreate() {
    setEditingId(null);
    setDrawerOpen(true);
  }

  function openEdit(id: number) {
    setEditingId(id);
    setDrawerOpen(true);
  }

  return (
    <AppShell currentPath="/training-requests" title="Training requests">
      <div className="page-head">
        <div>
          <h2>Training requests</h2>
          <p>On-site training an agency has asked for, from quote to invoice.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add request
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="tr-search" className="visually-hidden">Search training requests</label>
          <input
            id="tr-search"
            type="search"
            placeholder="Search agency, contact, or invoice number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="field toolbar-select">
          <label htmlFor="tr-status" className="visually-hidden">Status</label>
          <select
            id="tr-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as Status);
              setPage(1);
            }}
          >
            {STATUS_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </div>

        <div className="field toolbar-select">
          <label htmlFor="tr-sort" className="visually-hidden">Sort</label>
          <select
            id="tr-sort"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as typeof sort);
              setPage(1);
            }}
          >
            <option value="recent">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="agency">Agency A–Z</option>
          </select>
        </div>

        <span className="toolbar-count">{total.toLocaleString()} requests</span>
      </div>

      {counts && (
        <p className="tab-summary" style={{ marginTop: -4 }}>
          {counts.all.toLocaleString()} total · {counts.active.toLocaleString()} active ·{' '}
          {counts.invoiced.toLocaleString()} invoiced · {counts.uninvoiced.toLocaleString()} not invoiced
        </p>
      )}

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load training requests.
            {error instanceof Error ? ` ${error.message}` : ''}
          </span>
        </div>
      )}

      <div className="panel">
        <div className="panel-body">
          {isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <IconRequests width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced || status !== 'all'
                  ? 'No training requests match your filters.'
                  : 'No training requests yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Agency</th>
                  <th scope="col">Requested by</th>
                  <th scope="col">Requested</th>
                  <th scope="col" className="num">Participants</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Invoice</th>
                  <th scope="col" className="num">Amount due</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.TrainingRequestID}>
                    <td data-label="Agency">
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => openEdit(r.TrainingRequestID)}
                      >
                        {r.AgencyName ?? 'No agency recorded'}
                      </button>
                      {!r.IsActive && (
                        <div className="muted" style={{ fontSize: 12 }}>Closed</div>
                      )}
                    </td>
                    <td data-label="Requested by">
                      {r.RequestedBy ?? '—'}
                      {r.RequestEmail && (
                        <div className="muted" style={{ fontSize: 12 }}>{r.RequestEmail}</div>
                      )}
                    </td>
                    <td data-label="Requested">{fmtDate(r.RequestDate)}</td>
                    <td data-label="Participants" className="num">{r.ParticipantCount ?? '—'}</td>
                    <td data-label="Stage"><StageCell r={r} /></td>
                    <td data-label="Invoice">
                      {r.InvoiceNum ?? '—'}
                      {r.InvoiceDate && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {fmtDate(r.InvoiceDate)}
                        </div>
                      )}
                    </td>
                    <td data-label="Amount due" className="num">{fmtMoney(r.AmtDue)}</td>
                    <td data-label="Actions" className="num">
                      <span className="row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => openEdit(r.TrainingRequestID)}
                        >
                          {canEdit ? 'Open' : 'View'}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {pageCount > 1 && (
          <div className="pager">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </button>
            <span className="pager-info">Page {page} of {pageCount.toLocaleString()}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
            >
              Next
            </button>
          </div>
        )}
      </div>

      {drawerOpen && (
        <TrainingRequestDrawer
          trainingRequestId={editingId}
          canEdit={!!canEdit}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </AppShell>
  );
}
