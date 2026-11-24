import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScoItemRow, ScoWorkshopOption } from '@pe/shared';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { IconSchoolCash } from '../components/icons';

/**
 * Step one of a School Cash upload: settle which workshop each item is for.
 *
 * This runs before any payment is matched, and deliberately so. The vendor's
 * item name and this app's workshop name are different vocabularies, so
 * guessing at the registration level put payments against the wrong workshop.
 * A typical file has 10-12 distinct items, so asking once per item is cheap
 * and makes everything downstream trustworthy.
 */

function money(n: number | null): string {
  if (n === null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function SchoolCashWorkshops({
  importId,
  canAdmin,
  onBack,
  onContinue,
}: {
  importId: number;
  canAdmin: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ScoItemRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = useQuery({
    queryKey: ['school-cash', 'items', importId],
    queryFn: () => api.schoolCash.items(importId),
  });

  const workshops = useQuery({
    queryKey: ['school-cash', 'workshops'],
    queryFn: () => api.schoolCash.workshops(),
    staleTime: 5 * 60_000,
  });

  const rows = items.data?.rows ?? [];
  const unresolved = items.data?.unresolved ?? 0;
  const ready = items.data?.ready ?? false;

  const resolved = useMemo(() => rows.filter((r) => r.WorkshopID !== null).length, [rows]);

  const resolve = useMutation({
    mutationFn: (vars: {
      itemId: number;
      body: Parameters<typeof api.schoolCash.resolveItem>[1];
    }) => api.schoolCash.resolveItem(vars.itemId, vars.body),
    onSuccess: () => {
      setEditing(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ['school-cash', 'items', importId] });
      qc.invalidateQueries({ queryKey: ['school-cash', 'workshops'] });
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not save that workshop.'),
  });

  return (
    <AppShell currentPath="/school-cash" title="School Cash matching">
      <div className="page-head">
        <div>
          <button type="button" className="link-button" onClick={onBack} style={{ marginBottom: 6 }}>
            ← All uploads
          </button>
          <h2>Step 1 — Which workshop is each item?</h2>
          <p>
            {rows.length.toLocaleString()} distinct item{rows.length === 1 ? '' : 's'} in this
            file · {resolved.toLocaleString()} resolved
          </p>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onContinue}
            disabled={rows.length === 0}
          >
            Continue to payments →
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {!ready && rows.length > 0 && (
        <div className="alert alert-warn" role="status">
          <span>
            <strong>
              {unresolved} item{unresolved === 1 ? '' : 's'} still need a workshop.
            </strong>{' '}
            You can continue — those items simply won't be matched to a payment. Match them here
            at any time and they will be picked up.
          </span>
        </div>
      )}

      <div className="panel">
        <div className="panel-body">
          {items.isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton" style={{ height: 48, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <IconSchoolCash width={28} height={28} />
              <p style={{ marginTop: 10 }}>This upload has no items.</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Item in the file</th>
                  <th scope="col" className="num">Rows</th>
                  <th scope="col" className="num">Price</th>
                  <th scope="col">Workshop</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ScoItemID}>
                    <td data-label="Item">{r.ItemName}</td>
                    <td data-label="Rows" className="num">{r.TotalRows.toLocaleString()}</td>
                    <td data-label="Price" className="num">{money(r.ItemBalance)}</td>
                    <td data-label="Workshop">
                      {r.WorkshopID ? (
                        <>
                          <strong>{r.WorkshopName ?? `Workshop ${r.WorkshopID}`}</strong>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {r.WorkshopCode ?? '—'}
                            {r.WorkshopDate ? ` · ${r.WorkshopDate}` : ''}
                          </div>
                        </>
                      ) : r.SuggestedWorkshopName ? (
                        <span className="muted">
                          Suggested: {r.SuggestedWorkshopName}
                          {r.SuggestionScore !== null && (
                            <> ({Math.round(r.SuggestionScore * 100)}% similar)</>
                          )}
                        </span>
                      ) : (
                        <span className="muted">No suggestion</span>
                      )}
                    </td>
                    <td data-label="Status">
                      {r.WorkshopID ? (
                        <span className="pill pill-open">
                          {r.ResolvedBy === 'Created' ? 'Created' : 'Matched'}
                        </span>
                      ) : (
                        <span className="pill pill-full">Select or create</span>
                      )}
                    </td>
                    <td data-label="Actions" className="num">
                      <span className="row-actions">
                        {canAdmin && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              setError(null);
                              setEditing(r);
                            }}
                          >
                            {r.WorkshopID ? 'Change' : 'Select…'}
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
      </div>

      {editing && (
        <WorkshopPicker
          item={editing}
          workshops={workshops.data?.rows ?? []}
          saving={resolve.isPending}
          onClose={() => setEditing(null)}
          onPick={(workshopId) => resolve.mutate({ itemId: editing.ScoItemID, body: { workshopId } })}
          onCreate={(create) => resolve.mutate({ itemId: editing.ScoItemID, body: { create } })}
        />
      )}
    </AppShell>
  );
}

/**
 * Pick an existing workshop or create a new one.
 *
 * The item name pre-fills the create form, because a new workshop is almost
 * always named after the item that prompted it.
 */
function WorkshopPicker({
  item,
  workshops,
  saving,
  onClose,
  onPick,
  onCreate,
}: {
  item: ScoItemRow;
  workshops: ScoWorkshopOption[];
  saving: boolean;
  onClose: () => void;
  onPick: (workshopId: number) => void;
  onCreate: (create: {
    newWorkshopName: string;
    workshopCode: string | null;
    startDate: string | null;
    price: number | null;
  }) => void;
}) {
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'pick' | 'create'>('pick');
  const [name, setName] = useState(item.ItemName);
  const [code, setCode] = useState('');
  const [startDate, setStartDate] = useState('');
  const [price, setPrice] = useState(item.ItemBalance === null ? '' : String(item.ItemBalance));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? workshops.filter(
          (w) =>
            w.workshopName.toLowerCase().includes(q) ||
            (w.workshopCode ?? '').toLowerCase().includes(q),
        )
      : workshops;
    return list.slice(0, 100);
  }, [workshops, search]);

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="sco-ws-title">
        <header className="drawer-head">
          <h2 id="sco-ws-title">Which workshop is this?</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="drawer-body">
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-body" style={{ padding: 14 }}>
              <div className="muted" style={{ fontSize: 12 }}>Item in the file</div>
              <div>{item.ItemName}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {item.TotalRows} row{item.TotalRows === 1 ? '' : 's'} · {money(item.ItemBalance)}
              </div>
            </div>
          </div>

          <div className="segmented" role="group" aria-label="Choose or create" style={{ marginBottom: 14 }}>
            <button
              type="button"
              className={mode === 'pick' ? 'is-active' : ''}
              onClick={() => setMode('pick')}
            >
              Select existing
            </button>
            <button
              type="button"
              className={mode === 'create' ? 'is-active' : ''}
              onClick={() => setMode('create')}
            >
              Create new
            </button>
          </div>

          {mode === 'pick' ? (
            <>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="sco-ws-search">Search workshops</label>
                <input
                  id="sco-ws-search"
                  type="search"
                  placeholder="Name or code…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              {filtered.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  No workshop matches. Create one instead.
                </p>
              ) : (
                <ul className="pick-list">
                  {filtered.map((w) => (
                    <li key={w.workshopId}>
                      <label className="pick-row">
                        <input
                          type="radio"
                          name="sco-ws"
                          checked={item.WorkshopID === w.workshopId}
                          onChange={() => onPick(w.workshopId)}
                          disabled={saving}
                        />
                        <span>
                          <strong>{w.workshopName}</strong>
                          <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                            {w.workshopCode ?? '—'} · {w.startDate ?? 'no date'} ·{' '}
                            {money(w.price)}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="sco-new-name">Workshop name</label>
                <input
                  id="sco-new-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="sco-new-code">Workshop code</label>
                <input
                  id="sco-new-code"
                  type="text"
                  placeholder="e.g. TPB2601"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="sco-new-date">Start date</label>
                <input
                  id="sco-new-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="sco-new-price">Price</label>
                <input
                  id="sco-new-price"
                  type="number"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving || name.trim() === ''}
                onClick={() =>
                  onCreate({
                    newWorkshopName: name.trim(),
                    workshopCode: code.trim() === '' ? null : code.trim(),
                    startDate: startDate === '' ? null : startDate,
                    price: price.trim() === '' ? null : Number(price),
                  })
                }
              >
                {saving ? 'Creating…' : 'Create workshop'}
              </button>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
