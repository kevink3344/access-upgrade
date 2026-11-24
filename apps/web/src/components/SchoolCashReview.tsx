import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ScoApplyResult,
  ScoCandidate,
  ScoMatchConfidence,
  ScoRowRow,
} from '@pe/shared';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { IconSchoolCash } from '../components/icons';

/**
 * The review step: what the matcher decided, and the means to overrule it.
 *
 * The screen is deliberately read-only until "Apply". A staged import can be
 * edited freely; once applied the payments exist and the import is closed.
 */

function money(n: number | null): string {
  if (n === null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Formats a numeric field defensively — a null must not blank the page. */
function count(n: number | null | undefined): string {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ConfidencePill({ c }: { c: ScoMatchConfidence | null }) {
  if (c === 'High') return <span className="pill pill-open">High</span>;
  if (c === 'Low') return <span className="pill pill-full">Needs review</span>;
  if (c === 'Duplicate') return <span className="pill pill-info">Already uploaded</span>;
  if (c === 'Ignored') return <span className="pill pill-muted">Ignored</span>;
  return <span className="pill pill-full">Needs review</span>;
}

type Filter = 'all' | 'High' | 'review' | 'Ignored' | 'Duplicate';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'High', label: 'Matched' },
  { key: 'review', label: 'Needs review' },
  { key: 'Ignored', label: 'Ignored' },
  { key: 'Duplicate', label: 'Duplicates' },
];

export function SchoolCashReview({
  importId,
  canAdmin,
  onBack,
  onBackToWorkshops,
}: {
  importId: number;
  canAdmin: boolean;
  onBack: () => void;
  onBackToWorkshops: () => void;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [matching, setMatching] = useState<ScoRowRow | null>(null);
  const [applyResult, setApplyResult] = useState<ScoApplyResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const items = useQuery({
    queryKey: ['school-cash', 'items', importId],
    queryFn: () => api.schoolCash.items(importId),
  });

  const unresolvedItems = useMemo(
    () => (items.data?.rows ?? []).filter((i) => i.WorkshopID === null),
    [items.data],
  );

  const detail = useQuery({
    queryKey: ['school-cash', 'import', importId],
    queryFn: () => api.schoolCash.import(importId),
  });

  const apply = useMutation({
    mutationFn: () => api.schoolCash.apply(importId),
    onSuccess: (result) => {
      setApplyResult(result);
      setActionError(null);
      qc.invalidateQueries({ queryKey: ['school-cash'] });
    },
    onError: (err: unknown) =>
      setActionError(err instanceof Error ? err.message : 'Apply failed.'),
  });

  const discard = useMutation({
    mutationFn: () => api.schoolCash.discard(importId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['school-cash'] });
      onBack();
    },
    onError: (err: unknown) =>
      setActionError(err instanceof Error ? err.message : 'Discard failed.'),
  });

  const rows = detail.data?.rows ?? [];
  const counts = detail.data?.counts;
  const isStaged = detail.data?.Status === 'Staged';

  const readyToApply = useMemo(
    () => rows.filter((r) => r.MatchConfidence === 'High' && r.AppliedPaymentID === null).length,
    [rows],
  );

  const needsReview = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.AppliedPaymentID === null &&
          (r.MatchConfidence === 'Low' || r.MatchConfidence === 'None'),
      ).length,
    [rows],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'review') {
        if (r.MatchConfidence !== 'Low' && r.MatchConfidence !== 'None') return false;
      } else if (filter !== 'all' && r.MatchConfidence !== filter) {
        return false;
      }
      if (!q) return true;
      return (
        (r.PurchaserEmail ?? '').toLowerCase().includes(q) ||
        (r.PurchaserName ?? '').toLowerCase().includes(q) ||
        (r.ItemName ?? '').toLowerCase().includes(q) ||
        (r.ParticipantName ?? '').toLowerCase().includes(q) ||
        (r.WorkshopCode ?? '').toLowerCase().includes(q) ||
        (r.WorkshopName ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, filter, search]);

  const totals = useMemo(() => {
    let itemValue = 0;
    let fees = 0;
    for (const r of rows) {
      if (r.MatchConfidence !== 'High') continue;
      itemValue += r.ItemBalance ?? 0;
      fees += r.TransactionFee ?? 0;
    }
    return { itemValue, fees };
  }, [rows]);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['school-cash', 'import', importId] });
    qc.invalidateQueries({ queryKey: ['school-cash', 'imports'] });
  }

  return (
    <AppShell currentPath="/school-cash" title="School Cash matching">
      <div className="page-head">
        <div>
          <button type="button" className="link-button" onClick={onBack} style={{ marginBottom: 6 }}>
            ← All uploads
          </button>
          {' · '}
          <button type="button" className="link-button" onClick={onBackToWorkshops} style={{ marginBottom: 6 }}>
            Workshops
          </button>
          <h2>Step 2 — {detail.data?.FileName ?? 'Upload'}</h2>
          <p>
            Uploaded {fmtDate(detail.data?.UploadedAt ?? null)} by{' '}
            {detail.data?.UploadedBy ?? '—'} · {rows.length.toLocaleString()} rows in this file
          </p>
        </div>
        {canAdmin && isStaged && (
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (
                  window.confirm(
                    'Delete this upload? The file and its staged rows are removed. Nothing has been paid, so no payments are affected.',
                  )
                ) {
                  discard.mutate();
                }
              }}
              disabled={discard.isPending || apply.isPending || (detail.data?.AppliedCount ?? 0) > 0}
              title={
                (detail.data?.AppliedCount ?? 0) > 0
                  ? 'Some rows from this upload have already produced payments.'
                  : undefined
              }
            >
              {discard.isPending ? 'Deleting…' : 'Delete upload'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => apply.mutate()}
              disabled={apply.isPending || readyToApply === 0}
            >
              {apply.isPending
                ? 'Applying…'
                : `Apply ${readyToApply.toLocaleString()} payment${readyToApply === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
      </div>

      {actionError && (
        <div className="alert alert-error" role="alert">
          <span>{actionError}</span>
        </div>
      )}

      {applyResult && (
        <div className="alert alert-success" role="status">
          <span>
            <strong>
              {applyResult.applied.toLocaleString()} payment
              {applyResult.applied === 1 ? '' : 's'} applied.
            </strong>{' '}
            {applyResult.skipped > 0 &&
              `${applyResult.skipped} row${applyResult.skipped === 1 ? '' : 's'} could not be applied — see below.`}
            {needsReview > 0 &&
              ` ${needsReview} row${needsReview === 1 ? '' : 's'} still need review; resolve them and apply again.`}
            {applyResult.unresolved > 0 &&
              ` ${applyResult.unresolved} item${applyResult.unresolved === 1 ? '' : 's'} had no workshop, so their rows were not matched.`}
          </span>
        </div>
      )}

      {applyResult && applyResult.conflicts.length > 0 && (
        <div className="alert alert-warn" role="status">
          <span>
            <strong>Not applied:</strong>
            <ul style={{ margin: '6px 0 0 18px' }}>
              {applyResult.conflicts.map((c) => (
                <li key={c.rowNumber}>
                  Row {c.rowNumber} — {c.itemName ?? 'unnamed item'}: {c.reason}
                </li>
              ))}
            </ul>
          </span>
        </div>
      )}

      {(counts?.Duplicate ?? 0) > 0 && (
        <div className="alert alert-info" role="status">
          <span>
            <strong>
              {counts!.Duplicate.toLocaleString()} row
              {counts!.Duplicate === 1 ? ' was' : 's were'} skipped as already uploaded.
            </strong>{' '}
            These purchases are in another upload or already paid, so they will not be recorded
            twice. Filter to <em>Duplicates</em> to see them.
          </span>
        </div>
      )}

      {unresolvedItems.length > 0 && (
        <div className="alert alert-warn" role="status">
          <span>
            <strong>
              {unresolvedItems.length} item{unresolvedItems.length === 1 ? '' : 's'} in this file
              {unresolvedItems.length === 1 ? ' has' : ' have'} no workshop yet.
            </strong>{' '}
            Rows for these will not be matched:
            <ul style={{ margin: '6px 0 0 18px' }}>
              {unresolvedItems.map((i) => (
                <li key={i.ScoItemID}>
                  {i.ItemName} ({i.TotalRows} row{i.TotalRows === 1 ? '' : 's'})
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="link-button"
              onClick={onBackToWorkshops}
              style={{ marginTop: 8 }}
            >
              Match these workshops
            </button>
          </span>
        </div>
      )}

      {isStaged && needsReview > 0 && !applyResult && (
        <div className="alert alert-warn" role="status">
          <span>
            <strong>
              {needsReview} row{needsReview === 1 ? '' : 's'} still need review.
            </strong>{' '}
            Match or ignore each one before applying — applying now would leave those payments
            unrecorded.
          </span>
        </div>
      )}

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="sc-row-search" className="visually-hidden">Search rows</label>
          <input
            id="sc-row-search"
            type="search"
            placeholder="Purchaser, participant, item or workshop…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="segmented" role="group" aria-label="Filter rows">
          {FILTERS.map((f) => {
            const n =
              f.key === 'all'
                ? rows.length
                : f.key === 'review'
                  ? (counts?.Low ?? 0) + (counts?.None ?? 0)
                  : (counts?.[f.key as ScoMatchConfidence] ?? 0);
            return (
              <button
                key={f.key}
                type="button"
                className={filter === f.key ? 'is-active' : ''}
                onClick={() => setFilter(f.key)}
              >
                {f.label} ({count(n)})
              </button>
            );
          })}
        </div>

        <span className="toolbar-count">
          {money(totals.itemValue)} item value · {money(totals.fees)} fees
        </span>
      </div>

      {detail.isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load this upload.
            {detail.error instanceof Error ? ` ${detail.error.message}` : ''}
          </span>
        </div>
      )}

      <div className="panel">
        <div className="panel-body">
          {detail.isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="skeleton" style={{ height: 48, marginBottom: 8 }} />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <IconSchoolCash width={28} height={28} />
              <p style={{ marginTop: 10 }}>No rows match this filter.</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Purchaser</th>
                  <th scope="col">Item</th>
                  <th scope="col" className="num">Item price</th>
                  <th scope="col" className="num">Fee</th>
                  <th scope="col">Matched to</th>
                  <th scope="col">Confidence</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.ScoRowID}>
                    <td data-label="Purchaser">
                      {r.PurchaserName ?? 'Unknown purchaser'}
                      <div className="muted" style={{ fontSize: 12 }}>{r.PurchaserEmail ?? '—'}</div>
                    </td>
                    <td data-label="Item">
                      {r.ItemName ?? '—'}
                      <div className="muted" style={{ fontSize: 12 }}>
                        Item {r.ItemId ?? '—'} · purchased {r.PurchasedDate ?? '—'}
                      </div>
                    </td>
                    <td data-label="Item price" className="num">{money(r.ItemBalance)}</td>
                    <td data-label="Fee" className="num">{money(r.TransactionFee)}</td>
                    <td data-label="Matched to">
                      {r.MatchedRegistrationID ? (
                        <>
                          <strong>{r.WorkshopName ?? `Registration ${r.MatchedRegistrationID}`}</strong>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {r.WorkshopCode ?? '—'}
                            {r.WorkshopDate ? ` · ${r.WorkshopDate}` : ''}
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {r.ParticipantName ?? 'Unknown participant'}
                          </div>
                        </>
                      ) : (
                        <span className="muted">{r.MatchNote ?? '—'}</span>
                      )}
                      {r.MatchConfidence === 'High' && r.MatchNote && (
                        <div className="muted" style={{ fontSize: 12 }}>{r.MatchNote}</div>
                      )}
                      {r.IgnoreReason && (
                        <div className="muted" style={{ fontSize: 12 }}>{r.IgnoreReason}</div>
                      )}
                    </td>
                    <td data-label="Confidence"><ConfidencePill c={r.MatchConfidence} /></td>
                    <td data-label="Actions" className="num">
                      <span className="row-actions">
                        {canAdmin && isStaged && r.AppliedPaymentID === null && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setMatching(r)}
                          >
                            {r.MatchConfidence === 'Ignored'
                              ? 'Undo'
                              : r.MatchedRegistrationID
                                ? 'Change'
                                : 'Match…'}
                          </button>
                        )}
                        {r.AppliedPaymentID !== null && (
                          <span className="muted" style={{ fontSize: 12 }}>
                            Payment #{r.AppliedPaymentID}
                          </span>
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

      <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 14 }}>
        Item price is the amount charged for the item; the fee is the online transaction charge.
        Revenue reports use the item price, so a $312 charge does not record $312 of income.
      </p>

      {matching && (
        <MatchDrawer
          importId={importId}
          row={matching}
          onClose={() => setMatching(null)}
          onSaved={() => {
            setMatching(null);
            invalidate();
          }}
        />
      )}
    </AppShell>
  );
}

/**
 * Manual match.
 *
 * Defaults to the purchaser's own unpaid registrations, because that is the
 * common case. The search box covers the rest: a parent paying for a
 * colleague, or a purchaser email that belongs to a bookkeeper rather than
 * the participant.
 */
function MatchDrawer({
  importId,
  row,
  onClose,
  onSaved,
}: {
  importId: number;
  row: ScoRowRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<number | null>(row.MatchedRegistrationID);
  const [ignoreReason, setIgnoreReason] = useState(row.IgnoreReason ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const candidates = useQuery({
    queryKey: ['school-cash', 'candidates', importId, row.ScoRowID, debounced],
    queryFn: () =>
      api.schoolCash.candidates(importId, {
        rowId: row.ScoRowID,
        q: debounced || undefined,
      }),
  });

  const save = useMutation({
    mutationFn: (body: { registrationId?: number | null; ignore?: boolean; ignoreReason?: string | null }) =>
      api.schoolCash.matchRow(row.ScoRowID, body),
    onSuccess: onSaved,
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Could not save.'),
  });

  const rows: ScoCandidate[] = candidates.data?.rows ?? [];

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="sc-match-title">
        <header className="drawer-head">
          <h2 id="sc-match-title">Match this row</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="drawer-body">
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            {row.ItemName ?? 'Unnamed item'} · {money(row.ItemBalance)}
          </p>

          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-body" style={{ padding: 14 }}>
              <div className="muted" style={{ fontSize: 12 }}>Purchaser</div>
              <div>{row.PurchaserName ?? 'Unknown'}</div>
              <div className="muted" style={{ fontSize: 12 }}>{row.PurchaserEmail ?? 'No email'}</div>
              {row.MatchNote && (
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{row.MatchNote}</p>
              )}
            </div>
          </div>

          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="sc-cand-search">Find a participant or workshop</label>
            <input
              id="sc-cand-search"
              type="search"
              placeholder="Name, email or workshop…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {error && (
            <div className="alert alert-error" role="alert">
              <span>{error}</span>
            </div>
          )}

          {candidates.isLoading ? (
            <div className="skeleton" style={{ height: 120 }} />
          ) : rows.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>
              {debounced
                ? 'No unpaid registrations match that search.'
                : 'This purchaser has no unpaid registrations. Search for someone else, or ignore the row.'}
            </p>
          ) : (
            <ul className="pick-list">
              {rows.map((c) => (
                <li key={c.RegistrationID}>
                  <label className="pick-row">
                    <input
                      type="radio"
                      name="sc-candidate"
                      checked={selected === c.RegistrationID}
                      onChange={() => setSelected(c.RegistrationID)}
                    />
                    <span>
                      <strong>{c.WorkshopName ?? c.WorkshopCode ?? 'Workshop'}</strong>
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                        {c.WorkshopCode ?? '—'} · {c.ParticipantName} · {c.WorkshopDate ?? 'no date'} ·
                        owes {money(c.Owed)}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="field" style={{ marginTop: 18 }}>
            <label htmlFor="sc-ignore">Or ignore this row</label>
            <input
              id="sc-ignore"
              type="text"
              placeholder="Reason, e.g. refunded in full"
              value={ignoreReason}
              onChange={(e) => setIgnoreReason(e.target.value)}
            />
          </div>
        </div>

        <div className="drawer-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() =>
              save.mutate({ ignore: true, ignoreReason: ignoreReason || 'Dismissed by an admin.' })
            }
            disabled={save.isPending}
          >
            Ignore row
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => save.mutate({ registrationId: selected })}
            disabled={save.isPending || selected === null}
          >
            {save.isPending ? 'Saving…' : 'Match'}
          </button>
        </div>
      </aside>
    </div>
  );
}
