import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type LookupRow } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconCatalog } from '../components/icons';
import { LookupEntryDrawer } from '../components/LookupEntryDrawer';

/**
 * Settings > Dropdown lists.
 *
 * One screen for every reference list the API marks as maintainable. The
 * lists are discovered from GET /api/lookups rather than hard-coded, so a
 * lookup added to the API whitelist shows up here without a web change.
 */
export function DropdownListsPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';

  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const { data: lists, isLoading: listsLoading } = useQuery({
    queryKey: ['lookups'],
    queryFn: api.lookups.list,
    staleTime: 10 * 60_000,
  });

  const editable = (lists?.data ?? []).filter((l) => l.editable);

  // Open the first list so the screen is never blank.
  useEffect(() => {
    if (!selected && editable.length) setSelected(editable[0]!.key);
  }, [editable, selected]);

  const { data: settings } = useQuery({
    queryKey: ['lookup-settings', selected],
    queryFn: () => api.lookups.settings(selected!),
    enabled: !!selected,
    staleTime: 10 * 60_000,
  });

  const { data: rows, isLoading, isError, error } = useQuery({
    queryKey: ['lookup', selected],
    queryFn: () => api.lookups.get(selected!),
    enabled: !!selected,
  });

  const q = search.trim().toLowerCase();
  const visible: LookupRow[] = (rows?.data ?? []).filter(
    (r) => !q || (r.label ?? '').toLowerCase().includes(q),
  );

  const fields = settings?.data.fields ?? [];
  const extraFields = fields.filter((f) => f.key !== settings?.data.fields[0]?.key);

  function openCreate() {
    setEditingId(null);
    setDrawerOpen(true);
  }

  function openEdit(id: number) {
    setEditingId(id);
    setDrawerOpen(true);
  }

  return (
    <AppShell currentPath="/settings/dropdown-lists" title="Dropdown lists">
      <div className="page-head">
        <div>
          <h2>Dropdown lists</h2>
          <p>
            The choices offered in dropdowns across the app. Renaming an entry updates every record
            that uses it.
          </p>
        </div>
        {canEdit && selected && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add entry
          </button>
        )}
      </div>

      <div className="lookup-layout">
        <nav className="lookup-nav" aria-label="Dropdown lists">
          {listsLoading ? (
            <div style={{ padding: 12 }}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="skeleton" style={{ height: 32, marginBottom: 6 }} />
              ))}
            </div>
          ) : (
            editable.map((l) => (
              <button
                key={l.key}
                type="button"
                className={`lookup-nav-item${l.key === selected ? ' is-active' : ''}`}
                aria-current={l.key === selected ? 'true' : undefined}
                onClick={() => {
                  setSelected(l.key);
                  setSearch('');
                }}
              >
                {listLabel(l.key)}
              </button>
            ))
          )}
        </nav>

        <div className="lookup-main">
          {selected && (
            <div className="toolbar">
              <div className="field toolbar-search">
                <label htmlFor="lk-search" className="visually-hidden">
                  Search this list
                </label>
                <input
                  id="lk-search"
                  type="search"
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <span className="toolbar-count">
                {visible.length.toLocaleString()}
                {q && rows ? ` of ${rows.data.length.toLocaleString()}` : ''} entries
              </span>
            </div>
          )}

          {settings?.data.note && (
            <div className="alert alert-info" role="note">
              <span>{settings.data.note}</span>
            </div>
          )}

          {isError && (
            <div className="alert alert-error" role="alert">
              <span>
                Could not load this list.
                {error instanceof Error ? ` ${error.message}` : ''}
              </span>
            </div>
          )}

          <div className="panel">
            <div className="panel-body">
              {isLoading ? (
                <div style={{ padding: 18 }}>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="skeleton" style={{ height: 36, marginBottom: 8 }} />
                  ))}
                </div>
              ) : visible.length === 0 ? (
                <div className="empty">
                  <IconCatalog width={28} height={28} />
                  <p style={{ marginTop: 10 }}>
                    {q ? 'No entries match your search.' : 'This list is empty.'}
                  </p>
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{fields[0]?.label ?? 'Value'}</th>
                      {extraFields.map((f) => (
                        <th key={f.key}>{f.label}</th>
                      ))}
                      <th className="num">In use</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r.id}>
                        <td>
                          {canEdit ? (
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => openEdit(r.id)}
                            >
                              {r.label ?? '—'}
                            </button>
                          ) : (
                            (r.label ?? '—')
                          )}
                        </td>
                        {extraFields.map((f) => (
                          <td key={f.key}>
                            {f.type === 'boolean' ? (
                              r[f.key] ? (
                                <span className="pill pill-info">Yes</span>
                              ) : (
                                <span className="cell-sub">No</span>
                              )
                            ) : (
                              <span className="cell-sub">
                                {(r[f.key] as string | null) || '—'}
                              </span>
                            )}
                          </td>
                        ))}
                        <td className="num">
                          {(r.usageCount ?? 0) > 0 ? (
                            r.usageCount!.toLocaleString()
                          ) : (
                            <span className="cell-sub" style={{ color: 'var(--text-faint)' }}>
                              Unused
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>

      {drawerOpen && selected && (
        <LookupEntryDrawer
          lookupKey={selected}
          entryId={editingId}
          canDelete={!!canEdit}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </AppShell>
  );
}

/** Human name for a lookup key, e.g. `credit-slip-categories` -> "Credit slip categories". */
function listLabel(key: string): string {
  const words = key.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
