import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CreditSlipRow } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconCreditSlips } from '../components/icons';
import { CreditSlipDrawer } from '../components/CreditSlipDrawer';

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
 * A slip is used or not — there is no status column in the legacy table, so
 * the pill is derived from DateUsed. That keeps the two facts from drifting.
 */
function StatusCell({ r }: { r: CreditSlipRow }) {
  if (r.DateUsed) return <span className="pill pill-closed">Used</span>;
  return <span className="pill pill-open">Unused</span>;
}

const STATUS_OPTIONS = [
  ['all', 'All slips'],
  ['unused', 'Unused'],
  ['used', 'Used'],
] as const;

type Status = (typeof STATUS_OPTIONS)[number][0];

export function CreditSlipsPage() {
  const { user } = useAuth();
  const canEdit = user && ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'].includes(user.role);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [categoryId, setCategoryId] = useState('');
  const [trackingYear, setTrackingYear] = useState('');
  const [sort, setSort] = useState<'recent' | 'oldest' | 'amount' | 'participant'>('recent');
  const [page, setPage] = useState(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const pageSize = 25;

  // Deep links: /credit-slips?edit=<id>
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

  const categories = useQuery({
    queryKey: ['lookup', 'credit-slip-categories'],
    queryFn: () => api.lookups.get('credit-slip-categories'),
    staleTime: 10 * 60_000,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['credit-slips', debounced, status, categoryId, trackingYear, sort, page],
    queryFn: () =>
      api.creditSlips.list({
        page,
        pageSize,
        q: debounced || undefined,
        status,
        categoryId: categoryId ? Number(categoryId) : undefined,
        trackingYear: trackingYear ? Number(trackingYear) : undefined,
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
    <AppShell currentPath="/credit-slips" title="Credit slips">
      <div className="page-head">
        <div>
          <h2>Credit slips</h2>
          <p>Vouchers issued for cancellations and overpayments, redeemable against a future workshop.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Issue slip
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="cs-search" className="visually-hidden">Search credit slips</label>
          <input
            id="cs-search"
            type="search"
            placeholder="Search participant or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="field toolbar-select">
          <label htmlFor="cs-status" className="visually-hidden">Status</label>
          <select
            id="cs-status"
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
          <label htmlFor="cs-cat" className="visually-hidden">Category</label>
          <select
            id="cs-cat"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All categories</option>
            {(categories.data?.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>

        <div className="field toolbar-select">
          <label htmlFor="cs-year" className="visually-hidden">Tracking year</label>
          <input
            id="cs-year"
            type="number"
            placeholder="Year"
            min={2000}
            max={2200}
            value={trackingYear}
            onChange={(e) => {
              setTrackingYear(e.target.value);
              setPage(1);
            }}
            style={{ width: 90 }}
          />
        </div>

        <div className="field toolbar-select">
          <label htmlFor="cs-sort" className="visually-hidden">Sort</label>
          <select
            id="cs-sort"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as typeof sort);
              setPage(1);
            }}
          >
            <option value="recent">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="amount">Largest amount</option>
            <option value="participant">Participant A–Z</option>
          </select>
        </div>

        <span className="toolbar-count">{total.toLocaleString()} slips</span>
      </div>

      {counts && (
        <p className="tab-summary" style={{ marginTop: -4 }}>
          {counts.all.toLocaleString()} total · {counts.unused.toLocaleString()} unused (
          {fmtMoney(counts.totalAmount)} outstanding) · {counts.used.toLocaleString()} used
        </p>
      )}

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load credit slips.
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
              <IconCreditSlips width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced || status !== 'all' || categoryId || trackingYear
                  ? 'No credit slips match your filters.'
                  : 'No credit slips yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Participant</th>
                  <th scope="col">Category</th>
                  <th scope="col">Issued</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">Used</th>
                  <th scope="col" className="num">Year</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.CreditSlipID}>
                    <td data-label="Participant">
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => openEdit(r.CreditSlipID)}
                      >
                        {r.ParticipantName ?? 'No participant recorded'}
                      </button>
                      {r.ParticipantEmail && (
                        <div className="muted" style={{ fontSize: 12 }}>{r.ParticipantEmail}</div>
                      )}
                    </td>
                    <td data-label="Category" className="muted">{r.CreditSlipsCategory ?? '—'}</td>
                    <td data-label="Issued">{fmtDate(r.DateIssued)}</td>
                    <td data-label="Amount" className="num">{fmtMoney(r.Amount)}</td>
                    <td data-label="Status"><StatusCell r={r} /></td>
                    <td data-label="Used">
                      {r.DateUsed ? (
                        <>
                          {fmtDate(r.DateUsed)}
                          {r.UsedParticipantName && r.UsedParticipantID !== r.ParticipantID && (
                            <div className="muted" style={{ fontSize: 12 }}>
                              by {r.UsedParticipantName}
                            </div>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td data-label="Year" className="num">{r.TrackingYear ?? '—'}</td>
                    <td data-label="Actions" className="num">
                      <span className="row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => openEdit(r.CreditSlipID)}
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
        <CreditSlipDrawer
          creditSlipId={editingId}
          canEdit={!!canEdit}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </AppShell>
  );
}
