import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { RegistrationWrite } from '@pe/shared';
import { api, HttpError } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';
import { Typeahead } from './Typeahead';

type RegTab = 'who' | 'answers';

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
  const [tab, setTab] = useState<RegTab>('who');

  const { data: existing, isLoading } = useQuery({
    queryKey: ['registration', registrationId],
    queryFn: () => api.registrations.get(registrationId!),
    enabled: isEdit,
  });

  // Custom answers for this registration, shown on the Form Answers tab.
  const answers = useQuery({
    queryKey: ['registration', registrationId, 'form-answers'],
    queryFn: () => api.forms.answersForRegistration(registrationId!),
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

        {isEdit && (
          <div className="drawer-tabs" role="tablist" aria-label="Registration sections">
            <button
              type="button"
              role="tab"
              id="tab-who"
              className="drawer-tab"
              aria-selected={tab === 'who'}
              aria-controls="panel-who"
              onClick={() => setTab('who')}
            >
              Who and what
            </button>
            <button
              type="button"
              role="tab"
              id="tab-answers"
              className="drawer-tab"
              aria-selected={tab === 'answers'}
              aria-controls="panel-answers"
              onClick={() => setTab('answers')}
            >
              Form answers
              {(answers.data?.answers.length ?? 0) > 0 && (
                <span className="drawer-tab-count">{answers.data!.answers.length}</span>
              )}
            </button>
          </div>
        )}

        {isEdit && tab === 'answers' ? (
          <div
            className="drawer-body"
            role="tabpanel"
            id="panel-answers"
            aria-labelledby="tab-answers"
          >
            {answers.isLoading ? (
              <div className="skeleton" style={{ height: 120 }} />
            ) : answers.isError ? (
              <div className="alert alert-error" role="alert">
                <span>Could not load answers. {(answers.error as Error).message}</span>
              </div>
            ) : (
              <>
                {/* Which form the registrant actually saw, so staff know where
                    these answers came from. */}
                <p className="answers-source">
                  <span className="answers-source-label">Form completed</span>
                  <strong>
                    {answers.data?.formName
                      ? `${answers.data.formName}${
                          answers.data.formVersionNumber
                            ? ` · v${answers.data.formVersionNumber}`
                            : ''
                        }`
                      : 'Built-in form (no custom questions)'}
                  </strong>
                </p>

                {(answers.data?.answers.length ?? 0) === 0 ? (
                  <p className="tab-empty">
                    No answers are recorded for this registration.
                  </p>
                ) : (
                  <dl className="answer-list">
                    {answers.data!.answers.map((a) => (
                      <div key={a.questionKey}>
                        <dt>{a.label}</dt>
                        <dd>{a.value?.trim() || '—'}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )}
          </div>
        ) : isEdit && isLoading ? (
          <div className="drawer-body">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 44, marginBottom: 12 }} />
            ))}
          </div>
        ) : (
          <form
            className="drawer-body"
            onSubmit={onSubmit}
            noValidate
            role={isEdit ? 'tabpanel' : undefined}
            id={isEdit ? 'panel-who' : undefined}
            aria-labelledby={isEdit ? 'tab-who' : undefined}
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
