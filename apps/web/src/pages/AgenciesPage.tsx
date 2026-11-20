import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgencyRow } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconAgencies } from '../components/icons';
import { AgencyDrawer } from '../components/AgencyDrawer';

function OutOfBusinessPill() {
  return <span className="pill pill-muted">Out of business</span>;
}

function SitePill() {
  return <span className="pill pill-info">Workshop site</span>;
}

export function AgenciesPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const canDelete = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [showOutOfBusiness, setShowOutOfBusiness] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  // Deep link: /agencies?edit=<id> opens that agency straight away.
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
    queryKey: ['agencies', { page, q: debounced, showOutOfBusiness }],
    queryFn: () =>
      api.agencies.list({
        page,
        pageSize,
        q: debounced || undefined,
        includeOutOfBusiness: showOutOfBusiness,
      }),
  });

  const rows: AgencyRow[] = data?.data ?? [];
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
    <AppShell currentPath="/agencies" title="Agencies">
      <div className="page-head">
        <div>
          <h2>Agencies</h2>
          <p>Schools, childcare centres and community organisations.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add agency
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="ag-search" className="visually-hidden">Search agencies</label>
          <input
            id="ag-search"
            type="search"
            placeholder="Search name or short name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <label className="checkbox toolbar-checkbox">
          <input
            type="checkbox"
            checked={showOutOfBusiness}
            onChange={(e) => {
              setShowOutOfBusiness(e.target.checked);
              setPage(1);
            }}
          />
          <span>Show out of business</span>
        </label>

        <span className="toolbar-count">{total.toLocaleString()} agencies</span>
      </div>

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load agencies.
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
              <IconAgencies width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced
                  ? 'No agencies match your search.'
                  : 'No agencies yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Agency</th>
                  <th>Type</th>
                  <th>City</th>
                  <th>Phone</th>
                  <th className="num">Participants</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.AgencyID}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => openEdit(a.AgencyID)}
                      >
                        {a.AgencyName ?? 'Unnamed agency'}
                      </button>
                      {a.AgencyShortName && (
                        <div className="cell-sub">{a.AgencyShortName}</div>
                      )}
                    </td>
                    <td>{a.AgencyType ?? '—'}</td>
                    <td>{a.City ?? '—'}</td>
                    <td>{a.AgencyPhone ?? '—'}</td>
                    <td className="num">{a.ParticipantCount.toLocaleString()}</td>
                    <td>
                      {a.IsOutOfBusiness ? <OutOfBusinessPill /> : null}
                      {a.IsWorkshopSite ? <SitePill /> : null}
                      {!a.IsOutOfBusiness && !a.IsWorkshopSite ? (
                        <span className="cell-sub">Active</span>
                      ) : null}
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
        <AgencyDrawer
          agencyId={editingId}
          canDelete={canDelete}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </AppShell>
  );
}
