import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  const [notice, setNotice] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['forms'],
    queryFn: () => api.forms.list(),
  });

  const rows = data?.data ?? [];

  function openEditor(id: number) {
    window.history.pushState({}, '', `/admin/forms/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  const create = useMutation({
    mutationFn: () => api.forms.create({ name: newName.trim() }),
    onSuccess: (r) => {
      setCreating(false);
      setNewName('');
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

  const remove = useMutation({
    mutationFn: (id: number) => api.forms.remove(id),
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
    <AppShell currentPath="/admin/forms" title="Forms">
      <div className="page-head">
        <div>
          <h2>Forms</h2>
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
                      {!f.isActive ? (
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
                        {canPublish && (
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
                                    `Delete "${f.name}"? Links using it must be repointed first.`,
                                  )
                                ) {
                                  remove.mutate(f.formTemplateId);
                                }
                              }}
                            >
                              Delete
                            </button>
                          </>
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
