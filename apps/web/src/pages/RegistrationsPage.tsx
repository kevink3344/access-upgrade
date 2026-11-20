import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RegistrationRow } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconRegistrations } from '../components/icons';
import { RegistrationDrawer } from '../components/RegistrationDrawer';

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

function SourceTag({ source }: { source: RegistrationRow['Source'] }) {
  const label = source === 'Web' ? 'Web' : source === 'ESchools' ? 'eSchools' : 'Manual';
  return <span className={`source-tag source-${source.toLowerCase()}`}>{label}</span>;
}

function StatusCell({ r }: { r: RegistrationRow }) {
  if (r.IsCancelled) return <span className="pill pill-cancelled">Cancelled</span>;
  if (r.Attended) return <span className="pill pill-open">Attended</span>;
  if (r.PaidAmount !== null && r.PaidAmount <= 0) {
    return <span className="pill pill-full">Unpaid</span>;
  }
  return <span className="pill pill-closed">Registered</span>;
}

const STATUS_OPTIONS = [
  ['all', 'All statuses'],
  ['active', 'Active'],
  ['unpaid', 'Unpaid'],
  ['attended', 'Attended'],
  ['cancelled', 'Cancelled'],
] as const;

export function RegistrationsPage() {
  const { user } = useAuth();
  const canEdit = user && ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'].includes(user.role);
  const canCancel = user && ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(user.role);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number][0]>('all');
  const [source, setSource] = useState('');
  const [participantId, setParticipantId] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const pageSize = 25;

  // Deep links: /registrations?status=unpaid (dashboard), ?edit=<id>
  // (activity feed), ?participantId=<id> (participant screen).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const s = params.get('status');
    if (s && STATUS_OPTIONS.some(([v]) => v === s)) setStatus(s as typeof status);

    const p = params.get('participantId');
    if (p && /^\d+$/.test(p)) setParticipantId(Number(p));

    const edit = params.get('edit');
    if (edit && /^\d+$/.test(edit)) {
      setEditingId(Number(edit));
      setDrawerOpen(true);
    }

    if (s || p || edit) window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['registrations', debounced, status, source, participantId, page],
    queryFn: () =>
      api.registrations.list({
        page,
        pageSize,
        q: debounced || undefined,
        status,
        participantId,
        source: (source || undefined) as 'Manual' | 'Web' | 'ESchools' | undefined,
      }),
  });

  const rows = data?.data ?? [];
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
    <AppShell currentPath="/registrations" title="Registrations">
      <div className="page-head">
        <div>
          <h2>Registrations</h2>
          <p>Enrolments, payments and attendance.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add registration
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="reg-search" className="visually-hidden">Search registrations</label>
          <input
            id="reg-search"
            type="search"
            placeholder="Search participant, email, or workshop…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="field toolbar-select">
          <label htmlFor="reg-status" className="visually-hidden">Status</label>
          <select
            id="reg-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setPage(1);
            }}
          >
            {STATUS_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </div>

        <div className="field toolbar-select">
          <label htmlFor="reg-source" className="visually-hidden">Source</label>
          <select
            id="reg-source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All sources</option>
            <option value="Manual">Manual</option>
            <option value="Web">Web</option>
            <option value="ESchools">eSchools</option>
          </select>
        </div>

        <span className="toolbar-count">{total.toLocaleString()} registrations</span>
      </div>

      {participantId !== undefined && (
        <div className="filter-chip">
          <span>Filtered to one participant</span>
          <button
            type="button"
            onClick={() => {
              setParticipantId(undefined);
              setPage(1);
            }}
          >
            Clear
          </button>
        </div>
      )}

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load registrations.
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
              <IconRegistrations width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced || status !== 'all' || source
                  ? 'No registrations match your filters.'
                  : 'No registrations yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Participant</th>
                  <th scope="col">Workshop</th>
                  <th scope="col">Date</th>
                  <th scope="col">Registered</th>
                  <th scope="col" className="num">Paid</th>
                  <th scope="col">Status</th>
                  <th scope="col">Source</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.RegistrationID}>
                    <td data-label="Participant">
                      {canEdit ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => openEdit(r.RegistrationID)}
                        >
                          {r.ParticipantName ?? 'Unknown participant'}
                        </button>
                      ) : (
                        <strong>{r.ParticipantName ?? 'Unknown participant'}</strong>
                      )}
                      {r.Email && (
                        <div className="muted" style={{ fontSize: 12 }}>{r.Email}</div>
                      )}
                    </td>
                    <td data-label="Workshop">
                      {r.WorkshopName ?? 'Legacy workshop'}
                      {r.WorkshopCode && (
                        <div className="muted" style={{ fontSize: 12 }}>{r.WorkshopCode}</div>
                      )}
                    </td>
                    <td data-label="Date">{fmtDate(r.StartDate)}</td>
                    <td data-label="Registered">{fmtDate(r.RegistrationDate)}</td>
                    <td data-label="Paid" className="num">{fmtMoney(r.PaidAmount)}</td>
                    <td data-label="Status"><StatusCell r={r} /></td>
                    <td data-label="Source"><SourceTag source={r.Source} /></td>
                    <td data-label="Actions" className="num">
                      <span className="row-actions">
                        {canEdit && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => openEdit(r.RegistrationID)}
                          >
                            Edit
                          </button>
                        )}
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
        <RegistrationDrawer
          registrationId={editingId}
          canCancel={!!canCancel}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </AppShell>
  );
}
