import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { PresenterWrite } from '@pe/shared';
import { api, HttpError } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';

const schema = z
  .object({
    salutationId: z.string().optional(),
    agencyId: z.string().optional(),
    cityId: z.string().optional(),
    stateId: z.string().optional(),
    firstName: z.string().max(30).optional(),
    lastName: z.string().max(30).optional(),
    middleName: z.string().max(20).optional(),
    workPhone: z.string().max(14).optional(),
    extension: z
      .string()
      .refine((v) => v === '' || /^\d{1,6}$/.test(v), 'Digits only')
      .optional(),
    homePhone: z.string().max(15).optional(),
    cellPhone: z.string().max(14).optional(),
    homeEmail: z
      .string()
      .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email')
      .optional(),
    address: z.string().max(200).optional(),
    zip: z.string().max(10).optional(),
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

export function PresenterDrawer({
  presenterId,
  canDelete,
  onClose,
}: {
  presenterId: number | null;
  canDelete: boolean;
  onClose: () => void;
}) {
  const isEdit = presenterId !== null;
  const qc = useQueryClient();

  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.presenter');

  const [form, setForm] = useState<Record<string, string>>({});
  const [isRetired, setIsRetired] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const lookupOptions = (name: string) => ({
    queryKey: ['lookup', name],
    queryFn: () => api.lookups.get(name),
    staleTime: 10 * 60_000,
  });
  const { data: salutations } = useQuery(lookupOptions('salutations'));
  const { data: cities } = useQuery(lookupOptions('cities'));
  const { data: states } = useQuery(lookupOptions('states'));

  const { data: existing, isLoading } = useQuery({
    queryKey: ['presenter', presenterId],
    queryFn: () => api.presenters.get(presenterId!),
    enabled: isEdit,
  });

  // Workshop history is only meaningful for an existing presenter.
  const { data: workshops } = useQuery({
    queryKey: ['presenter-workshops', presenterId],
    queryFn: () => api.presenters.workshops(presenterId!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      salutationId: existing.SalutationID?.toString() ?? '',
      agencyId: existing.AgencyID?.toString() ?? '',
      cityId: existing.CityID?.toString() ?? '',
      stateId: existing.StateID?.toString() ?? '',
      firstName: existing.FirstName ?? '',
      lastName: existing.LastName ?? '',
      middleName: existing.MiddleName ?? '',
      workPhone: existing.WorkPhone ?? '',
      extension: existing.Extension?.toString() ?? '',
      homePhone: existing.HomePhone ?? '',
      cellPhone: existing.CellPhone ?? '',
      homeEmail: existing.HomeEmail ?? '',
      address: existing.Address ?? '',
      zip: existing.Zip ?? '',
    });
    setIsRetired(existing.IsRetired);
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

      const body: PresenterWrite = {
        salutationId: num(form.salutationId),
        agencyId: num(form.agencyId),
        cityId: num(form.cityId),
        stateId: num(form.stateId),
        firstName: str(form.firstName),
        lastName: str(form.lastName),
        middleName: str(form.middleName),
        workPhone: str(form.workPhone),
        extension: num(form.extension),
        homePhone: str(form.homePhone),
        cellPhone: str(form.cellPhone),
        homeEmail: str(form.homeEmail),
        address: str(form.address),
        zip: str(form.zip),
        isRetired,
      };

      return isEdit ? api.presenters.update(presenterId, body) : api.presenters.create(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['presenters'] });
      if (isEdit) void qc.invalidateQueries({ queryKey: ['presenter', presenterId] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof HttpError) setFormError(err.message);
      else if (err.message !== 'validation') setFormError('Could not save. Please try again.');
    },
  });

  const remove = useMutation({
    mutationFn: () => api.presenters.remove(presenterId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['presenters'] });
      onClose();
    },
    onError: (err) =>
      setFormError(err instanceof HttpError ? err.message : 'Could not delete this presenter.'),
  });

  const fullName = [form.firstName, form.lastName].filter(Boolean).join(' ') || 'New presenter';

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer drawer-wide" role="dialog" aria-modal="true" aria-labelledby="pr-title" ref={resize.drawerRef} style={resize.drawerStyle}>
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="pr-title">{isEdit ? fullName : 'Add presenter'}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {isEdit && isLoading ? (
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

            <fieldset className="fieldset">
              <legend>Name</legend>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="pr-salutation">Salutation</label>
                  <select
                    id="pr-salutation"
                    value={form.salutationId ?? ''}
                    onChange={(e) => set('salutationId', e.target.value)}
                  >
                    <option value="">— none —</option>
                    {salutations?.data.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pr-first">First name</label>
                  <input
                    id="pr-first"
                    value={form.firstName ?? ''}
                    onChange={(e) => set('firstName', e.target.value)}
                  />
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="pr-last">Last name</label>
                  <input
                    id="pr-last"
                    value={form.lastName ?? ''}
                    onChange={(e) => set('lastName', e.target.value)}
                    aria-invalid={errors.lastName ? 'true' : undefined}
                  />
                  {errors.lastName && <span className="error" role="alert">{errors.lastName}</span>}
                </div>
                <div className="field">
                  <label htmlFor="pr-middle">Middle name</label>
                  <input
                    id="pr-middle"
                    value={form.middleName ?? ''}
                    onChange={(e) => set('middleName', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Contact</legend>

              <div className="field">
                <label htmlFor="pr-email">Email</label>
                <input
                  id="pr-email"
                  type="email"
                  inputMode="email"
                  value={form.homeEmail ?? ''}
                  onChange={(e) => set('homeEmail', e.target.value)}
                  aria-invalid={errors.homeEmail ? 'true' : undefined}
                />
                {errors.homeEmail && <span className="error" role="alert">{errors.homeEmail}</span>}
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="pr-work">Work phone</label>
                  <input
                    id="pr-work"
                    type="tel"
                    inputMode="tel"
                    value={form.workPhone ?? ''}
                    onChange={(e) => set('workPhone', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="pr-ext">Extension</label>
                  <input
                    id="pr-ext"
                    inputMode="numeric"
                    value={form.extension ?? ''}
                    onChange={(e) => set('extension', e.target.value)}
                    aria-invalid={errors.extension ? 'true' : undefined}
                  />
                  {errors.extension && <span className="error" role="alert">{errors.extension}</span>}
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="pr-cell">Cell phone</label>
                  <input
                    id="pr-cell"
                    type="tel"
                    inputMode="tel"
                    value={form.cellPhone ?? ''}
                    onChange={(e) => set('cellPhone', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="pr-home">Home phone</label>
                  <input
                    id="pr-home"
                    type="tel"
                    inputMode="tel"
                    value={form.homePhone ?? ''}
                    onChange={(e) => set('homePhone', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Location</legend>

              <div className="field">
                <label htmlFor="pr-address">Address</label>
                <input
                  id="pr-address"
                  value={form.address ?? ''}
                  onChange={(e) => set('address', e.target.value)}
                  autoComplete="street-address"
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="pr-city">City</label>
                  <select
                    id="pr-city"
                    value={form.cityId ?? ''}
                    onChange={(e) => set('cityId', e.target.value)}
                  >
                    <option value="">— none —</option>
                    {cities?.data.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pr-state">State</label>
                  <select
                    id="pr-state"
                    value={form.stateId ?? ''}
                    onChange={(e) => set('stateId', e.target.value)}
                  >
                    <option value="">— none —</option>
                    {states?.data.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="pr-zip">ZIP</label>
                <input
                  id="pr-zip"
                  inputMode="numeric"
                  value={form.zip ?? ''}
                  onChange={(e) => set('zip', e.target.value)}
                  autoComplete="postal-code"
                />
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Status</legend>
              <div className="checkbox-grid">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={isRetired}
                    onChange={(e) => setIsRetired(e.target.checked)}
                  />
                  <span>Retired</span>
                </label>
              </div>
            </fieldset>

            {isEdit && workshops && workshops.data.length > 0 && (
              <fieldset className="fieldset">
                <legend>Workshops taught ({workshops.data.length})</legend>
                <ul className="mini-list">
                  {workshops.data.slice(0, 8).map((w) => (
                    <li key={w.WorkshopID}>
                      <span className="mini-list-main">{w.WorkshopName ?? 'Untitled workshop'}</span>
                      <span className="mini-list-sub">
                        {w.WorkshopCode ?? '—'}
                        {w.StartDate ? ` · ${w.StartDate.slice(0, 10)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                {workshops.data.length > 8 && (
                  <p className="field-hint" style={{ marginTop: 8 }}>
                    Showing the 8 most recent of {workshops.data.length}.
                  </p>
                )}
              </fieldset>
            )}

            {confirmDelete && (
              <div className="alert alert-error" role="alert">
                <span>
                  Delete this presenter? Presenters attached to workshops cannot be deleted —
                  mark them retired instead.
                </span>
              </div>
            )}

            <div className="drawer-actions">
              {isEdit && canDelete && (
                confirmDelete ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmDelete(false)}
                      style={{ marginRight: 'auto' }}
                    >
                      Keep presenter
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => remove.mutate()}
                      disabled={remove.isPending}
                      style={{ marginRight: 'auto' }}
                    >
                      {remove.isPending ? 'Deleting…' : 'Delete permanently'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-danger-text"
                    onClick={() => setConfirmDelete(true)}
                    style={{ marginRight: 'auto' }}
                  >
                    Delete
                  </button>
                )
              )}
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add presenter'}
              </button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
