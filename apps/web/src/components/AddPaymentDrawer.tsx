import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { PaymentCreate } from '@pe/shared';
import { api, HttpError } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';
import { Typeahead } from './Typeahead';

const schema = z.object({
  participantId: z.string().min(1, 'Choose a participant'),
  workshopId: z.string().optional(),
  paidAmount: z
    .string()
    .min(1, 'Enter an amount')
    .refine((v) => /^-?\d+(\.\d{1,4})?$/.test(v), 'Use a number, e.g. 30 or -30 for a refund'),
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
  notes: z.string().max(255, 'Max 255 characters').optional(),
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

/** Today in the browser's timezone — a payment taken now belongs to today. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Record money taken outside the app — a check that arrived late, cash at the
 * desk, an invoice settled by transfer.
 *
 * Payments live on the registration, so a workshop is optional: with one the
 * payment lands on (or creates) the participant's registration for it, and
 * without one it is recorded on its own.
 */
export function AddPaymentDrawer({
  participant,
  onClose,
}: {
  /** Pre-selected when opened from a participant's row on the screen. */
  participant?: { id: number; label: string } | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();

  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.payment');

  const [form, setForm] = useState<Record<string, string>>({
    participantId: participant ? String(participant.id) : '',
    paidDate: today(),
  });
  const [participantLabel, setParticipantLabel] = useState<string | null>(
    participant?.label ?? null,
  );
  const [workshopLabel, setWorkshopLabel] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const { data: methods } = useQuery({
    queryKey: ['lookup', 'payment-methods'],
    queryFn: () => api.lookups.get('payment-methods'),
    staleTime: 10 * 60_000,
  });

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

      const body: PaymentCreate = {
        participantId: Number(form.participantId),
        workshopId: num(form.workshopId),
        paidAmount: Number(form.paidAmount),
        paidDate: str(form.paidDate),
        paymentMethodId: num(form.paymentMethodId),
        receiptNumber: num(form.receiptNumber),
        checkNumber: num(form.checkNumber),
        notes: str(form.notes),
      };

      return api.payments.create(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['payment-summary'] });
      void qc.invalidateQueries({ queryKey: ['registrations'] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof HttpError) setFormError(err.message);
      else if (err.message !== 'validation') setFormError('Could not save. Please try again.');
    },
  });

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-pay-title"
        ref={resize.drawerRef}
        style={resize.drawerStyle}
      >
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="add-pay-title">Add payment</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>

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

          <fieldset className="fieldset">
            <legend>Who and what</legend>

            <Typeahead
              id="add-pay-participant"
              label="Participant"
              placeholder="Search by name or email…"
              value={form.participantId ?? ''}
              selectedLabel={participantLabel}
              onSelect={(id, label) => {
                set('participantId', id ? String(id) : '');
                setParticipantLabel(label || null);
              }}
              search={api.registrations.lookupParticipants}
              required
              error={errors.participantId}
            />

            <Typeahead
              id="add-pay-workshop"
              label="Workshop"
              placeholder="Search by title or code…"
              value={form.workshopId ?? ''}
              selectedLabel={workshopLabel}
              onSelect={(id, label) => {
                set('workshopId', id ? String(id) : '');
                setWorkshopLabel(label || null);
              }}
              search={api.registrations.lookupWorkshops}
            />
            <span className="field-hint">
              Optional. With a workshop the payment lands on the participant's
              registration for it, which is created if they have none. Without one
              the payment is recorded on its own.
            </span>
          </fieldset>

          <fieldset className="fieldset">
            <legend>Payment</legend>

            <div className="field">
              <label htmlFor="add-pay-amount">
                Amount<span aria-hidden="true"> *</span>
              </label>
              <input
                id="add-pay-amount"
                inputMode="decimal"
                value={form.paidAmount ?? ''}
                onChange={(e) => set('paidAmount', e.target.value)}
                aria-invalid={errors.paidAmount ? 'true' : undefined}
                aria-required="true"
              />
              {errors.paidAmount && <span className="error" role="alert">{errors.paidAmount}</span>}
              <span className="field-hint">Use a negative amount for a refund.</span>
            </div>

            <div className="field">
              <label htmlFor="add-pay-method">Payment method</label>
              <select
                id="add-pay-method"
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
                <label htmlFor="add-pay-date">Paid date</label>
                <input
                  id="add-pay-date"
                  type="date"
                  value={form.paidDate ?? ''}
                  onChange={(e) => set('paidDate', e.target.value)}
                  aria-invalid={errors.paidDate ? 'true' : undefined}
                />
                {errors.paidDate && <span className="error" role="alert">{errors.paidDate}</span>}
              </div>
              <div className="field">
                <label htmlFor="add-pay-receipt">Receipt number</label>
                <input
                  id="add-pay-receipt"
                  inputMode="numeric"
                  value={form.receiptNumber ?? ''}
                  onChange={(e) => set('receiptNumber', e.target.value)}
                  aria-invalid={errors.receiptNumber ? 'true' : undefined}
                />
                {errors.receiptNumber && <span className="error" role="alert">{errors.receiptNumber}</span>}
              </div>
            </div>

            <div className="field">
              <label htmlFor="add-pay-check">Check number</label>
              <input
                id="add-pay-check"
                inputMode="numeric"
                value={form.checkNumber ?? ''}
                onChange={(e) => set('checkNumber', e.target.value)}
                aria-invalid={errors.checkNumber ? 'true' : undefined}
              />
              {errors.checkNumber && <span className="error" role="alert">{errors.checkNumber}</span>}
            </div>

            <div className="field">
              <label htmlFor="add-pay-notes">Notes</label>
              <textarea
                id="add-pay-notes"
                rows={2}
                value={form.notes ?? ''}
                onChange={(e) => set('notes', e.target.value)}
                aria-invalid={errors.notes ? 'true' : undefined}
              />
              {errors.notes && <span className="error" role="alert">{errors.notes}</span>}
            </div>
          </fieldset>

          <div className="drawer-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save payment'}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
