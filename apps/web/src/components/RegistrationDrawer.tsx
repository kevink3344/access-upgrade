import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { RegistrationWrite } from '@pe/shared';
import { api, HttpError } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';

const schema = z.object({
  participantId: z.string().min(1, 'Choose a participant'),
  workshopId: z.string().optional(),
  paidAmount: z.string().optional(),
  registrationDate: z
    .string()
    .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Use a valid date')
    .optional(),
  ticketCount: z.string().optional(),
  receiptNumber: z.string().optional(),
  checkNumber: z.string().optional(),
  checkTotal: z.string().optional(),
  paidDate: z
    .string()
    .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Use a valid date')
    .optional(),
  notes: z.string().max(255, 'Max 255 characters').optional(),
});

type Errors = Record<string, string>;

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: string | undefined): string | null {
  return v && v.trim() !== '' ? v.trim() : null;
}

function dateValue(v: string | null | undefined): string {
  return v ? v.slice(0, 10) : '';
}

/* ------------------------------------------------------------------ */
/*  Type-ahead picker                                                  */
/* ------------------------------------------------------------------ */

function Typeahead({
  id,
  label,
  placeholder,
  value,
  selectedLabel,
  onSelect,
  search,
  required,
  error,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  selectedLabel: string | null;
  onSelect: (id: number, label: string) => void;
  search: (q: string) => Promise<{ data: { id: number; label: string }[] }>;
  required?: boolean;
  error?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ id: number; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setOptions([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const t = setTimeout(() => {
      search(query)
        .then((r) => {
          if (!cancelled) setOptions(r.data);
        })
        .catch(() => {
          if (!cancelled) setOptions([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open, search]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="field" ref={boxRef} style={{ position: 'relative' }}>
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>

      {value && selectedLabel ? (
        <div className="typeahead-selected">
          <span>{selectedLabel}</span>
          <button
            type="button"
            className="typeahead-clear"
            onClick={() => {
              onSelect(0, '');
              setQuery('');
            }}
            aria-label={`Clear ${label}`}
          >
            ×
          </button>
        </div>
      ) : (
        <input
          id={id}
          type="search"
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          aria-invalid={error ? 'true' : undefined}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          role="combobox"
        />
      )}

      {open && !value && query.trim().length >= 2 && (
        <ul className="typeahead-list" id={`${id}-list`} role="listbox">
          {loading && <li className="typeahead-empty">Searching…</li>}
          {!loading && options.length === 0 && (
            <li className="typeahead-empty">No matches</li>
          )}
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => {
                  onSelect(o.id, o.label);
                  setOpen(false);
                  setQuery('');
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Drawer                                                             */
/* ------------------------------------------------------------------ */

export function RegistrationDrawer({
  registrationId,
  canCancel,
  onClose,
}: {
  registrationId: number | null;
  canCancel: boolean;
  onClose: () => void;
}) {
  const isEdit = registrationId !== null;
  const qc = useQueryClient();
  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.registration');

  const [form, setForm] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState({
    isScholarship: false,
    attended: false,
    emailConfirmation: false,
  });
  const [participantLabel, setParticipantLabel] = useState<string | null>(null);
  const [workshopLabel, setWorkshopLabel] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const { data: existing, isLoading } = useQuery({
    queryKey: ['registration', registrationId],
    queryFn: () => api.registrations.get(registrationId!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      participantId: String(existing.ParticipantID),
      workshopId: existing.WorkshopID !== null ? String(existing.WorkshopID) : '',
      paidAmount: existing.PaidAmount?.toString() ?? '',
      registrationDate: dateValue(existing.RegistrationDate),
      ticketCount: existing.TicketCount?.toString() ?? '',
      receiptNumber: existing.ReceiptNumber?.toString() ?? '',
      checkNumber: existing.CheckNumber?.toString() ?? '',
      checkTotal: existing.CheckTotal?.toString() ?? '',
      paidDate: dateValue(existing.PaidDate),
      notes: existing.Notes ?? '',
    });
    setFlags({
      isScholarship: existing.IsScholarship,
      attended: existing.Attended,
      emailConfirmation: existing.EmailConfirmation,
    });
    setParticipantLabel(existing.ParticipantName);
    setWorkshopLabel(
      existing.WorkshopName
        ? `${existing.WorkshopName}${existing.WorkshopCode ? ` · ${existing.WorkshopCode}` : ''}`
        : null,
    );
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

      const body: RegistrationWrite = {
        participantId: Number(form.participantId),
        workshopId: num(form.workshopId),
        paidAmount: num(form.paidAmount),
        ticketCount: num(form.ticketCount),
        receiptNumber: num(form.receiptNumber),
        checkNumber: num(form.checkNumber),
        checkTotal: num(form.checkTotal),
        notes: str(form.notes),
        ...flags,
      };

      // Only send the dates when the user actually set one, so the server
      // default (today) applies on create rather than being overwritten with
      // NULL.
      const regDate = str(form.registrationDate);
      if (regDate) body.registrationDate = regDate;
      const paidDate = str(form.paidDate);
      if (paidDate) body.paidDate = paidDate;

      return isEdit
        ? api.registrations.update(registrationId, body)
        : api.registrations.create(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['registrations'] });
      if (isEdit) void qc.invalidateQueries({ queryKey: ['registration', registrationId] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof HttpError) {
        setFormError(
          err.status === 409
            ? 'This participant is already registered for that workshop.'
            : err.message,
        );
      } else if (err.message !== 'validation') {
        setFormError('Could not save. Please try again.');
      }
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.registrations.cancel(registrationId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['registrations'] });
      onClose();
    },
    onError: (err) => {
      setFormError(err instanceof HttpError ? err.message : 'Could not cancel.');
      setConfirmCancel(false);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    save.mutate();
  }

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer drawer-wide" role="dialog" aria-modal="true" aria-labelledby="reg-title" ref={resize.drawerRef} style={resize.drawerStyle}>
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="reg-title">{isEdit ? 'Edit registration' : 'Add registration'}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
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

            <fieldset className="fieldset">
              <legend>Who and what</legend>

              <Typeahead
                id="r-participant"
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
                id="r-workshop"
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
            </fieldset>

            <fieldset className="fieldset">
              <legend>Payment</legend>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="r-paid">Amount paid</label>
                  <input
                    id="r-paid"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={form.paidAmount ?? ''}
                    onChange={(e) => set('paidAmount', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="r-regdate">Registration date</label>
                  <input
                    id="r-regdate"
                    type="date"
                    value={form.registrationDate ?? ''}
                    onChange={(e) => set('registrationDate', e.target.value)}
                    aria-invalid={errors.registrationDate ? 'true' : undefined}
                  />
                  {errors.registrationDate && (
                    <span className="error" role="alert">{errors.registrationDate}</span>
                  )}
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="r-receipt">Receipt #</label>
                  <input
                    id="r-receipt"
                    type="number"
                    inputMode="numeric"
                    value={form.receiptNumber ?? ''}
                    onChange={(e) => set('receiptNumber', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="r-check">Check #</label>
                  <input
                    id="r-check"
                    type="number"
                    inputMode="numeric"
                    value={form.checkNumber ?? ''}
                    onChange={(e) => set('checkNumber', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="r-checktotal">Check total</label>
                  <input
                    id="r-checktotal"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={form.checkTotal ?? ''}
                    onChange={(e) => set('checkTotal', e.target.value)}
                  />
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="r-paiddate">Paid date</label>
                  <input
                    id="r-paiddate"
                    type="date"
                    value={form.paidDate ?? ''}
                    onChange={(e) => set('paidDate', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="r-tickets">Tickets</label>
                  <input
                    id="r-tickets"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={form.ticketCount ?? ''}
                    onChange={(e) => set('ticketCount', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Status</legend>

              <div className="checkbox-grid">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={flags.attended}
                    onChange={(e) => setFlags((f) => ({ ...f, attended: e.target.checked }))}
                  />
                  <span>Attended</span>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={flags.isScholarship}
                    onChange={(e) => setFlags((f) => ({ ...f, isScholarship: e.target.checked }))}
                  />
                  <span>Scholarship</span>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={flags.emailConfirmation}
                    onChange={(e) => setFlags((f) => ({ ...f, emailConfirmation: e.target.checked }))}
                  />
                  <span>Confirmation sent</span>
                </label>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Notes</legend>
              <div className="field">
                <label htmlFor="r-notes">Registration notes</label>
                <textarea
                  id="r-notes"
                  rows={3}
                  maxLength={255}
                  value={form.notes ?? ''}
                  onChange={(e) => set('notes', e.target.value)}
                  aria-invalid={errors.notes ? 'true' : undefined}
                />
                {errors.notes && <span className="error" role="alert">{errors.notes}</span>}
              </div>
            </fieldset>

            <div className="drawer-actions">
              {isEdit && canCancel && !existing?.IsCancelled && (
                <button
                  type="button"
                  className="btn btn-ghost btn-danger-text"
                  onClick={() => setConfirmCancel(true)}
                  style={{ marginRight: 'auto' }}
                >
                  Cancel registration
                </button>
              )}
              <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add registration'}
              </button>
            </div>
          </form>
        )}
      </aside>

      {confirmCancel && (
        <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && setConfirmCancel(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true">
            <h2>Cancel this registration?</h2>
            <p>
              The registration is marked cancelled rather than deleted, so payment and
              attendance history is kept. You can reinstate it by editing and clearing the
              cancelled flag.
            </p>
            <div className="drawer-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmCancel(false)}>
                Keep it
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? 'Cancelling…' : 'Cancel registration'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
