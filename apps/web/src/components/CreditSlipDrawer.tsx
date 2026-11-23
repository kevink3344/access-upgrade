import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreditSlipWrite } from '@pe/shared';
import { api } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';
import { Typeahead } from './Typeahead';

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

function dateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

type Errors = Record<string, string>;

/**
 * One credit slip.
 *
 * Issuing and redeeming are separate actions on purpose: a slip's amount and
 * owner are set once, while redemption records who actually used it — which
 * is often not the person it was issued to.
 */
export function CreditSlipDrawer({
  creditSlipId,
  canEdit,
  onClose,
}: {
  creditSlipId: number | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const isEdit = creditSlipId !== null;
  const qc = useQueryClient();

  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.creditSlip');

  const [form, setForm] = useState<Record<string, string>>({});
  const [participant, setParticipant] = useState<{ id: string; label: string | null }>({
    id: '',
    label: null,
  });
  const [workshop, setWorkshop] = useState<{ id: string; label: string | null }>({
    id: '',
    label: null,
  });
  const [redeemer, setRedeemer] = useState<{ id: string; label: string | null }>({
    id: '',
    label: null,
  });
  const [email, setEmail] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [redeemDate, setRedeemDate] = useState('');

  const { data: existing, isLoading } = useQuery({
    queryKey: ['credit-slip', creditSlipId],
    queryFn: () => api.creditSlips.get(creditSlipId!),
    enabled: isEdit,
  });

  const categories = useQuery({
    queryKey: ['lookup', 'credit-slip-categories'],
    queryFn: () => api.lookups.get('credit-slip-categories'),
    staleTime: 10 * 60_000,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      categoryId: existing.CreditSlipsCategoryID?.toString() ?? '',
      dateIssued: dateInput(existing.DateIssued),
      amount: existing.Amount?.toString() ?? '',
      trackingYear: existing.TrackingYear?.toString() ?? '',
    });
    setParticipant({
      id: existing.ParticipantID?.toString() ?? '',
      label: existing.ParticipantName ?? null,
    });
    setWorkshop({
      id: existing.WorkshopID?.toString() ?? '',
      label: existing.WorkshopName ?? null,
    });
    setRedeemer({
      // 299 of 300 unused legacy slips carry a UsedParticipantID even though
      // they were never redeemed — an ETL artifact. Only trust it when the
      // slip was actually used, or the form would pre-fill a redeemer that
      // was never chosen.
      id: existing.DateUsed ? (existing.UsedParticipantID?.toString() ?? '') : '',
      label: existing.DateUsed ? (existing.UsedParticipantName ?? null) : null,
    });
    setEmail(existing.Email);
    setRedeemDate(dateInput(existing.DateUsed) || new Date().toISOString().slice(0, 10));
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
      const body: CreditSlipWrite = {
        categoryId: form.categoryId ? Number(form.categoryId) : null,
        participantId: participant.id ? Number(participant.id) : null,
        workshopId: workshop.id ? Number(workshop.id) : null,
        dateIssued: str(form.dateIssued),
        amount: num(form.amount),
        trackingYear: num(form.trackingYear),
        email,
      };
      return isEdit
        ? api.creditSlips.update(creditSlipId!, body)
        : api.creditSlips.create(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credit-slips'] });
      qc.invalidateQueries({ queryKey: ['credit-slip', creditSlipId] });
      if (!isEdit) onClose();
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const redeem = useMutation({
    mutationFn: () =>
      api.creditSlips.redeem(creditSlipId!, {
        dateUsed: redeemDate || null,
        usedParticipantId: redeemer.id ? Number(redeemer.id) : null,
        usedWorkshopId: workshop.id ? Number(workshop.id) : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credit-slips'] });
      qc.invalidateQueries({ queryKey: ['credit-slip', creditSlipId] });
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const undoRedeem = useMutation({
    mutationFn: () => api.creditSlips.undoRedeem(creditSlipId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credit-slips'] });
      qc.invalidateQueries({ queryKey: ['credit-slip', creditSlipId] });
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.creditSlips.remove(creditSlipId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credit-slips'] });
      onClose();
    },
    onError: (e: Error) => setFormError(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const next: Errors = {};
    if (!participant.id) next.participantId = 'Choose a participant';
    if (!form.amount || !Number.isFinite(Number(form.amount))) {
      next.amount = 'Enter an amount';
    } else if (Number(form.amount) <= 0) {
      next.amount = 'Must be greater than zero';
    }
    if (form.trackingYear && !/^\d{4}$/.test(form.trackingYear)) {
      next.trackingYear = 'Use a four-digit year';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    save.mutate();
  }

  const isUsed = !!existing?.DateUsed;
  const title = isEdit
    ? (existing?.ParticipantName ?? `Credit slip ${creditSlipId}`)
    : 'Issue credit slip';

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="drawer drawer-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cs-title"
        ref={resize.drawerRef}
        style={resize.drawerStyle}
      >
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="cs-title">{title}</h2>
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
              <legend>Slip</legend>

              <Typeahead
                id="cs-participant"
                label="Issued to"
                placeholder="Search by name or email…"
                value={participant.id}
                selectedLabel={participant.label}
                onSelect={(id, label) => {
                  setParticipant({ id: id ? String(id) : '', label: label || null });
                  setErrors((p) => {
                    const n = { ...p };
                    delete n.participantId;
                    return n;
                  });
                }}
                search={api.registrations.lookupParticipants}
                required
                error={errors.participantId}
                disabled={!canEdit}
              />

              <div className="field-row">
                <div className="field">
                  <label htmlFor="cs-category">Category</label>
                  <select
                    id="cs-category"
                    value={form.categoryId ?? ''}
                    onChange={(e) => set('categoryId', e.target.value)}
                  >
                    <option value="">Not set</option>
                    {(categories.data?.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="cs-issued">Date issued</label>
                  <input
                    id="cs-issued"
                    type="date"
                    value={form.dateIssued ?? ''}
                    onChange={(e) => set('dateIssued', e.target.value)}
                  />
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="cs-amount">Amount</label>
                  <input
                    id="cs-amount"
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={form.amount ?? ''}
                    onChange={(e) => set('amount', e.target.value)}
                    aria-invalid={errors.amount ? 'true' : undefined}
                  />
                  {errors.amount && <span className="error" role="alert">{errors.amount}</span>}
                </div>

                <div className="field">
                  <label htmlFor="cs-year">Tracking year</label>
                  <input
                    id="cs-year"
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="e.g. 2027"
                    value={form.trackingYear ?? ''}
                    onChange={(e) => set('trackingYear', e.target.value)}
                    aria-invalid={errors.trackingYear ? 'true' : undefined}
                  />
                  {errors.trackingYear && (
                    <span className="error" role="alert">{errors.trackingYear}</span>
                  )}
                </div>
              </div>

              <Typeahead
                id="cs-workshop"
                label="Workshop it relates to"
                placeholder="Search by title or code…"
                value={workshop.id}
                selectedLabel={workshop.label}
                onSelect={(id, label) => setWorkshop({ id: id ? String(id) : '', label: label || null })}
                search={api.registrations.lookupWorkshops}
                disabled={!canEdit}
              />

              <div className="checkbox-grid" style={{ marginTop: 4 }}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={email}
                    onChange={(e) => setEmail(e.target.checked)}
                    disabled={!canEdit}
                  />
                  <span>Emailed to the participant</span>
                </label>
              </div>
            </fieldset>

            {canEdit && (
              <div className="drawer-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Issue slip'}
                </button>
              </div>
            )}
          </form>
        )}

        {isEdit && existing && (
          <div className="drawer-body">
            <fieldset className="fieldset" disabled={!canEdit}>
              <legend>Redemption</legend>

              {isUsed ? (
                <>
                  <p className="tab-summary">
                    Used on <strong>{fmtDate(existing.DateUsed)}</strong>
                    {existing.UsedParticipantName && (
                      <> by <strong>{existing.UsedParticipantName}</strong></>
                    )}
                    {existing.UsedWorkshopName && (
                      <> against <strong>{existing.UsedWorkshopName}</strong></>
                    )}
                    .
                  </p>
                  {canEdit && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => undoRedeem.mutate()}
                      disabled={undoRedeem.isPending}
                    >
                      {undoRedeem.isPending ? 'Undoing…' : 'Undo redemption'}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="tab-summary">This slip is unused.</p>

                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="cs-used-date">Used on</label>
                      <input
                        id="cs-used-date"
                        type="date"
                        value={redeemDate}
                        onChange={(e) => setRedeemDate(e.target.value)}
                      />
                    </div>
                  </div>

                  <Typeahead
                    id="cs-redeemer"
                    label="Used by (leave blank for the same participant)"
                    placeholder="Search by name or email…"
                    value={redeemer.id}
                    selectedLabel={redeemer.label}
                    onSelect={(id, label) => setRedeemer({ id: id ? String(id) : '', label: label || null })}
                    search={api.registrations.lookupParticipants}
                    disabled={!canEdit}
                  />

                  <div className="drawer-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => redeem.mutate()}
                      disabled={redeem.isPending || !redeemDate}
                    >
                      {redeem.isPending ? 'Redeeming…' : 'Mark as used'}
                    </button>
                  </div>
                </>
              )}
            </fieldset>

            {canEdit && !isUsed && (
              <div className="drawer-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Delete this credit slip? This cannot be undone.',
                      )
                    ) {
                      remove.mutate();
                    }
                  }}
                  disabled={remove.isPending}
                >
                  Delete slip
                </button>
              </div>
            )}

            <p className="tab-summary" style={{ marginTop: 0 }}>
              Issued {fmtDate(existing.DateIssued)} · {fmtMoney(existing.Amount)}
              {existing.TrackingYear ? ` · ${existing.TrackingYear}` : ''}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
