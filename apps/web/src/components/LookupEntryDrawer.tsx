import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type LookupFieldDef, type LookupValues } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';

/**
 * Add or edit one entry of a reference list.
 *
 * The fields come from the API rather than being hard-coded per list, so a
 * new maintainable lookup only needs an entry in the API whitelist. Only the
 * columns the API exposes are sent, so nothing else on the row is touched.
 */
export function LookupEntryDrawer({
  lookupKey,
  entryId,
  canDelete,
  onClose,
}: {
  lookupKey: string;
  /** null creates a new entry. */
  entryId: number | null;
  canDelete: boolean;
  onClose: () => void;
}) {
  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.lookup');
  const qc = useQueryClient();
  const isEdit = entryId !== null;

  const { data: settings } = useQuery({
    queryKey: ['lookup-settings', lookupKey],
    queryFn: () => api.lookups.settings(lookupKey),
    staleTime: 10 * 60_000,
  });

  const { data: rows, isLoading } = useQuery({
    queryKey: ['lookup', lookupKey],
    queryFn: () => api.lookups.get(lookupKey),
    enabled: isEdit,
  });

  const existing = rows?.data.find((r) => r.id === entryId);

  const [form, setForm] = useState<LookupValues>({});
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Seed the form once the field list (and, when editing, the row) arrives.
  useEffect(() => {
    const defs = settings?.data.fields;
    if (!defs) return;
    if (!isEdit) {
      setForm(Object.fromEntries(defs.map((f) => [f.key, f.type === 'boolean' ? false : ''])));
      return;
    }
    if (!existing) return;
    setForm(
      Object.fromEntries(
        defs.map((f) => [
          f.key,
          f.type === 'boolean' ? existing[f.key] === true : String(existing[f.key] ?? ''),
        ]),
      ),
    );
  }, [settings, existing, isEdit]);

  function set(key: string, value: string | boolean) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ['lookup', lookupKey] });
    qc.invalidateQueries({ queryKey: ['lookup-settings', lookupKey] });
  }

  const save = useMutation({
    mutationFn: async (body: LookupValues): Promise<void> => {
      if (isEdit) await api.lookups.update(lookupKey, entryId, body);
      else await api.lookups.create(lookupKey, body);
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e: Error & { details?: { path: string; message: string }[] }) => {
      if (e.details?.length) {
        setFieldErrors(Object.fromEntries(e.details.map((d) => [d.path, d.message])));
      }
      setError(e.message);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.lookups.remove(lookupKey, entryId!),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e: Error) => {
      setConfirmDelete(false);
      setError(e.message);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const body: LookupValues = {};
    const missing: Record<string, string> = {};

    for (const def of settings?.data.fields ?? []) {
      const value = form[def.key];
      if (def.type === 'boolean') {
        body[def.key] = value === true;
        continue;
      }
      const text = typeof value === 'string' ? value.trim() : '';
      if (def.required && !text) missing[def.key] = `${def.label} is required`;
      body[def.key] = text || null;
    }

    if (Object.keys(missing).length) {
      setFieldErrors(missing);
      return;
    }

    save.mutate(body);
  }

  const fields = settings?.data.fields ?? [];
  const usage = existing?.usageCount ?? 0;

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lk-title"
        ref={resize.drawerRef}
        style={resize.drawerStyle}
      >
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="lk-title">
            {isEdit ? 'Edit entry' : 'Add entry'}
            {settings && <span className="cell-sub"> · {settings.data.title}</span>}
          </h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {isEdit && isLoading ? (
          <div className="drawer-body">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton" style={{ height: 44, marginBottom: 12 }} />
            ))}
          </div>
        ) : (
          <form className="drawer-body" onSubmit={onSubmit} noValidate>
            {error && (
              <div className="alert alert-error" role="alert">
                <IconAlert width={18} height={18} />
                <span>{error}</span>
              </div>
            )}

            {settings?.data.note && (
              <div className="alert alert-info" role="note">
                <span>{settings.data.note}</span>
              </div>
            )}

            <fieldset className="fieldset">
              <legend>Details</legend>

              {fields.map((def) => (
                <LookupField
                  key={def.key}
                  def={def}
                  value={form[def.key]}
                  error={fieldErrors[def.key]}
                  onChange={(v) => set(def.key, v)}
                />
              ))}
            </fieldset>

            {isEdit && (
              <p className="field-hint">
                {usage > 0
                  ? `Used by ${usage.toLocaleString()} record(s). Renaming it updates them everywhere, because they point at this entry.`
                  : 'Nothing uses this entry yet.'}
              </p>
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
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add entry'}
              </button>
            </div>
          </form>
        )}
      </aside>

      {confirmDelete && (
        <div
          className="drawer-scrim"
          onMouseDown={(e) => e.target === e.currentTarget && setConfirmDelete(false)}
        >
          <div className="dialog" role="alertdialog" aria-modal="true">
            <h2>Delete this entry?</h2>
            <p>
              {usage > 0
                ? `It is still used by ${usage.toLocaleString()} record(s), so it cannot be deleted until those point somewhere else.`
                : 'Nothing uses it, so removing it is safe.'}
            </p>
            <div className="drawer-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => remove.mutate()}
                disabled={remove.isPending || usage > 0}
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

function LookupField({
  def,
  value,
  error,
  onChange,
}: {
  def: LookupFieldDef;
  value: string | boolean | null | undefined;
  error?: string;
  onChange: (v: string | boolean) => void;
}) {
  const id = `lk-${def.key}`;

  if (def.type === 'boolean') {
    return (
      <div className="field">
        <label className="checkbox" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{def.label}</span>
        </label>
      </div>
    );
  }

  return (
    <div className="field">
      <label htmlFor={id}>{def.label}</label>
      <input
        id={id}
        value={typeof value === 'string' ? value : ''}
        maxLength={def.max}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? 'true' : undefined}
        required={def.required}
      />
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
