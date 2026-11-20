import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PresenterRow } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconPresenters } from '../components/icons';
import { PresenterDrawer } from '../components/PresenterDrawer';

function RetiredPill() {
  return <span className="pill pill-muted">Retired</span>;
}

export function PresentersPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const canDelete = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  // Deep link: /presenters?edit=<id> opens that presenter straight away.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('edit');
    if (id && /^\d+$/.test(id)) {
      setEditingId(Number(id));
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
    queryKey: ['presenters', { page, q: debounced, showRetired }],
    queryFn: () =>
      api.presenters.list({
        page,
        pageSize,
        q: debounced || undefined,
        includeRetired: showRetired,
      }),
  });

  const rows: PresenterRow[] = data?.data ?? [];
  const total = data?.total ?? 0;
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
    <AppShell currentPath="/presenters" title="Presenters & staff">
      <div className="page-head">
        <div>
          <h2>Presenters &amp; staff</h2>
          <p>People who deliver workshops.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add presenter
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="pr-search" className="visually-hidden">Search presenters</label>
          <input
            id="pr-search"
            type="search"
            placeholder="Search name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <label className="checkbox toolbar-checkbox">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => {
              setShowRetired(e.target.checked);
              setPage(1);
            }}
          />
          <span>Show retired</span>
        </label>

        <span className="toolbar-count">{total.toLocaleString()} presenters</span>
      </div>

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load presenters.
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
              <IconPresenters width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced ? 'No presenters match your search.' : 'No presenters yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Agency</th>
                  <th className="num">Workshops</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.PresenterStaffID}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => openEdit(p.PresenterStaffID)}
                      >
                        {[p.FirstName, p.LastName].filter(Boolean).join(' ') || 'Unnamed presenter'}
                      </button>
                    </td>
                    <td>{p.HomeEmail ?? '—'}</td>
                    <td>{p.WorkPhone ?? p.CellPhone ?? '—'}</td>
                    <td>{p.AgencyName ?? '—'}</td>
                    <td className="num">{p.WorkshopCount.toLocaleString()}</td>
                    <td>
                      {p.IsRetired ? <RetiredPill /> : <span className="cell-sub">Active</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {pageCount > 1 && (
        <div className="pager">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </button>
          <span className="pager-label">
            Page {page} of {pageCount}
          </span>
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

      {drawerOpen && (
        <PresenterDrawer
          presenterId={editingId}
          canDelete={canDelete}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </AppShell>
  );
}
