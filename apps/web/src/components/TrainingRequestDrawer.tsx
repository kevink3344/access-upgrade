import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TrainingRequestWrite } from '@pe/shared';
import { api } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { AgencyPicker } from './AgencyPicker';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';

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

/** `YYYY-MM-DD` for a date input, or '' when unset. */
function dateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

type Errors = Record<string, string>;

/**
 * One training request.
 *
 * The request itself is editable; the quotes, scheduled workshops and
 * payments are imported history and are shown read-only. The contact log is
 * the one child table staff keep adding to.
 */
export function TrainingRequestDrawer({
  trainingRequestId,
  canEdit,
  onClose,
}: {
  trainingRequestId: number | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const isEdit = trainingRequestId !== null;
  const qc = useQueryClient();

  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.trainingRequest');

  const [form, setForm] = useState<Record<string, string>>({});
  const [agency, setAgency] = useState<{ id: number | null; label: string }>({
    id: null,
    label: '',
  });
  const [isActive, setIsActive] = useState(true);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [contactDate, setContactDate] = useState('');
  const [contactNote, setContactNote] = useState('');

  const { data: existing, isLoading } = useQuery({
    queryKey: ['training-request', trainingRequestId],
    queryFn: () => api.trainingRequests.get(trainingRequestId!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      requestDate: dateInput(existing.RequestDate),
      requestedBy: existing.RequestedBy ?? '',
      requestPhone: existing.RequestPhone ?? '',
      requestExt: existing.RequestExt?.toString() ?? '',
      requestEmail: existing.RequestEmail ?? '',
      participantCount: existing.ParticipantCount ?? '',
      invoiceNum: existing.InvoiceNum ?? '',
      invoiceDate: dateInput(existing.InvoiceDate),
      dueDate: dateInput(existing.DueDate),
      amtDue: existing.AmtDue?.toString() ?? '',
    });
    setAgency({ id: existing.AgencyID, label: existing.AgencyName ?? '' });
    setIsActive(existing.IsActive);
  }, [existing]);

  function set(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function str(v: string | undefined): string | null {
    return v && v.trim() !== '' ? v.trim() : null;
  }

  function num(v: string | undefined): number | null {
    if (v === undefined || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  const save = useMutation({
    mutationFn: async () => {
      const body: TrainingRequestWrite = {
        agencyId: agency.id,
        requestDate: str(form.requestDate),
        requestedBy: str(form.requestedBy),
        requestPhone: str(form.requestPhone),
        requestExt: num(form.requestExt),
        requestEmail: str(form.requestEmail),
        participantCount: str(form.participantCount),
        invoiceNum: str(form.invoiceNum),
        invoiceDate: str(form.invoiceDate),
        dueDate: str(form.dueDate),
        amtDue: num(form.amtDue),
        isActive,
      };
      return isEdit
        ? api.trainingRequests.update(trainingRequestId!, body)
        : api.trainingRequests.create(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['training-requests'] });
      qc.invalidateQueries({ queryKey: ['training-request', trainingRequestId] });
      if (!isEdit) onClose();
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const addContact = useMutation({
    mutationFn: () =>
      api.trainingRequests.addContact(trainingRequestId!, {
        contactDate,
        note: str(contactNote),
      }),
    onSuccess: () => {
      setContactDate('');
      setContactNote('');
      qc.invalidateQueries({ queryKey: ['training-request', trainingRequestId] });
      qc.invalidateQueries({ queryKey: ['training-requests'] });
    },
    onError: (e: Error) => setFormError(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const next: Errors = {};
    if (form.requestEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.requestEmail)) {
      next.requestEmail = 'Enter a valid email';
    }
    if (form.requestExt && !/^\d+$/.test(form.requestExt)) {
      next.requestExt = 'Digits only';
    }
    if (form.amtDue && !Number.isFinite(Number(form.amtDue))) {
      next.amtDue = 'Enter a number';
    }
    // An invoice number without a date (or the reverse) is almost always a
    // half-finished entry, so ask for both rather than storing one.
    if (form.invoiceNum && !form.invoiceDate) {
      next.invoiceDate = 'Add the invoice date';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    save.mutate();
  }

  const title = isEdit
    ? (existing?.AgencyName ?? `Training request ${trainingRequestId}`)
    : 'Add training request';

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="drawer drawer-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tr-title"
        ref={resize.drawerRef}
        style={resize.drawerStyle}
      >
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="tr-title">{title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {isEdit && isLoading ? (
          <div className="drawer-body">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 44, marginBottom: 12 }} />
            ))}
          </div>
        ) : (
          <form className="drawer-body" onSubmit={onSubmit} noValidate>
            {formError && (
              <div className="alert alert-error" role="alert">
                <IconAlert width={18} height={18} />
                <span>{formError}</span>
              </div>
            )}

            <fieldset className="fieldset" disabled={!canEdit}>
              <legend>Request</legend>

              <div className="field">
                <label htmlFor="tr-agency">Agency</label>
                <AgencyPicker
                  id="tr-agency"
                  value={agency.id}
                  label={agency.label}
                  onChange={(id, label) => setAgency({ id, label })}
                  disabled={!canEdit}
                  placeholder="Start typing the agency…"
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="tr-date">Request date</label>
                  <input
                    id="tr-date"
                    type="date"
                    value={form.requestDate ?? ''}
                    onChange={(e) => set('requestDate', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="tr-count">Participants</label>
                  <input
                    id="tr-count"
                    type="text"
                    maxLength={255}
                    placeholder="e.g. 20-30"
                    value={form.participantCount ?? ''}
                    onChange={(e) => set('participantCount', e.target.value)}
                  />
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="tr-by">Requested by</label>
                  <input
                    id="tr-by"
                    type="text"
                    maxLength={100}
                    value={form.requestedBy ?? ''}
                    onChange={(e) => set('requestedBy', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="tr-email">Email</label>
                  <input
                    id="tr-email"
                    type="email"
                    maxLength={100}
                    value={form.requestEmail ?? ''}
                    onChange={(e) => set('requestEmail', e.target.value)}
                    aria-invalid={errors.requestEmail ? 'true' : undefined}
                  />
                  {errors.requestEmail && (
                    <span className="error" role="alert">{errors.requestEmail}</span>
                  )}
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="tr-phone">Phone</label>
                  <input
                    id="tr-phone"
                    type="tel"
                    maxLength={14}
                    value={form.requestPhone ?? ''}
                    onChange={(e) => set('requestPhone', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="tr-ext">Extension</label>
                  <input
                    id="tr-ext"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={form.requestExt ?? ''}
                    onChange={(e) => set('requestExt', e.target.value)}
                    aria-invalid={errors.requestExt ? 'true' : undefined}
                  />
                  {errors.requestExt && (
                    <span className="error" role="alert">{errors.requestExt}</span>
                  )}
                </div>
              </div>

              <div className="checkbox-grid" style={{ marginTop: 4 }}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                  />
                  <span>Active — still being worked</span>
                </label>
              </div>
            </fieldset>

            <fieldset className="fieldset" disabled={!canEdit}>
              <legend>Invoice</legend>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="tr-inv">Invoice number</label>
                  <input
                    id="tr-inv"
                    type="text"
                    maxLength={10}
                    placeholder="e.g. 2027-004"
                    value={form.invoiceNum ?? ''}
                    onChange={(e) => set('invoiceNum', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="tr-invdate">Invoice date</label>
                  <input
                    id="tr-invdate"
                    type="date"
                    value={form.invoiceDate ?? ''}
                    onChange={(e) => set('invoiceDate', e.target.value)}
                    aria-invalid={errors.invoiceDate ? 'true' : undefined}
                  />
                  {errors.invoiceDate && (
                    <span className="error" role="alert">{errors.invoiceDate}</span>
                  )}
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="tr-due">Due date</label>
                  <input
                    id="tr-due"
                    type="date"
                    value={form.dueDate ?? ''}
                    onChange={(e) => set('dueDate', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="tr-amt">Amount due</label>
                  <input
                    id="tr-amt"
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={form.amtDue ?? ''}
                    onChange={(e) => set('amtDue', e.target.value)}
                    aria-invalid={errors.amtDue ? 'true' : undefined}
                  />
                  {errors.amtDue && <span className="error" role="alert">{errors.amtDue}</span>}
                </div>
              </div>
            </fieldset>

            {canEdit && (
              <div className="drawer-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add request'}
                </button>
              </div>
            )}
          </form>
        )}

        {isEdit && existing && (
          <div className="drawer-body">
            <div className="tab-section">
              <fieldset className="fieldset"><legend>Quotes ({existing.quotes.length})</legend>
              {existing.quotes.length === 0 ? (
                <p className="tab-empty">No quotes recorded.</p>
              ) : (
                <table className="data-table tab-table">
                  <thead>
                    <tr>
                      <th scope="col">Topic</th>
                      <th scope="col">Type</th>
                      <th scope="col">Dates</th>
                      <th scope="col" className="num">Sessions</th>
                      <th scope="col" className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {existing.quotes.map((q) => (
                      <tr key={q.TrainingRequestQuoteID}>
                        <td data-label="Topic">
                          {q.TopicRequested ?? '—'}
                          {q.Location && (
                            <div className="muted" style={{ fontSize: 12 }}>{q.Location}</div>
                          )}
                        </td>
                        <td data-label="Type" className="muted">{q.WorkshopType ?? '—'}</td>
                        <td data-label="Dates">
                          {q.DatesRequested ?? '—'}
                          {q.Duration && (
                            <div className="muted" style={{ fontSize: 12 }}>{q.Duration}</div>
                          )}
                        </td>
                        <td data-label="Sessions" className="num">{q.NumSessions ?? '—'}</td>
                        <td data-label="Amount" className="num">{fmtMoney(q.RequestAmt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              </fieldset>
            </div>

            <div className="tab-section">
              <fieldset className="fieldset"><legend>Scheduled workshops ({existing.scheduled.length})</legend>
              {existing.scheduled.length === 0 ? (
                <p className="tab-empty">Nothing scheduled yet.</p>
              ) : (
                <ul className="presenter-list">
                  {existing.scheduled.map((s) => (
                    <li key={`${s.WorkshopID}-${s.ScheduledOn}`}>
                      <div className="presenter-main">
                        <span className="presenter-name">
                          {s.WorkshopName ?? `Workshop ${s.WorkshopID}`}
                        </span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {s.WorkshopCode ?? '—'} · starts {fmtDate(s.StartDate)}
                        </span>
                      </div>
                      <span className="muted" style={{ fontSize: 12 }}>
                        scheduled {fmtDate(s.ScheduledOn)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              </fieldset>
            </div>

            <div className="tab-section">
              <fieldset className="fieldset"><legend>Payments ({existing.payments.length})</legend>
              {existing.payments.length === 0 ? (
                <p className="tab-empty">No payments recorded.</p>
              ) : (
                <table className="data-table tab-table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Method</th>
                      <th scope="col" className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {existing.payments.map((p) => (
                      <tr key={p.PaymentID}>
                        <td data-label="Date">{fmtDate(p.PaymentDate)}</td>
                        <td data-label="Method" className="muted">{p.PaymentMethod ?? '—'}</td>
                        <td data-label="Amount" className="num">{fmtMoney(p.Amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              </fieldset>
            </div>

            <div className="tab-section">
              <fieldset className="fieldset"><legend>Contact log ({existing.contacts.length})</legend>

              {canEdit && (
                <div className="tab-add">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="tr-cdate">Date</label>
                    <input
                      id="tr-cdate"
                      type="date"
                      className="input"
                      value={contactDate}
                      onChange={(e) => setContactDate(e.target.value)}
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0, flex: '3 1 260px' }}>
                    <label htmlFor="tr-cnote">Note</label>
                    <input
                      id="tr-cnote"
                      type="text"
                      className="input"
                      maxLength={2000}
                      placeholder="What was discussed"
                      value={contactNote}
                      onChange={(e) => setContactNote(e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!contactDate || addContact.isPending}
                    onClick={() => addContact.mutate()}
                  >
                    {addContact.isPending ? 'Adding…' : 'Log contact'}
                  </button>
                </div>
              )}

              {existing.contacts.length === 0 ? (
                <p className="tab-empty">No contacts logged.</p>
              ) : (
                <ul className="presenter-list">
                  {existing.contacts.map((c) => (
                    <li key={c.TrainingRequestContactID}>
                      <div className="presenter-main">
                        <span className="presenter-name">{fmtDate(c.ContactDate)}</span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {c.Note ?? 'No note'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              </fieldset>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
