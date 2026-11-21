import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { WorkshopWrite } from '@pe/shared';
import { api, HttpError } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { IconAlert } from './icons';
import { RegistrationLinkPanel } from './RegistrationLinkPanel';
import { WorkshopRegistrants } from './WorkshopRegistrants';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { useResizableDrawer } from '../hooks/useResizableDrawer';

const dateOrEmpty = z
  .string()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Use a valid date')
  .optional();

const timeOrEmpty = z
  .string()
  .refine((v) => v === '' || /^\d{2}:\d{2}$/.test(v), 'Use HH:MM')
  .optional();

const schema = z
  .object({
    workshopNameId: z.string().optional(),
    schoolYearId: z.string().optional(),
    categoryId: z.string().optional(),
    agencyId: z.string().optional(),
    workshopCode: z.string().max(10, 'Max 10 characters').optional(),
    startDate: dateOrEmpty,
    endDate: dateOrEmpty,
    startTime: timeOrEmpty,
    endTime: timeOrEmpty,
    maxEnrollment: z.string().optional(),
    minEnrollment: z.string().optional(),
    room: z.string().optional(),
    cost1: z.string().optional(),
    creditPossible: z.string().max(50).optional(),
    sessionCount: z.string().optional(),
    sessionHours: z.string().optional(),
    sessionCeus: z.string().optional(),
    notes: z.string().optional(),
    specialNotes: z.string().optional(),
  })
  .refine(
    (v) => !v.startDate || !v.endDate || v.endDate >= v.startDate,
    { message: 'End date cannot be before the start date', path: ['endDate'] },
  );

type Errors = Record<string, string>;

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: string | undefined): string | null {
  return v && v.trim() !== '' ? v.trim() : null;
}

/**
 * SQL TIME columns come back through JSON as a full date string
 * ("1970-01-01T09:00:00.000Z"), so take the time portion rather than
 * slicing the front of the string.
 */
function timeValue(v: string | null | undefined): string {
  if (!v) return '';
  const m = /T(\d{2}:\d{2})/.exec(v) ?? /^(\d{2}:\d{2})/.exec(v);
  return m ? m[1]! : '';
}

/** SQL DATE columns arrive as ISO strings; keep only the date part. */
function dateValue(v: string | null | undefined): string {
  if (!v) return '';
  return v.slice(0, 10);
}

export function WorkshopDrawer({
  workshopId,
  canDelete,
  onClose,
  onOpenRegistration,
}: {
  workshopId: number | null;
  canDelete: boolean;
  onClose: () => void;
  onOpenRegistration: (registrationId: number) => void;
}) {
  const isEdit = workshopId !== null;
  const qc = useQueryClient();

  const [tab, setTab] = useState<'details' | 'registrants'>('details');
  const resize = useResizableDrawer('pe.drawerWidth.workshop');

  // Stop the page behind from scrolling while the drawer is open.
  useScrollLock();

  const [form, setForm] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState({
    isBrochure: false,
    isFolder: false,
    isLabel: false,
    isClosed: false,
    isCancelled: false,
    isContracted: false,
    isStaffDev: false,
    isRegistrationOpen: false,
  });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Lookups
  const { data: names } = useQuery({
    queryKey: ['lookup', 'workshop-names'],
    queryFn: () => api.workshops.lookupNames(),
    staleTime: 10 * 60_000,
  });
  const { data: years } = useQuery({
    queryKey: ['lookup', 'school-years'],
    queryFn: () => api.lookups.get('school-years'),
    staleTime: 10 * 60_000,
  });
  const { data: categories } = useQuery({
    queryKey: ['lookup', 'categories'],
    queryFn: () => api.lookups.get('categories'),
    staleTime: 10 * 60_000,
  });

  // Existing record
  const { data: existing, isLoading } = useQuery({
    queryKey: ['workshop', workshopId],
    queryFn: () => api.workshops.get(workshopId!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      workshopNameId: existing.WorkshopNameID?.toString() ?? '',
      schoolYearId: existing.SchoolYearID?.toString() ?? '',
      categoryId: existing.CategoryID?.toString() ?? '',
      agencyId: existing.AgencyID?.toString() ?? '',
      workshopCode: existing.WorkshopCode ?? '',
      startDate: dateValue(existing.StartDate),
      endDate: dateValue(existing.EndDate),
      startTime: timeValue(existing.StartTime),
      endTime: timeValue(existing.EndTime),
      maxEnrollment: existing.MaxEnrollment?.toString() ?? '',
      minEnrollment: existing.MinEnrollment?.toString() ?? '',
      room: existing.Room?.toString() ?? '',
      cost1: existing.Cost1?.toString() ?? '',
      creditPossible: existing.CreditPossible ?? '',
      sessionCount: existing.SessionCount?.toString() ?? '',
      sessionHours: existing.SessionHours?.toString() ?? '',
      sessionCeus: existing.SessionCeus?.toString() ?? '',
      notes: existing.Notes ?? '',
      specialNotes: existing.SpecialNotes ?? '',
    });
    setFlags({
      isBrochure: existing.IsBrochure,
      isFolder: existing.IsFolder,
      isLabel: existing.IsLabel,
      isClosed: existing.IsClosed,
      isCancelled: existing.IsCancelled,
      isContracted: existing.IsContracted,
      isStaffDev: existing.IsStaffDev,
      isRegistrationOpen: existing.IsRegistrationOpen,
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

      const body: WorkshopWrite = {
        workshopNameId: num(form.workshopNameId),
        schoolYearId: num(form.schoolYearId),
        categoryId: num(form.categoryId),
        agencyId: num(form.agencyId),
        workshopCode: str(form.workshopCode),
        startDate: str(form.startDate),
        endDate: str(form.endDate),
        startTime: str(form.startTime),
        endTime: str(form.endTime),
        maxEnrollment: num(form.maxEnrollment),
        minEnrollment: num(form.minEnrollment),
        room: num(form.room),
        cost1: num(form.cost1),
        creditPossible: str(form.creditPossible),
        sessionCount: num(form.sessionCount),
        sessionHours: num(form.sessionHours),
        sessionCeus: num(form.sessionCeus),
        notes: str(form.notes),
        specialNotes: str(form.specialNotes),
        ...flags,
      };

      return isEdit
        ? api.workshops.update(workshopId, body)
        : api.workshops.create(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workshops'] });
      if (isEdit) void qc.invalidateQueries({ queryKey: ['workshop', workshopId] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof HttpError) setFormError(err.message);
      else if (err.message !== 'validation') setFormError('Could not save. Please try again.');
    },
  });

  const remove = useMutation({
    mutationFn: () => api.workshops.remove(workshopId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workshops'] });
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

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer drawer-wide" role="dialog" aria-modal="true" aria-labelledby="ws-title" ref={resize.drawerRef} style={resize.drawerStyle}>
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="ws-title">{isEdit ? 'Edit workshop' : 'Add workshop'}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {isEdit && (
          <div className="drawer-tabs" role="tablist" aria-label="Workshop sections">
            <button
              type="button"
              role="tab"
              id="tab-details"
              className="drawer-tab"
              aria-selected={tab === 'details'}
              aria-controls="panel-details"
              onClick={() => setTab('details')}
            >
              Details
            </button>
            <button
              type="button"
              role="tab"
              id="tab-registrants"
              className="drawer-tab"
              aria-selected={tab === 'registrants'}
              aria-controls="panel-registrants"
              onClick={() => setTab('registrants')}
            >
              Registrants
              {existing && existing.Registered > 0 && (
                <span className="drawer-tab-count">{existing.Registered}</span>
              )}
            </button>
          </div>
        )}

        {isEdit && isLoading ? (
          <div className="drawer-body">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 44, marginBottom: 12 }} />
            ))}
          </div>
        ) : isEdit && tab === 'registrants' ? (
          <div
            className="drawer-body"
            role="tabpanel"
            id="panel-registrants"
            aria-labelledby="tab-registrants"
          >
            <WorkshopRegistrants
              workshopId={workshopId}
              capacity={existing?.MaxEnrollment ?? null}
              onOpenRegistration={onOpenRegistration}
            />
          </div>
        ) : (
          <form
            className="drawer-body"
            onSubmit={onSubmit}
            noValidate
            role={isEdit ? 'tabpanel' : undefined}
            id={isEdit ? 'panel-details' : undefined}
            aria-labelledby={isEdit ? 'tab-details' : undefined}
          >
            {formError && (
              <div className="alert alert-error" role="alert">
                <IconAlert width={18} height={18} />
                <span>{formError}</span>
              </div>
            )}

            <fieldset className="fieldset">
              <legend>Details</legend>

              <div className="field">
                <label htmlFor="w-name">Workshop name</label>
                <select
                  id="w-name"
                  value={form.workshopNameId ?? ''}
                  onChange={(e) => set('workshopNameId', e.target.value)}
                >
                  <option value="">— none —</option>
                  {names?.data.map((n) => (
                    <option key={n.id} value={n.id}>{n.label}</option>
                  ))}
                </select>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="w-code">Code</label>
                  <input
                    id="w-code"
                    value={form.workshopCode ?? ''}
                    onChange={(e) => set('workshopCode', e.target.value)}
                    maxLength={10}
                    aria-invalid={errors.workshopCode ? 'true' : undefined}
                  />
                  {errors.workshopCode && <span className="error" role="alert">{errors.workshopCode}</span>}
                </div>

                <div className="field">
                  <label htmlFor="w-year">School year</label>
                  <select
                    id="w-year"
                    value={form.schoolYearId ?? ''}
                    onChange={(e) => set('schoolYearId', e.target.value)}
                  >
                    <option value="">— none —</option>
                    {years?.data.map((y) => (
                      <option key={y.id} value={y.id}>{y.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="w-category">Category</label>
                <select
                  id="w-category"
                  value={form.categoryId ?? ''}
                  onChange={(e) => set('categoryId', e.target.value)}
                >
                  <option value="">— none —</option>
                  {categories?.data.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Schedule</legend>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="w-start">Start date</label>
                  <input
                    id="w-start"
                    type="date"
                    value={form.startDate ?? ''}
                    onChange={(e) => set('startDate', e.target.value)}
                    aria-invalid={errors.startDate ? 'true' : undefined}
                  />
                  {errors.startDate && <span className="error" role="alert">{errors.startDate}</span>}
                </div>

                <div className="field">
                  <label htmlFor="w-end">End date</label>
                  <input
                    id="w-end"
                    type="date"
                    value={form.endDate ?? ''}
                    onChange={(e) => set('endDate', e.target.value)}
                    aria-invalid={errors.endDate ? 'true' : undefined}
                  />
                  {errors.endDate && <span className="error" role="alert">{errors.endDate}</span>}
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="w-tstart">Start time</label>
                  <input
                    id="w-tstart"
                    type="time"
                    value={form.startTime ?? ''}
                    onChange={(e) => set('startTime', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="w-tend">End time</label>
                  <input
                    id="w-tend"
                    type="time"
                    value={form.endTime ?? ''}
                    onChange={(e) => set('endTime', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Enrollment</legend>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="w-max">Maximum</label>
                  <input
                    id="w-max"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={form.maxEnrollment ?? ''}
                    onChange={(e) => set('maxEnrollment', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="w-min">Minimum</label>
                  <input
                    id="w-min"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={form.minEnrollment ?? ''}
                    onChange={(e) => set('minEnrollment', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="w-room">Room</label>
                  <input
                    id="w-room"
                    type="number"
                    inputMode="numeric"
                    value={form.room ?? ''}
                    onChange={(e) => set('room', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Credit &amp; cost</legend>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="w-cost">Cost</label>
                  <input
                    id="w-cost"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={form.cost1 ?? ''}
                    onChange={(e) => set('cost1', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="w-credit">Credit type</label>
                  <input
                    id="w-credit"
                    value={form.creditPossible ?? ''}
                    onChange={(e) => set('creditPossible', e.target.value)}
                    placeholder="e.g. CEU"
                  />
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="w-sessions">Sessions</label>
                  <input
                    id="w-sessions"
                    type="number"
                    inputMode="numeric"
                    value={form.sessionCount ?? ''}
                    onChange={(e) => set('sessionCount', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="w-hours">Hours</label>
                  <input
                    id="w-hours"
                    type="number"
                    inputMode="decimal"
                    step="0.25"
                    value={form.sessionHours ?? ''}
                    onChange={(e) => set('sessionHours', e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="w-ceus">CEUs</label>
                  <input
                    id="w-ceus"
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={form.sessionCeus ?? ''}
                    onChange={(e) => set('sessionCeus', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Status</legend>

              <div className="checkbox-grid">
                {([
                  ['isClosed', 'Closed'],
                  ['isCancelled', 'Cancelled'],
                  ['isBrochure', 'In brochure'],
                  ['isFolder', 'Needs folder'],
                  ['isLabel', 'Needs label'],
                  ['isContracted', 'Contracted'],
                  ['isStaffDev', 'Staff development'],
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

              {/* The public form reads this switch, so it lives with the status
                  flags and is saved with the rest of the workshop. */}
              <div className="toggle-row" style={{ marginTop: 14 }}>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={flags.isRegistrationOpen}
                    onChange={(e) =>
                      setFlags((f) => ({ ...f, isRegistrationOpen: e.target.checked }))
                    }
                  />
                  <span className="switch-track" aria-hidden="true" />
                  <span className="switch-label">
                    Open for public registration
                    <span className="field-hint" style={{ marginTop: 0 }}>
                      Off means the public link shows &ldquo;Registration is closed&rdquo;.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Notes</legend>

              <div className="field">
                <label htmlFor="w-notes">Workshop notes</label>
                <textarea
                  id="w-notes"
                  rows={3}
                  value={form.notes ?? ''}
                  onChange={(e) => set('notes', e.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="w-special">Special notes</label>
                <textarea
                  id="w-special"
                  rows={2}
                  value={form.specialNotes ?? ''}
                  onChange={(e) => set('specialNotes', e.target.value)}
                />
              </div>
            </fieldset>

            {isEdit && <RegistrationLinkPanel workshopId={workshopId} />}

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
                {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add workshop'}
              </button>
            </div>
          </form>
        )}
      </aside>

      {confirmDelete && (
        <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDelete(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true">
            <h2>Delete this workshop?</h2>
            <p>
              This cannot be undone. Workshops with registrations or sessions cannot be
              deleted — cancel them instead so the history is kept.
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
