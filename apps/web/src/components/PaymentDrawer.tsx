import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { PaymentWrite } from '@pe/shared';
import { api, HttpError } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { IconAlert } from './icons';

const schema = z.object({
  paidAmount: z
    .string()
    .refine((v) => v === '' || /^-?\d+(\.\d{1,4})?$/.test(v), 'Use a number, e.g. 30 or -30 for a refund')
    .optional(),
  paidDate: z
    .string()
    .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Use a valid date')
    .optional(),
  paymentMethodId: z.string().optional(),
  receiptNumber: z
    .string()
    .refine((v) => v === '' || /^\d+$/.test(v), 'Digits only')
    .optional(),
  checkNumber: z
    .string()
    .refine((v) => v === '' || /^\d+$/.test(v), 'Digits only')
    .optional(),
});

type Errors = Record<string, string>;

function str(v: string | undefined): string | null {
  return v && v.trim() !== '' ? v.trim() : null;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function PaymentDrawer({
  registrationId,
  canEdit,
  onClose,
}: {
  registrationId: number;
  canEdit: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();

  useScrollLock();

  const [form, setForm] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const { data: methods } = useQuery({
    queryKey: ['lookup', 'payment-methods'],
    queryFn: () => api.lookups.get('payment-methods'),
    staleTime: 10 * 60_000,
  });

  const { data: existing, isLoading } = useQuery({
    queryKey: ['payment', registrationId],
    queryFn: () => api.payments.get(registrationId),
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      paidAmount: existing.PaidAmount?.toString() ?? '',
      paidDate: existing.PaidDate ? existing.PaidDate.slice(0, 10) : '',
      paymentMethodId: existing.PaymentMethodID?.toString() ?? '',
      receiptNumber: existing.ReceiptNumber?.toString() ?? '',
      checkNumber: existing.CheckNumber?.toString() ?? '',
    });
  }, [existing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const save = useMutation({
    mutationFn: async () => {
      const parsed = schema.safeParse(form);

      if (!parsed.success) {
        const next: Errors = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path[0] as string;
          if (!next[key]) next[key] = issue.message;
        }
        setErrors(next);
        throw new Error('validation');
      }

      setErrors({});

      const body: PaymentWrite = {
        paidAmount: num(form.paidAmount),
        paidDate: str(form.paidDate),
        paymentMethodId: num(form.paymentMethodId),
        receiptNumber: num(form.receiptNumber),
        checkNumber: num(form.checkNumber),
      };

      return api.payments.update(registrationId, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['payment-summary'] });
      void qc.invalidateQueries({ queryKey: ['payment', registrationId] });
      void qc.invalidateQueries({ queryKey: ['registrations'] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof HttpError) setFormError(err.message);
      else if (err.message !== 'validation') setFormError('Could not save. Please try again.');
    },
  });

  const participant = existing
    ? [existing.FirstName, existing.LastName].filter(Boolean).join(' ') || 'Unknown participant'
    : 'Payment';

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="pay-title">
        <header className="drawer-head">
          <h2 id="pay-title">{participant}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {isLoading ? (
          <div className="drawer-body">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 44, marginBottom: 12 }} />
            ))}
          </div>
        ) : (
          <form
            className="drawer-body"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setFormError(null);
              save.mutate();
            }}
            noValidate
          >
            {formError && (
              <div className="alert alert-error" role="alert">
                <IconAlert width={18} height={18} />
                <span>{formError}</span>
              </div>
            )}

            {existing && (
              <fieldset className="fieldset">
                <legend>Registration</legend>
                <dl className="detail-list">
                  <div>
                    <dt>Workshop</dt>
                    <dd>
                      {existing.WorkshopName ?? 'Untitled'}
                      {existing.WorkshopCode ? ` · ${existing.WorkshopCode}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>School year</dt>
                    <dd>{existing.SchoolYear ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>{existing.Email ?? '—'}</dd>
                  </div>
                  {existing.IsCancelled && (
                    <div>
                      <dt>Status</dt>
                      <dd><span className="pill pill-muted">Cancelled</span></dd>
                    </div>
                  )}
                  {existing.IsScholarship && (
                    <div>
                      <dt>Scholarship</dt>
                      <dd><span className="pill pill-info">Yes</span></dd>
                    </div>
                  )}
                </dl>
              </fieldset>
            )}

            <fieldset className="fieldset">
              <legend>Payment</legend>

              <div className="field">
                <label htmlFor="pay-amount">Amount</label>
                <input
                  id="pay-amount"
                  inputMode="decimal"
                  value={form.paidAmount ?? ''}
                  onChange={(e) => set('paidAmount', e.target.value)}
                  aria-invalid={errors.paidAmount ? 'true' : undefined}
                />
                {errors.paidAmount && <span className="error" role="alert">{errors.paidAmount}</span>}
                <span className="field-hint">Use a negative amount for a refund.</span>
              </div>

              <div className="field">
                <label htmlFor="pay-method">Payment method</label>
                <select
                  id="pay-method"
                  value={form.paymentMethodId ?? ''}
                  onChange={(e) => set('paymentMethodId', e.target.value)}
                >
                  <option value="">— none —</option>
                  {methods?.data.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="pay-date">Paid date</label>
                  <input
                    id="pay-date"
                    type="date"
                    value={form.paidDate ?? ''}
                    onChange={(e) => set('paidDate', e.target.value)}
                    aria-invalid={errors.paidDate ? 'true' : undefined}
                  />
                  {errors.paidDate && <span className="error" role="alert">{errors.paidDate}</span>}
                </div>
                <div className="field">
                  <label htmlFor="pay-receipt">Receipt number</label>
                  <input
                    id="pay-receipt"
                    inputMode="numeric"
                    value={form.receiptNumber ?? ''}
                    onChange={(e) => set('receiptNumber', e.target.value)}
                    aria-invalid={errors.receiptNumber ? 'true' : undefined}
                  />
                  {errors.receiptNumber && <span className="error" role="alert">{errors.receiptNumber}</span>}
                </div>
              </div>

              <div className="field">
                <label htmlFor="pay-check">Check number</label>
                <input
                  id="pay-check"
                  inputMode="numeric"
                  value={form.checkNumber ?? ''}
                  onChange={(e) => set('checkNumber', e.target.value)}
                  aria-invalid={errors.checkNumber ? 'true' : undefined}
                />
                {errors.checkNumber && <span className="error" role="alert">{errors.checkNumber}</span>}
              </div>
            </fieldset>

            {existing?.PaymentID && (
              <fieldset className="fieldset">
                <legend>Linked payment record</legend>
                <dl className="detail-list">
                  <div>
                    <dt>Payment ID</dt>
                    <dd>{existing.PaymentID}</dd>
                  </div>
                  <div>
                    <dt>Record total</dt>
                    <dd>{money(existing.PaymentRecordTotal)}</dd>
                  </div>
                  <div>
                    <dt>Payee</dt>
                    <dd>{existing.Payee ?? '—'}</dd>
                  </div>
                </dl>
                <p className="field-hint">
                  This registration points at a shared payment record. The record total covers
                  every registration on it, so it may differ from the amount above.
                </p>
              </fieldset>
            )}

            <div className="drawer-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {canEdit ? 'Cancel' : 'Close'}
              </button>
              {canEdit && (
                <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save payment'}
                </button>
              )}
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
