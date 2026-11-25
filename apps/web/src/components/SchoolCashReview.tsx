import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScoApplyResult, ScoMatchConfidence } from '@pe/shared';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { IconSchoolCash } from '../components/icons';

/**
 * The payment step: what the matcher decided, and the means to apply it.
 *
 * This screen is read-only. Every decision that could change a match is made
 * on step one, where the workshop is chosen — matching a row to a different
 * registration here would mean the payment disagrees with the workshop the
 * admin already confirmed. A row is either matched or it is not; staff can
 * read the reason, and nothing on this screen can alter it.
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
  focusRowId = null,
  onBack,
  onBackToWorkshops,
}: {
  importId: number;
  canAdmin: boolean;
  /** A vendor row to highlight, when arriving from a payment record. */
  focusRowId?: number | null;
  onBack: () => void;
  onBackToWorkshops: () => void;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [applyResult, setApplyResult] = useState<ScoApplyResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const items = useQuery({
    queryKey: ['school-cash', 'items', importId],
    queryFn: () => api.schoolCash.items(importId),
  });

  const focusRef = useRef<HTMLTableRowElement | null>(null);

  const unresolvedItems = useMemo(
    () => (items.data?.rows ?? []).filter((i) => i.WorkshopID === null),
    [items.data],
  );

  const detail = useQuery({
    queryKey: ['school-cash', 'import', importId],
    queryFn: () => api.schoolCash.import(importId),
  });

  /**
   * Bring the linked row into view once the table has rendered.
   *
   * Arriving from a payment record with a row id is a "show me this one"
   * request, so the row is scrolled to rather than left somewhere in a
   * 106-row table. It also carries a highlight, so the eye lands on it.
   */
  useEffect(() => {
    if (focusRowId === null || !focusRef.current) return;
    focusRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusRowId, detail.data]);

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

  // A matched row whose place was already paid for is settled, not payable �
  // the apply endpoint skips it, so the button must not count it.
  const readyToApply = useMemo(
    () =>
      rows.filter(
        (r) => r.MatchConfidence === 'High' && r.AppliedPaymentID === null && !r.IgnoreReason,
      ).length,
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
      if (r.MatchConfidence !== 'High' || !!r.IgnoreReason) continue;
      itemValue += r.ItemBalance ?? 0;
      fees += r.TransactionFee ?? 0;
    }
    return { itemValue, fees };
  }, [rows]);

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

      {applyResult && applyResult.items.some((i) => i.AlreadyPaid > 0) && (
        <div className="alert alert-info" role="status">
          <span>
            <strong>Some workshops had nothing left to pay.</strong> These people are already
            paid for that workshop, so no second payment was recorded:
            <ul style={{ margin: '6px 0 0 18px' }}>
              {applyResult.items
                .filter((i) => i.AlreadyPaid > 0)
                .map((i) => (
                  <li key={i.ScoItemID}>
                    {i.WorkshopName ?? i.ItemName} — {i.AlreadyPaid} of {i.TotalRows} row
                    {i.TotalRows === 1 ? '' : 's'} already paid
                  </li>
                ))}
            </ul>
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
              Choose workshops
            </button>
          </span>
        </div>
      )}

      {isStaged && needsReview > 0 && !applyResult && (
        <div className="alert alert-warn" role="status">
          <span>
            <strong>
              {needsReview} row{needsReview === 1 ? '' : 's'} could not be matched.
            </strong>{' '}
            Each one says why - usually the purchaser is not enrolled in that
            workshop, or the item has no workshop yet. Applying records the
            {readyToApply === 1 ? ' one' : ` ${readyToApply.toLocaleString()}`} matched row
            {readyToApply === 1 ? '' : 's'} and leaves these alone.
            {unresolvedItems.length > 0 && (
              <>
                {' '}
                <button type="button" className="link-button" onClick={onBackToWorkshops}>
                  Choose the missing workshops
                </button>
              </>
            )}
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
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  // ScoRowID is a BIGINT, which the driver hands back as a
                  // string, so compare as strings rather than by identity.
                  // The row is scrolled to, not tinted — the table's own
                  // striping is what tells staff where they are.
                  const isFocus =
                    focusRowId !== null && String(focusRowId) === String(r.ScoRowID);
                  return (
                  <tr key={r.ScoRowID} ref={isFocus ? focusRef : undefined}>
                    <td data-label="Purchaser">
                      {/*
                        Once the row has produced a payment, the purchaser name
                        is the way back to the money: it opens that
                        registration's record on Payments & receipts. Before
                        that there is nothing to link to, so it stays plain
                        text.
                      */}
                      {r.AppliedPaymentID !== null && r.MatchedRegistrationID !== null ? (
                        <a
                          className="link-button"
                          href={`/payments?edit=${r.MatchedRegistrationID}`}
                          title="Open this payment on Payments & receipts"
                        >
                          {r.PurchaserName ?? 'Unknown purchaser'}
                        </a>
                      ) : (
                        (r.PurchaserName ?? 'Unknown purchaser')
                      )}
                      <div className="muted" style={{ fontSize: 12 }}>{r.PurchaserEmail ?? '—'}</div>
                      {r.PurchaserFound === 0 && (
                        <span className="pill pill-full" style={{ marginTop: 4 }}>Not found</span>
                      )}
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
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 14 }}>
        Item price is the amount charged for the item; the fee is the online transaction charge.
        Revenue reports use the item price, so a $312 charge does not record $312 of income.
      </p>
    </AppShell>
  );
}
