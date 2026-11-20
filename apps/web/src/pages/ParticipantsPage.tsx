import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconParticipants } from '../components/icons';
import { ParticipantDrawer } from '../components/ParticipantDrawer';

function initials(first: string | null, last: string | null): string {
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase() || '?';
}

export function ParticipantsPage() {
  const { user } = useAuth();
  const canEdit = user && ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'].includes(user.role);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [agencyId, setAgencyId] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'name' | 'email' | 'agency'>('name');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const pageSize = 25;

  // Deep link: /participants?edit=<id>
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

  const { data: agencies } = useQuery({
    queryKey: ['agencies', 'picker'],
    queryFn: () => api.agencies.list({ pageSize: 200 }),
    staleTime: 10 * 60_000,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['participants', debounced, agencyId, page, sort, dir],
    queryFn: () =>
      api.participants.list({
        page,
        pageSize,
        q: debounced || undefined,
        agencyId: agencyId ? Number(agencyId) : undefined,
        sort,
        dir,
      }),
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  function toggleSort(col: typeof sort) {
    if (sort === col) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(col);
      setDir('asc');
    }
    setPage(1);
  }

  function sortIndicator(col: typeof sort) {
    return sort === col ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
  }

  function openCreate() {
    setEditingId(null);
    setDrawerOpen(true);
  }

  function openEdit(id: number) {
    setEditingId(id);
    setDrawerOpen(true);
  }

  return (
    <AppShell currentPath="/participants" title="Participants">
      <div className="page-head">
        <div>
          <h2>Participants</h2>
          <p>Teachers, parents and staff who attend workshops.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add participant
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="p-search" className="visually-hidden">Search participants</label>
          <input
            id="p-search"
            type="search"
            placeholder="Search name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="field toolbar-select">
          <label htmlFor="p-agency" className="visually-hidden">Agency</label>
          <select
            id="p-agency"
            value={agencyId}
            onChange={(e) => {
              setAgencyId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All agencies</option>
            {agencies?.data.map((a) => (
              <option key={a.AgencyID} value={a.AgencyID}>
                {a.AgencyName ?? `Agency ${a.AgencyID}`}
              </option>
            ))}
          </select>
        </div>

        <span className="toolbar-count">{total.toLocaleString()} participants</span>
      </div>

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load participants.
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
              <IconParticipants width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced || agencyId
                  ? 'No participants match your filters.'
                  : 'No participants yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">
                    <button type="button" className="th-sort" onClick={() => toggleSort('name')}>
                      Name{sortIndicator('name')}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="th-sort" onClick={() => toggleSort('email')}>
                      Email{sortIndicator('email')}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="th-sort" onClick={() => toggleSort('agency')}>
                      Agency{sortIndicator('agency')}
                    </button>
                  </th>
                  <th scope="col" className="num">Registrations</th>
                  <th scope="col">Certificates</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unnamed';
                  return (
                    <tr key={p.participantId}>
                      <td data-label="Name">
                        <span className="user-cell">
                          <span className="avatar avatar-sm" aria-hidden="true">
                            {initials(p.firstName, p.lastName)}
                          </span>
                          <span>
                            {canEdit ? (
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => openEdit(p.participantId)}
                              >
                                {name}
                              </button>
                            ) : (
                              <strong>{name}</strong>
                            )}
                          </span>
                        </span>
                      </td>
                      <td data-label="Email" className="muted">{p.email ?? '—'}</td>
                      <td data-label="Agency" className="muted">{p.agencyName ?? '—'}</td>
                      <td data-label="Registrations" className="num">
                        {p.registrationCount > 0 ? (
                          <a
                            className="link-button"
                            href={`/registrations?participantId=${p.participantId}`}
                          >
                            {p.registrationCount}
                          </a>
                        ) : (
                          <span className="muted">0</span>
                        )}
                      </td>
                      <td data-label="Certificates">
                        {p.hasCeuCertificate && <span className="cert-tag">CEU</span>}
                        {p.hasChcCertificate && <span className="cert-tag">CHC</span>}
                        {!p.hasCeuCertificate && !p.hasChcCertificate && (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td data-label="Actions" className="num">
                        <span className="row-actions">
                          {canEdit && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => openEdit(p.participantId)}
                            >
                              Edit
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
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
        <ParticipantDrawer
          participantId={editingId}
          canDelete={!!(user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role))}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </AppShell>
  );
}
