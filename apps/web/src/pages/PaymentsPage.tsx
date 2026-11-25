import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PaymentRow } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconPayments } from '../components/icons';
import { PaymentDrawer } from '../components/PaymentDrawer';
import { AddPaymentDrawer } from '../components/AddPaymentDrawer';

/** First and last day of the current month, as YYYY-MM-DD. */
function currentMonth(): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = now.getMonth();
  return {
    from: `${y}-${pad(m + 1)}-01`,
    to: `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`,
  };
}

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Dates arrive as UTC midnight and are stored as calendar dates, so they are
 * formatted in UTC too - otherwise a browser west of Greenwich shows the
 * previous day.
 */
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "Sep 1 – Sep 30, 2026", or "From Sep 1, 2026" when only one end is set. */
function fmtWindow(from: string | null | undefined, to: string | null | undefined): string {
  const short = (iso: string) =>
    new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const long = (iso: string) =>
    new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });

  if (from && to) {
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    return `${short(from)} – ${sameYear ? short(to) : long(to)}, ${to.slice(0, 4)}`;
  }
  if (from) return `From ${long(from)}`;
  if (to) return `Through ${long(to)}`;
  return 'All dates';
}

export function PaymentsPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN' || user?.role === 'MANAGER';

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<'all' | 'paid' | 'unpaid' | 'refunded'>('all');
  const [methodId, setMethodId] = useState('');
  // The screen opens on the current month. Staff widen it with the date
  // fields when they need to look further back.
  const month = currentMonth();
  const [from, setFrom] = useState(month.from);
  const [to, setTo] = useState(month.to);
  const [showCancelled, setShowCancelled] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [addPayment, setAddPayment] = useState<{ id: number; label: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Deep link: /payments?edit=<registrationId> opens that payment.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('edit');
    if (id && /^\d+$/.test(id)) {
      setDrawerId(Number(id));
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

  const { data: methods } = useQuery({
    queryKey: ['lookup', 'payment-methods'],
    queryFn: () => api.lookups.get('payment-methods'),
    staleTime: 10 * 60_000,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['payments', { page, q: debounced, status, methodId, from, to, showCancelled }],
    queryFn: () =>
      api.payments.list({
        page,
        pageSize,
        q: debounced || undefined,
        status,
        paymentMethodId: methodId ? Number(methodId) : undefined,
        from: from || undefined,
        to: to || undefined,
        includeCancelled: showCancelled,
      }),
  });

  const rows: PaymentRow[] = data?.data ?? [];
  const total = data?.total ?? 0;
  const totals = data?.totals ?? { total: 0, paid: 0, refunded: 0 };
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const windowLabel = fmtWindow(data?.window?.from ?? from, data?.window?.to ?? to);

  function resetFilters() {
    const m = currentMonth();
    setStatus('all');
    setMethodId('');
    setFrom(m.from);
    setTo(m.to);
    setShowCancelled(false);
    setSearch('');
    setPage(1);
  }

  function openAddPayment(participant?: { id: number; label: string }) {
    setAddPayment(participant ?? null);
    setAddOpen(true);
  }

  return (
    <AppShell currentPath="/payments" title="Payments & receipts">
      <div className="page-head">
        <div>
          <h2>Payments &amp; receipts</h2>
          <p>Money recorded against each registration.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={() => openAddPayment()}>
            Add payment
          </button>
        )}
      </div>

      {/* Totals cover the whole filtered set, not just this page - a
          paginated total would mislead on a financial screen. The date
          window is stated on every card so nobody reads a month as all time. */}
      <div className="stat-grid stat-grid-3">
        <div className="stat-card">
          <div className="label">Total</div>
          <div className="value">{money(totals.total)}</div>
          <div className="sub">{windowLabel}</div>
        </div>
        <div className="stat-card accent-2">
          <div className="label">Paid</div>
          <div className="value">{money(totals.paid)}</div>
          <div className="sub">{windowLabel}</div>
        </div>
        <div className="stat-card accent-3">
          <div className="label">Refunded</div>
          <div className="value">{money(totals.refunded)}</div>
          <div className="sub">{windowLabel}</div>
        </div>
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="pay-search" className="visually-hidden">Search payments</label>
          <input
            id="pay-search"
            type="search"
            placeholder="Search participant, workshop or receipt…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="field toolbar-select">
          <label htmlFor="pay-status" className="visually-hidden">Status</label>
          <select
            id="pay-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setPage(1);
            }}
          >
            <option value="all">All</option>
            <option value="paid">Paid</option>
            <option value="unpaid">Unpaid</option>
            <option value="refunded">Refunded</option>
          </select>
        </div>

        <div className="field toolbar-select">
          <label htmlFor="pay-method" className="visually-hidden">Payment method</label>
          <select
            id="pay-method"
            value={methodId}
            onChange={(e) => {
              setMethodId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All methods</option>
            {methods?.data.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div className="field toolbar-date">
          <label htmlFor="pay-from" className="visually-hidden">From date</label>
          <input
            id="pay-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <div className="field toolbar-date">
          <label htmlFor="pay-to" className="visually-hidden">To date</label>
          <input
            id="pay-to"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <label className="checkbox toolbar-checkbox">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => {
              setShowCancelled(e.target.checked);
              setPage(1);
            }}
          />
          <span>Include cancelled</span>
        </label>

        <button type="button" className="btn btn-ghost btn-sm" onClick={resetFilters}>
          Reset
        </button>
      </div>

      <p className="field-hint" style={{ marginTop: -8, marginBottom: 14 }}>
        Dates use the paid date where one was recorded, otherwise the registration date.
      </p>

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load payments.
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
              <IconPayments width={28} height={28} />
              <p style={{ marginTop: 10 }}>No payments match these filters.</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Participant</th>
                  <th>Workshop</th>
                  <th>Method</th>
                  <th>Date</th>
                  <th className="num">Amount</th>
                  <th>Receipt</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.RegistrationID}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setDrawerId(p.RegistrationID)}
                      >
                        {[p.FirstName, p.LastName].filter(Boolean).join(' ') || 'Unknown'}
                      </button>
                      {p.IsCancelled && <span className="pill pill-muted">Cancelled</span>}
                    </td>
                    <td>
                      {p.WorkshopName ?? '—'}
                      {p.WorkshopCode && <div className="cell-sub">{p.WorkshopCode}</div>}
                    </td>
                    <td>{p.PaymentMethod ?? '—'}</td>
                    <td>{fmtDate(p.PaidDate)}</td>
                    <td className="num">
                      <span
                        style={{
                          color:
                            (p.PaidAmount ?? 0) < 0
                              ? 'var(--cc-fifth-color)'
                              : (p.PaidAmount ?? 0) === 0
                                ? 'var(--text-faint)'
                                : undefined,
                        }}
                      >
                        {money(p.PaidAmount)}
                      </span>
                    </td>
                    <td>{p.ReceiptNumber ?? '—'}</td>
                    <td className="num">
                      <span className="row-actions">
                        {canEdit && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() =>
                              openAddPayment({
                                id: p.ParticipantID ?? 0,
                                label:
                                  [p.FirstName, p.LastName].filter(Boolean).join(' ') ||
                                  'Unknown participant',
                              })
                            }
                            disabled={!p.ParticipantID}
                            title={
                              p.ParticipantID
                                ? 'Record another payment for this participant'
                                : 'This registration has no participant'
                            }
                          >
                            Add payment
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

      {drawerId !== null && (
        <PaymentDrawer
          registrationId={drawerId}
          canEdit={canEdit}
          onClose={() => setDrawerId(null)}
        />
      )}

      {addOpen && (
        <AddPaymentDrawer
          participant={addPayment}
          onClose={() => {
            setAddOpen(false);
            setAddPayment(null);
          }}
        />
      )}
    </AppShell>
  );
}
