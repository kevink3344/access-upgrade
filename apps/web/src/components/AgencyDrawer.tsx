import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { AgencyWrite } from '@pe/shared';
import { api, HttpError } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';

const schema = z.object({
  agencyName: z.string().min(1, 'Agency name is required').max(250),
  agencyShortName: z.string().max(255).optional(),
  agencyTypeId: z.string().optional(),
  facilityTypeId: z.string().optional(),
  countyId: z.string().optional(),
  cityId: z.string().optional(),
  stateId: z.string().optional(),
  streetTypeId: z.string().optional(),
  agencyAddress1: z.string().max(255).optional(),
  agencyAddress2: z.string().max(50).optional(),
  agencyZip: z
    .string()
    .refine((v) => v === '' || /^\d{5}(-\d{4})?$/.test(v), 'Use 12345 or 12345-6789')
    .optional(),
  agencyPhone: z.string().max(16).optional(),
  agencyFax: z.string().max(16).optional(),
  agencyEmail: z
    .string()
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email')
    .optional(),
  agencyWebsite: z.string().max(100).optional(),
  directorFirstName: z.string().max(50).optional(),
  directorLastName: z.string().max(50).optional(),
  altContactFirstName: z.string().max(30).optional(),
  altContactLastName: z.string().max(30).optional(),
  notes: z.string().optional(),
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

export function AgencyDrawer({
  agencyId,
  canDelete,
  onClose,
}: {
  agencyId: number | null;
  canDelete: boolean;
  onClose: () => void;
}) {
  const isEdit = agencyId !== null;
  const qc = useQueryClient();

  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.agency');

  const [form, setForm] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState({ isOutOfBusiness: false, isWorkshopSite: false });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Lookups. All are small reference tables (largest is StreetType at 211
  // rows), so they are loaded whole rather than searched. Called explicitly
  // rather than in a loop — hooks must not be invoked conditionally.
  const lookupOptions = (name: string) => ({
    queryKey: ['lookup', name],
    queryFn: () => api.lookups.get(name),
    staleTime: 10 * 60_000,
  });
  const { data: agencyTypes } = useQuery(lookupOptions('agency-types'));
  const { data: facilityTypes } = useQuery(lookupOptions('facility-types'));
  const { data: counties } = useQuery(lookupOptions('counties'));
  const { data: cities } = useQuery(lookupOptions('cities'));
  const { data: states } = useQuery(lookupOptions('states'));
  const { data: streetTypes } = useQuery(lookupOptions('street-types'));

  const { data: existing, isLoading } = useQuery({
    queryKey: ['agency', agencyId],
    queryFn: () => api.agencies.get(agencyId!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      agencyName: existing.AgencyName ?? '',
      agencyShortName: existing.AgencyShortName ?? '',
      agencyTypeId: existing.AgencyTypeID?.toString() ?? '',
      facilityTypeId: existing.FacilityTypeID?.toString() ?? '',
      countyId: existing.CountyID?.toString() ?? '',
      cityId: existing.CityID?.toString() ?? '',
      stateId: existing.StateID?.toString() ?? '',
      streetTypeId: existing.StreetTypeID?.toString() ?? '',
      agencyAddress1: existing.AgencyAddress1 ?? '',
      agencyAddress2: existing.AgencyAddress2 ?? '',
      agencyZip: existing.AgencyZip ?? '',
      agencyPhone: existing.AgencyPhone ?? '',
      agencyFax: existing.AgencyFax ?? '',
      agencyEmail: existing.AgencyEmail ?? '',
      agencyWebsite: existing.AgencyWebsite ?? '',
      directorFirstName: existing.DirectorFirstName ?? '',
      directorLastName: existing.DirectorLastName ?? '',
      altContactFirstName: existing.AltContactFirstName ?? '',
      altContactLastName: existing.AltContactLastName ?? '',
      notes: existing.Notes ?? '',
    });
    setFlags({
      isOutOfBusiness: existing.IsOutOfBusiness,
      isWorkshopSite: existing.IsWorkshopSite,
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

      const body: AgencyWrite = {
        agencyName: str(form.agencyName),
        agencyShortName: str(form.agencyShortName),
        agencyTypeId: num(form.agencyTypeId),
        facilityTypeId: num(form.facilityTypeId),
        countyId: num(form.countyId),
        cityId: num(form.cityId),
        stateId: num(form.stateId),
        streetTypeId: num(form.streetTypeId),
        agencyAddress1: str(form.agencyAddress1),
        agencyAddress2: str(form.agencyAddress2),
        agencyZip: str(form.agencyZip),
        agencyPhone: str(form.agencyPhone),
        agencyFax: str(form.agencyFax),
        agencyEmail: str(form.agencyEmail),
        agencyWebsite: str(form.agencyWebsite),
        directorFirstName: str(form.directorFirstName),
        directorLastName: str(form.directorLastName),
        altContactFirstName: str(form.altContactFirstName),
        altContactLastName: str(form.altContactLastName),
        notes: str(form.notes),
        ...flags,
      };

      return isEdit ? api.agencies.update(agencyId, body) : api.agencies.create(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agencies'] });
      if (isEdit) void qc.invalidateQueries({ queryKey: ['agency', agencyId] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof HttpError) {
        // A duplicate name comes back as 409 with a field path; surface it
        // against the input rather than only as a banner.
        if (err.status === 409) {
          setErrors({ agencyName: 'Another agency already uses that name' });
        }
        setFormError(err.message);
      } else if (err.message !== 'validation') {
        setFormError('Could not save. Please try again.');
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => api.agencies.remove(agencyId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agencies'] });
      onClose();
    },
    onError: (err) =>
      setFormError(err instanceof HttpError ? err.message : 'Could not delete this agency.'),
  });

  const title = isEdit
    ? (existing?.AgencyName ?? 'Agency')
    : 'Add agency';

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer drawer-wide" role="dialog" aria-modal="true" aria-labelledby="ag-title" ref={resize.drawerRef} style={resize.drawerStyle}>
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="ag-title">{title}</h2>
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
              <legend>Identity</legend>

              <div className="field">
                <label htmlFor="ag-name">Agency name</label>
                <input
                  id="ag-name"
                  value={form.agencyName ?? ''}
                  onChange={(e) => set('agencyName', e.target.value)}
                  aria-invalid={errors.agencyName ? 'true' : undefined}
                  required
                />
                {errors.agencyName && <span className="error" role="alert">{errors.agencyName}</span>}
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="ag-short">Short name</label>
                  <input
                    id="ag-short"
                    value={form.agencyShortName ?? ''}
                    onChange={(e) => set('agencyShortName', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ag-type">Agency type</label>
                  <select
                    id="ag-type"
                    value={form.agencyTypeId ?? ''}
                    onChange={(e) => set('agencyTypeId', e.target.value)}
                  >
                    <option value="">— none —</option>
                    {agencyTypes?.data.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="ag-facility">Facility type</label>
                  <select
                    id="ag-facility"
                    value={form.facilityTypeId ?? ''}
                    onChange={(e) => set('facilityTypeId', e.target.value)}
                  >
                    <option value="">— none —</option>
                    {facilityTypes?.data.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ag-county">County</label>
                  <select
                    id="ag-county"
                    value={form.countyId ?? ''}
                    onChange={(e) => set('countyId', e.target.value)}
                  >
                    <option value="">— none —</option>
                    {counties?.data.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Address</legend>

              <div className="field">
                <label htmlFor="ag-addr1">Street address</label>
                <input
                  id="ag-addr1"
                  value={form.agencyAddress1 ?? ''}
                  onChange={(e) => set('agencyAddress1', e.target.value)}
                  autoComplete="street-address"
                />
              </div>

              <div className="field">
                <label htmlFor="ag-addr2">Address line 2</label>
                <input
                  id="ag-addr2"
                  value={form.agencyAddress2 ?? ''}
                  onChange={(e) => set('agencyAddress2', e.target.value)}
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="ag-city">City</label>
                  <select
                    id="ag-city"
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
                  <label htmlFor="ag-state">State</label>
                  <select
                    id="ag-state"
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

              <div className="field-row">
                <div className="field">
                  <label htmlFor="ag-zip">ZIP</label>
                  <input
                    id="ag-zip"
                    value={form.agencyZip ?? ''}
                    onChange={(e) => set('agencyZip', e.target.value)}
                    inputMode="numeric"
                    autoComplete="postal-code"
                    aria-invalid={errors.agencyZip ? 'true' : undefined}
                  />
                  {errors.agencyZip && <span className="error" role="alert">{errors.agencyZip}</span>}
                </div>
                <div className="field">
                  <label htmlFor="ag-street">Street type</label>
                  <select
                    id="ag-street"
                    value={form.streetTypeId ?? ''}
                    onChange={(e) => set('streetTypeId', e.target.value)}
                  >
                    <option value="">— none —</option>
                    {streetTypes?.data.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Contact</legend>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="ag-phone">Phone</label>
                  <input
                    id="ag-phone"
                    type="tel"
                    inputMode="tel"
                    value={form.agencyPhone ?? ''}
                    onChange={(e) => set('agencyPhone', e.target.value)}
                    autoComplete="tel"
                  />
                </div>
                <div className="field">
                  <label htmlFor="ag-fax">Fax</label>
                  <input
                    id="ag-fax"
                    value={form.agencyFax ?? ''}
                    onChange={(e) => set('agencyFax', e.target.value)}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="ag-email">Email</label>
                <input
                  id="ag-email"
                  type="email"
                  inputMode="email"
                  value={form.agencyEmail ?? ''}
                  onChange={(e) => set('agencyEmail', e.target.value)}
                  aria-invalid={errors.agencyEmail ? 'true' : undefined}
                />
                {errors.agencyEmail && <span className="error" role="alert">{errors.agencyEmail}</span>}
              </div>

              <div className="field">
                <label htmlFor="ag-web">Website</label>
                <input
                  id="ag-web"
                  value={form.agencyWebsite ?? ''}
                  onChange={(e) => set('agencyWebsite', e.target.value)}
                  placeholder="example.org"
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="ag-dir-first">Director first name</label>
                  <input
                    id="ag-dir-first"
                    value={form.directorFirstName ?? ''}
                    onChange={(e) => set('directorFirstName', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ag-dir-last">Director last name</label>
                  <input
                    id="ag-dir-last"
                    value={form.directorLastName ?? ''}
                    onChange={(e) => set('directorLastName', e.target.value)}
                  />
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="ag-alt-first">Alt contact first name</label>
                  <input
                    id="ag-alt-first"
                    value={form.altContactFirstName ?? ''}
                    onChange={(e) => set('altContactFirstName', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ag-alt-last">Alt contact last name</label>
                  <input
                    id="ag-alt-last"
                    value={form.altContactLastName ?? ''}
                    onChange={(e) => set('altContactLastName', e.target.value)}
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
                    checked={flags.isWorkshopSite}
                    onChange={(e) => setFlags((f) => ({ ...f, isWorkshopSite: e.target.checked }))}
                  />
                  <span>Workshop site</span>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={flags.isOutOfBusiness}
                    onChange={(e) => setFlags((f) => ({ ...f, isOutOfBusiness: e.target.checked }))}
                  />
                  <span>Out of business</span>
                </label>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Notes</legend>
              <div className="field">
                <label htmlFor="ag-notes">Agency notes</label>
                <textarea
                  id="ag-notes"
                  rows={3}
                  value={form.notes ?? ''}
                  onChange={(e) => set('notes', e.target.value)}
                />
              </div>
            </fieldset>

            {confirmDelete && (
              <div className="alert alert-error" role="alert">
                <span>
                  Delete this agency? This cannot be undone. Agencies with participants or
                  workshops cannot be deleted — mark them out of business instead.
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
                      Keep agency
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
                {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add agency'}
              </button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
