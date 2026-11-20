import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { ParticipantWrite, DuplicateMatch } from '@pe/shared';
import { api, HttpError } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { IconAlert } from './icons';

const schema = z
  .object({
    firstName: z.string().max(30).optional(),
    lastName: z.string().max(30).optional(),
    middleName: z.string().max(20).optional(),
    email: z
      .string()
      .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email')
      .optional(),
    email2: z.string().max(100).optional(),
    email3: z.string().max(255).optional(),
    homePhone: z.string().max(15).optional(),
    workPhone: z.string().max(15).optional(),
    workPhoneExt: z.string().max(6).optional(),
    homeAddress1: z.string().max(200).optional(),
    homeAddress2: z.string().max(50).optional(),
    homeZip: z.string().max(10).optional(),
    position: z.string().max(255).optional(),
    gradeLevel: z.string().max(255).optional(),
    agencyId: z.string().optional(),
    salutationId: z.string().optional(),
  })
  .refine((v) => (v.firstName?.trim() ?? '') !== '' || (v.lastName?.trim() ?? '') !== '', {
    message: 'A first or last name is required',
    path: ['lastName'],
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

function dateValue(v: string | null | undefined): string {
  return v ? v.slice(0, 10) : '';
}

/* ------------------------------------------------------------------ */
/*  Duplicate warning                                                  */
/* ------------------------------------------------------------------ */

function DuplicateWarning({
  matches,
  onDismiss,
}: {
  matches: DuplicateMatch[];
  onDismiss: () => void;
}) {
  if (matches.length === 0) return null;

  return (
    <div className="duplicate-warning" role="status">
      <div className="duplicate-head">
        <IconAlert width={18} height={18} />
        <strong>
          {matches.length === 1 ? 'A similar person' : `${matches.length} similar people`} already
          {matches.length === 1 ? ' exists' : ' exist'}
        </strong>
        <button type="button" className="duplicate-dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
      <p>
        Check before adding — creating a second record for the same person splits their
        registration history.
      </p>
      <ul>
        {matches.map((m) => (
          <li key={m.participantId}>
            <strong>{m.displayName}</strong>
            {m.email && <span className="muted"> · {m.email}</span>}
            {m.agencyName && <span className="muted"> · {m.agencyName}</span>}
            <span className="dup-meta">
              {m.registrationCount} registration{m.registrationCount === 1 ? '' : 's'} ·{' '}
              matched on {m.matchReason}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Drawer                                                             */
/* ------------------------------------------------------------------ */

export function ParticipantDrawer({
  participantId,
  canDelete,
  onClose,
}: {
  participantId: number | null;
  canDelete: boolean;
  onClose: () => void;
}) {
  const isEdit = participantId !== null;
  const qc = useQueryClient();
  useScrollLock();

  const [form, setForm] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState({
    isParentMailingList: false,
    isTeacherMailingList: false,
    isDirectorMailingList: false,
    isStaff: false,
    isWcpss: false,
  });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [duplicatesDismissed, setDuplicatesDismissed] = useState(false);

  const { data: existing, isLoading } = useQuery({
    queryKey: ['participant', participantId],
    queryFn: () => api.participants.get(participantId!),
    enabled: isEdit,
  });

  const { data: agencies } = useQuery({
    queryKey: ['agencies', 'picker'],
    queryFn: () => api.agencies.list({ pageSize: 200 }),
    staleTime: 10 * 60_000,
  });

  const { data: salutations } = useQuery({
    queryKey: ['lookup', 'salutations'],
    queryFn: () => api.lookups.get('salutations'),
    staleTime: 10 * 60_000,
  });

  const { data: registrations } = useQuery({
    queryKey: ['participant', participantId, 'registrations'],
    queryFn: () => api.participants.registrations(participantId!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      firstName: existing.FirstName ?? '',
      lastName: existing.LastName ?? '',
      middleName: existing.MiddleName ?? '',
      email: existing.Email ?? '',
      email2: existing.Email2 ?? '',
      email3: existing.Email3 ?? '',
      homePhone: existing.HomePhone ?? '',
      workPhone: existing.WorkPhone ?? '',
      workPhoneExt: existing.WorkPhoneExt ?? '',
      homeAddress1: existing.HomeAddress1 ?? '',
      homeAddress2: existing.HomeAddress2 ?? '',
      homeZip: existing.HomeZip ?? '',
      position: existing.Position ?? '',
      gradeLevel: existing.GradeLevel ?? '',
      agencyId: existing.AgencyID?.toString() ?? '',
      salutationId: existing.SalutationID?.toString() ?? '',
    });
    setFlags({
      isParentMailingList: existing.IsParentMailingList,
      isTeacherMailingList: existing.IsTeacherMailingList,
      isDirectorMailingList: existing.IsDirectorMailingList,
      isStaff: existing.IsStaff,
      isWcpss: existing.IsWcpss,
    });
  }, [existing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Live duplicate check, debounced. Runs for new records only — an existing
  // record is expected to match itself.
  useEffect(() => {
    if (isEdit) {
      setDuplicates([]);
      return;
    }

    const email = (form.email ?? '').trim();
    const firstName = (form.firstName ?? '').trim();
    const lastName = (form.lastName ?? '').trim();

    if (!email && !(firstName && lastName)) {
      setDuplicates([]);
      return;
    }

    let cancelled = false;
    const t = setTimeout(() => {
      api.participants
        .checkDuplicate({ email: email || undefined, firstName, lastName })
        .then((r) => {
          if (!cancelled) setDuplicates(r.data);
        })
        .catch(() => {
          if (!cancelled) setDuplicates([]);
        });
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [form.email, form.firstName, form.lastName, isEdit]);

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

      const body: ParticipantWrite = {
        firstName: str(form.firstName),
        lastName: str(form.lastName),
        middleName: str(form.middleName),
        email: str(form.email),
        email2: str(form.email2),
        email3: str(form.email3),
        homePhone: str(form.homePhone),
        workPhone: str(form.workPhone),
        workPhoneExt: str(form.workPhoneExt),
        homeAddress1: str(form.homeAddress1),
        homeAddress2: str(form.homeAddress2),
        homeZip: str(form.homeZip),
        position: str(form.position),
        gradeLevel: str(form.gradeLevel),
        agencyId: num(form.agencyId),
        salutationId: num(form.salutationId),
        ...flags,
      };

      return isEdit
        ? api.participants.update(participantId, body)
        : api.participants.create(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['participants'] });
      if (isEdit) void qc.invalidateQueries({ queryKey: ['participant', participantId] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof HttpError) setFormError(err.message);
      else if (err.message !== 'validation') setFormError('Could not save. Please try again.');
    },
  });

  const remove = useMutation({
    mutationFn: () => api.participants.remove(participantId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['participants'] });
      onClose();
    },
    onError: (err) => {
      setFormError(err instanceof HttpError ? err.message : 'Could not delete.');
      setConfirmDelete(false);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    save.mutate();
  }

  const fullName = [form.firstName, form.lastName].filter(Boolean).join(' ') || 'New participant';

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer drawer-wide" role="dialog" aria-modal="true" aria-labelledby="p-title">
        <header className="drawer-head">
          <h2 id="p-title">{isEdit ? fullName : 'Add participant'}</h2>
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

            {!duplicatesDismissed && (
              <DuplicateWarning matches={duplicates} onDismiss={() => setDuplicatesDismissed(true)} />
            )}

            <fieldset className="fieldset">
              <legend>Name</legend>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="p-salutation">Salutation</label>
                  <select
                    id="p-salutation"
                    value={form.salutationId ?? ''}
                    onChange={(e) => set('salutationId', e.target.value)}
                  >
                    <option value="">—</option>
                    {salutations?.data.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="p-first">First name</label>
                  <input
                    id="p-first"
                    value={form.firstName ?? ''}
                    onChange={(e) => set('firstName', e.target.value)}
                    maxLength={30}
                    autoComplete="given-name"
                    autoFocus
                  />
                </div>

                <div className="field">
                  <label htmlFor="p-last">Last name</label>
                  <input
                    id="p-last"
                    value={form.lastName ?? ''}
                    onChange={(e) => set('lastName', e.target.value)}
                    maxLength={30}
                    autoComplete="family-name"
                    aria-invalid={errors.lastName ? 'true' : undefined}
                  />
                  {errors.lastName && <span className="error" role="alert">{errors.lastName}</span>}
                </div>
              </div>

              <div className="field">
                <label htmlFor="p-middle">Middle name</label>
                <input
                  id="p-middle"
                  value={form.middleName ?? ''}
                  onChange={(e) => set('middleName', e.target.value)}
                  maxLength={20}
                  autoComplete="additional-name"
                />
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Contact</legend>

              <div className="field">
                <label htmlFor="p-email">Email</label>
                <input
                  id="p-email"
                  type="email"
                  inputMode="email"
                  value={form.email ?? ''}
                  onChange={(e) => set('email', e.target.value)}
                  maxLength={100}
                  autoComplete="email"
                  aria-invalid={errors.email ? 'true' : undefined}
                />
                {errors.email && <span className="error" role="alert">{errors.email}</span>}
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="p-homephone">Home phone</label>
                  <input
                    id="p-homephone"
                    type="tel"
                    inputMode="tel"
                    value={form.homePhone ?? ''}
                    onChange={(e) => set('homePhone', e.target.value)}
                    maxLength={15}
                    autoComplete="tel"
                  />
                </div>

                <div className="field">
                  <label htmlFor="p-workphone">Work phone</label>
                  <input
                    id="p-workphone"
                    type="tel"
                    inputMode="tel"
                    value={form.workPhone ?? ''}
                    onChange={(e) => set('workPhone', e.target.value)}
                    maxLength={15}
                  />
                </div>

                <div className="field">
                  <label htmlFor="p-ext">Ext.</label>
                  <input
                    id="p-ext"
                    value={form.workPhoneExt ?? ''}
                    onChange={(e) => set('workPhoneExt', e.target.value)}
                    maxLength={6}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="p-address1">Home address</label>
                <input
                  id="p-address1"
                  value={form.homeAddress1 ?? ''}
                  onChange={(e) => set('homeAddress1', e.target.value)}
                  maxLength={200}
                  autoComplete="street-address"
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="p-address2">Address line 2</label>
                  <input
                    id="p-address2"
                    value={form.homeAddress2 ?? ''}
                    onChange={(e) => set('homeAddress2', e.target.value)}
                    maxLength={50}
                  />
                </div>

                <div className="field">
                  <label htmlFor="p-zip">ZIP</label>
                  <input
                    id="p-zip"
                    inputMode="numeric"
                    value={form.homeZip ?? ''}
                    onChange={(e) => set('homeZip', e.target.value)}
                    maxLength={10}
                    autoComplete="postal-code"
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>School or agency</legend>

              <div className="field">
                <label htmlFor="p-agency">Agency</label>
                <select
                  id="p-agency"
                  value={form.agencyId ?? ''}
                  onChange={(e) => set('agencyId', e.target.value)}
                >
                  <option value="">— none (individual) —</option>
                  {agencies?.data.map((a) => (
                    <option key={a.AgencyID} value={a.AgencyID}>
                      {a.AgencyName ?? `Agency ${a.AgencyID}`}
                    </option>
                  ))}
                </select>
                <span className="field-hint">Leave blank for parents and independent attendees.</span>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="p-position">Position</label>
                  <input
                    id="p-position"
                    value={form.position ?? ''}
                    onChange={(e) => set('position', e.target.value)}
                    maxLength={255}
                    autoComplete="organization-title"
                  />
                </div>

                <div className="field">
                  <label htmlFor="p-grade">Grade level</label>
                  <input
                    id="p-grade"
                    value={form.gradeLevel ?? ''}
                    onChange={(e) => set('gradeLevel', e.target.value)}
                    maxLength={255}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Flags</legend>

              <div className="checkbox-grid">
                {([
                  ['isWcpss', 'WCPSS employee'],
                  ['isStaff', 'Project Enlightenment staff'],
                  ['isTeacherMailingList', 'Teacher mailing list'],
                  ['isParentMailingList', 'Parent mailing list'],
                  ['isDirectorMailingList', 'Director mailing list'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="checkbox">
                    <input
                      type="checkbox"
                      checked={flags[key]}
                      onChange={(e) => setFlags((f) => ({ ...f, [key]: e.target.checked }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {isEdit && registrations && registrations.data.length > 0 && (
              <fieldset className="fieldset">
                <legend>Registrations ({registrations.data.length})</legend>
                <ul className="mini-list">
                  {registrations.data.slice(0, 8).map((r) => (
                    <li key={r.RegistrationID}>
                      <a href={`/registrations?edit=${r.RegistrationID}`}>
                        {r.WorkshopName ?? 'Legacy workshop'}
                      </a>
                      <span className="muted">
                        {' · '}
                        {r.StartDate ? dateValue(r.StartDate) : '—'}
                        {r.IsCancelled ? ' · cancelled' : r.Attended ? ' · attended' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                {registrations.data.length > 8 && (
                  <p className="field-hint">
                    Showing 8 of {registrations.data.length}.{' '}
                    <a href={`/registrations?participantId=${participantId}`}>See all</a>
                  </p>
                )}
              </fieldset>
            )}

            <div className="drawer-actions">
              {isEdit && canDelete && (
                <button
                  type="button"
                  className="btn btn-ghost btn-danger-text"
                  onClick={() => setConfirmDelete(true)}
                  style={{ marginRight: 'auto' }}
                >
                  Delete
                </button>
              )}
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add participant'}
              </button>
            </div>
          </form>
        )}
      </aside>

      {confirmDelete && (
        <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDelete(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true">
            <h2>Delete {fullName}?</h2>
            <p>
              This cannot be undone. Participants with registrations, credit slips or
              attendance cannot be deleted — their history would be lost.
            </p>
            <div className="drawer-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
