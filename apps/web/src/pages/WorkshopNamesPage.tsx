import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkshopNameRow } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconCatalog } from '../components/icons';
import { WorkshopNameDrawer } from '../components/WorkshopNameDrawer';

export function WorkshopNamesPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const canDelete = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [showUnused, setShowUnused] = useState(true);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  // Deep link: /workshop-names?edit=<id> opens that entry straight away.
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
    queryKey: ['workshop-names', { page, q: debounced, showUnused }],
    queryFn: () =>
      api.workshopNames.list({
        page,
        pageSize,
        q: debounced || undefined,
        includeUnused: showUnused,
      }),
  });

  const rows: WorkshopNameRow[] = data?.data ?? [];
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
    <AppShell currentPath="/workshop-names" title="Workshop catalog">
      <div className="page-head">
        <div>
          <h2>Workshop catalog</h2>
          <p>Reusable workshop definitions. Each scheduled workshop points at one of these.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add catalog entry
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="wn-search" className="visually-hidden">Search the catalog</label>
          <input
            id="wn-search"
            type="search"
            placeholder="Search title or short name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <label className="checkbox toolbar-checkbox">
          <input
            type="checkbox"
            checked={showUnused}
            onChange={(e) => {
              setShowUnused(e.target.checked);
              setPage(1);
            }}
          />
          <span>Show unused</span>
        </label>

        <span className="toolbar-count">{total.toLocaleString()} entries</span>
      </div>

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load the catalog.
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
              <IconCatalog width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced ? 'No catalog entries match your search.' : 'No catalog entries yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Age group</th>
                  <th>Description</th>
                  <th className="num">Workshops</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((n) => (
                  <tr key={n.WorkshopNameID}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => openEdit(n.WorkshopNameID)}
                      >
                        {n.WorkshopName ?? 'Untitled'}
                      </button>
                      {n.ShortName && <div className="cell-sub">{n.ShortName}</div>}
                    </td>
                    <td>{n.Ages ?? '—'}</td>
                    <td>
                      {n.HasDescription ? (
                        <span className="cell-sub">Yes</span>
                      ) : (
                        <span className="cell-sub" style={{ color: 'var(--text-faint)' }}>
                          Missing
                        </span>
                      )}
                    </td>
                    <td className="num">{n.WorkshopCount.toLocaleString()}</td>
                    <td>
                      {n.IsLiteracy && <span className="pill pill-info">Literacy</span>}
                      {n.WorkshopCount === 0 && <span className="pill pill-muted">Unused</span>}
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
        <WorkshopNameDrawer
          workshopNameId={editingId}
          canDelete={canDelete}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </AppShell>
  );
}
