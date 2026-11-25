import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormTemplateKind } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconRequests } from '../components/icons';

/**
 * Form Designer: the list of form templates.
 *
 * A template is a named question set; its versions are what links actually
 * pin. Editing opens the full-page editor at /admin/forms/:id, which always
 * writes a new draft version.
 */
export function FormsPage() {
  const { user } = useAuth();
  const canEdit = user && ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(user.role);
  const canPublish = user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role);
  const qc = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<FormTemplateKind>('registration');
  const [notice, setNotice] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['forms', showArchived],
    queryFn: () => api.forms.list(showArchived),
  });

  const rows = data?.data ?? [];
  const archivedCount = rows.filter((f) => f.isArchived).length;

  function openEditor(id: number) {
    window.history.pushState({}, '', `/admin/forms/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  const create = useMutation({
    mutationFn: () => api.forms.create({ name: newName.trim(), kind: newKind }),
    onSuccess: (r) => {
      setCreating(false);
      setNewName('');
      setNewKind('registration');
      setNotice(null);
      qc.invalidateQueries({ queryKey: ['forms'] });
      openEditor(r.formTemplateId);
    },
    onError: (e: Error) => setNotice(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: (v: { id: number; isActive: boolean }) =>
      api.forms.update(v.id, { isActive: v.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['forms'] }),
    onError: (e: Error) => setNotice(e.message),
  });

  const archive = useMutation({
    mutationFn: (id: number) => api.forms.archive(id),
    onSuccess: () => {
      setNotice(null);
      qc.invalidateQueries({ queryKey: ['forms'] });
    },
    onError: (e: Error) => setNotice(e.message),
  });

  const restore = useMutation({
    mutationFn: (id: number) => api.forms.restore(id),
    onSuccess: () => {
      setNotice(null);
      qc.invalidateQueries({ queryKey: ['forms'] });
    },
    onError: (e: Error) => setNotice(e.message),
  });

  useEffect(() => {
    // Legacy deep link: /admin/forms?edit=<id> redirects to the page route.
    const id = new URLSearchParams(window.location.search).get('edit');
    if (id && /^\d+$/.test(id)) {
      window.history.replaceState({}, '', `/admin/forms/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }, []);

  return (
    <AppShell currentPath="/admin/forms" title="Form Designer">
      <div className="page-head">
        <div>
          <h2>Form Designer</h2>
          <p>
            The questions on the public registration form. Workshop details — title, date,
            time, cost — always show and are not part of a form.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New form
          </button>
        )}
      </div>

      {notice && (
        <div className="alert alert-error" role="alert">
          <span>{notice}</span>
        </div>
      )}

      {creating && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-body" style={{ padding: 16 }}>
            <div className="field" style={{ marginBottom: 10 }}>
              <label htmlFor="new-form-name">Form name</label>
              <input
                id="new-form-name"
                className="input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Standard Registration Form"
              />
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label htmlFor="new-form-kind">Stores submissions as</label>
              <select
                id="new-form-kind"
                className="input"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as FormTemplateKind)}
              >
                <option value="registration">Workshop registration</option>
                <option value="trainingRequest">Training request</option>
              </select>
              <span className="field-hint">
                {newKind === 'trainingRequest'
                  ? 'Submissions appear on the Training requests screen.'
                  : 'Submissions create a participant and a registration.'}
              </span>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!newName.trim() || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          <span>Could not load forms. {(error as Error).message}</span>
        </div>
      )}

      <div className="panel">
        <div className="panel-body">
          <div className="list-toolbar">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              <span>Show archived</span>
            </label>
            {showArchived && archivedCount > 0 && (
              <span className="muted" style={{ fontSize: 13 }}>
                {archivedCount} archived
              </span>
            )}
          </div>
          {isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1].map((i) => (
                <div key={i} className="skeleton" style={{ height: 48, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <IconRequests width={28} height={28} />
              <p style={{ marginTop: 10 }}>No forms yet.</p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 460, margin: '8px auto 0' }}>
                Create one to give a workshop its own registration questions. A new form starts
                with the six standard fields.
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Form</th>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.formTemplateId}>
                    <td data-label="Form">
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => openEditor(f.formTemplateId)}
                      >
                        {f.name}
                      </button>
                      {f.description && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {f.description}
                        </div>
                      )}
                    </td>
                    <td data-label="Version" className="muted">
                      {f.currentVersionNumber === null ? '—' : `v${f.currentVersionNumber}`}
                    </td>
                    <td data-label="Status">
                      {f.isArchived ? (
                        <span className="pill pill-muted">Archived</span>
                      ) : !f.isActive ? (
                        <span className="pill pill-muted">Inactive</span>
                      ) : f.isPublished ? (
                        <span className="pill pill-open">Published</span>
                      ) : (
                        <span className="pill pill-full">Draft only</span>
                      )}
                    </td>
                    <td data-label="Actions" className="num">
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => openEditor(f.formTemplateId)}
                        >
                          Edit
                        </button>
                        {canPublish && !f.isArchived && (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() =>
                                toggleActive.mutate({ id: f.formTemplateId, isActive: !f.isActive })
                              }
                            >
                              {f.isActive ? 'Deactivate' : 'Activate'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Archive "${f.name}"? It is hidden from this list and from the link picker, but its versions and answers are kept. You can restore it later.`,
                                  )
                                ) {
                                  archive.mutate(f.formTemplateId);
                                }
                              }}
                            >
                              Archive
                            </button>
                          </>
                        )}
                        {canPublish && f.isArchived && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => restore.mutate(f.formTemplateId)}
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppShell>
  );
}
