import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { WorkshopNameWrite } from '@pe/shared';
import { api, HttpError } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';

const schema = z.object({
  workshopName: z.string().min(1, 'A workshop title is required').max(255),
  shortName: z.string().max(100).optional(),
  agesId: z.string().optional(),
  eCourseNum: z
    .string()
    .refine((v) => v === '' || /^\d+$/.test(v), 'Digits only')
    .optional(),
  wlCourse: z
    .string()
    .refine((v) => v === '' || /^\d+$/.test(v), 'Digits only')
    .optional(),
  prerequisites: z.string().max(255).optional(),
  topicNums: z.string().max(15).optional(),
  description: z.string().optional(),
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

export function WorkshopNameDrawer({
  workshopNameId,
  canDelete,
  onClose,
}: {
  workshopNameId: number | null;
  canDelete: boolean;
  onClose: () => void;
}) {
  const isEdit = workshopNameId !== null;
  const qc = useQueryClient();

  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.workshopName');

  const [form, setForm] = useState<Record<string, string>>({});
  const [isLiteracy, setIsLiteracy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: ages } = useQuery({
    queryKey: ['lookup', 'ages'],
    queryFn: () => api.lookups.get('ages'),
    staleTime: 10 * 60_000,
  });

  const { data: existing, isLoading } = useQuery({
    queryKey: ['workshop-name', workshopNameId],
    queryFn: () => api.workshopNames.get(workshopNameId!),
    enabled: isEdit,
  });

  const { data: workshops } = useQuery({
    queryKey: ['workshop-name-workshops', workshopNameId],
    queryFn: () => api.workshopNames.workshops(workshopNameId!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      workshopName: existing.WorkshopName ?? '',
      shortName: existing.ShortName ?? '',
      agesId: existing.AgesID?.toString() ?? '',
      eCourseNum: existing.ECourseNum?.toString() ?? '',
      wlCourse: existing.WLCourse?.toString() ?? '',
      prerequisites: existing.Prerequisites ?? '',
      topicNums: existing.TopicNums ?? '',
      description: existing.Description ?? '',
    });
    setIsLiteracy(existing.IsLiteracy);
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

      const body: WorkshopNameWrite = {
        workshopName: str(form.workshopName),
        shortName: str(form.shortName),
        agesId: num(form.agesId),
        eCourseNum: num(form.eCourseNum),
        wlCourse: num(form.wlCourse),
        prerequisites: str(form.prerequisites),
        topicNums: str(form.topicNums),
        description: str(form.description),
        isLiteracy,
      };

      return isEdit
        ? api.workshopNames.update(workshopNameId, body)
        : api.workshopNames.create(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workshop-names'] });
      void qc.invalidateQueries({ queryKey: ['lookup', 'workshop-names'] });
      if (isEdit) void qc.invalidateQueries({ queryKey: ['workshop-name', workshopNameId] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof HttpError) {
        if (err.status === 409) {
          setErrors({ workshopName: 'Another catalog entry already uses that title' });
        }
        setFormError(err.message);
      } else if (err.message !== 'validation') {
        setFormError('Could not save. Please try again.');
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => api.workshopNames.remove(workshopNameId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workshop-names'] });
      onClose();
    },
    onError: (err) =>
      setFormError(err instanceof HttpError ? err.message : 'Could not delete this entry.'),
  });

  const title = isEdit ? (existing?.WorkshopName ?? 'Catalog entry') : 'Add catalog entry';

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer drawer-wide" role="dialog" aria-modal="true" aria-labelledby="wn-title" ref={resize.drawerRef} style={resize.drawerStyle}>
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="wn-title">{title}</h2>
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
              <legend>Title</legend>

              <div className="field">
                <label htmlFor="wn-name">Workshop title</label>
                <input
                  id="wn-name"
                  value={form.workshopName ?? ''}
                  onChange={(e) => set('workshopName', e.target.value)}
                  aria-invalid={errors.workshopName ? 'true' : undefined}
                  required
                />
                {errors.workshopName && <span className="error" role="alert">{errors.workshopName}</span>}
              </div>

              <div className="field">
                <label htmlFor="wn-short">Short name</label>
                <input
                  id="wn-short"
                  value={form.shortName ?? ''}
                  onChange={(e) => set('shortName', e.target.value)}
                />
                <span className="field-hint">Used on brochures and labels where space is tight.</span>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="wn-ages">Age group</label>
                  <select
                    id="wn-ages"
                    value={form.agesId ?? ''}
                    onChange={(e) => set('agesId', e.target.value)}
                  >
                    <option value="">— none —</option>
                    {ages?.data.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="wn-topic">Topic numbers</label>
                  <input
                    id="wn-topic"
                    value={form.topicNums ?? ''}
                    onChange={(e) => set('topicNums', e.target.value)}
                    placeholder="e.g. 1,4,7"
                  />
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="wn-ecourse">E-course number</label>
                  <input
                    id="wn-ecourse"
                    inputMode="numeric"
                    value={form.eCourseNum ?? ''}
                    onChange={(e) => set('eCourseNum', e.target.value)}
                    aria-invalid={errors.eCourseNum ? 'true' : undefined}
                  />
                  {errors.eCourseNum && <span className="error" role="alert">{errors.eCourseNum}</span>}
                </div>
                <div className="field">
                  <label htmlFor="wn-wlcourse">WL course</label>
                  <input
                    id="wn-wlcourse"
                    inputMode="numeric"
                    value={form.wlCourse ?? ''}
                    onChange={(e) => set('wlCourse', e.target.value)}
                    aria-invalid={errors.wlCourse ? 'true' : undefined}
                  />
                  {errors.wlCourse && <span className="error" role="alert">{errors.wlCourse}</span>}
                </div>
              </div>

              <div className="field">
                <label htmlFor="wn-prereq">Prerequisites</label>
                <input
                  id="wn-prereq"
                  value={form.prerequisites ?? ''}
                  onChange={(e) => set('prerequisites', e.target.value)}
                />
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Description</legend>
              <div className="field">
                <label htmlFor="wn-desc">Workshop description</label>
                <textarea
                  id="wn-desc"
                  rows={8}
                  value={form.description ?? ''}
                  onChange={(e) => set('description', e.target.value)}
                />
                <span className="field-hint">
                  Appears on brochures and the public registration page.
                </span>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Status</legend>
              <div className="checkbox-grid">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={isLiteracy}
                    onChange={(e) => setIsLiteracy(e.target.checked)}
                  />
                  <span>Literacy</span>
                </label>
              </div>
            </fieldset>

            {isEdit && workshops && workshops.data.length > 0 && (
              <fieldset className="fieldset">
                <legend>Scheduled workshops ({workshops.data.length})</legend>
                <ul className="mini-list">
                  {workshops.data.slice(0, 8).map((w) => (
                    <li key={w.WorkshopID}>
                      <span className="mini-list-main">{w.WorkshopCode ?? 'No code'}</span>
                      <span className="mini-list-sub">
                        {w.SchoolYear ?? '—'}
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
                  Delete this catalog entry? Entries used by scheduled workshops cannot be
                  deleted, because those workshops would lose their title.
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
                      Keep entry
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
                {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add entry'}
              </button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
