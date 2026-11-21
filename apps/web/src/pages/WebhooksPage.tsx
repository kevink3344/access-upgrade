import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebhookRow } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconApi } from '../components/icons';
import { WebhookDrawer } from '../components/WebhookDrawer';

function StatusPill({ hook }: { hook: WebhookRow }) {
  if (!hook.IsActive) return <span className="pill pill-muted">Inactive</span>;
  if (hook.LastSucceeded === null || hook.LastSucceeded === undefined) {
    return <span className="pill pill-info">Never tested</span>;
  }
  return hook.LastSucceeded ? (
    <span className="pill pill-open">Healthy</span>
  ) : (
    <span className="pill pill-cancelled">Failing</span>
  );
}

export function WebhooksPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';
  const qc = useQueryClient();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.webhooks.list(),
  });

  const rows = data?.data ?? [];

  const test = useMutation({
    mutationFn: (id: number) => api.webhooks.test(id),
    onSuccess: (r, id) => {
      const name = rows.find((x) => x.WebhookID === id)?.Title ?? 'Webhook';
      setNotice(
        r.succeeded
          ? `${name}: test delivered (HTTP ${r.statusCode}, ${r.durationMs}ms).`
          : `${name}: test failed — ${r.error ?? `HTTP ${r.statusCode}`}`,
      );
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (e: Error) => setNotice(e.message),
  });

  function openCreate() {
    setEditingId(null);
    setDrawerOpen(true);
  }

  function openEdit(id: number) {
    setEditingId(id);
    setDrawerOpen(true);
  }

  useEffect(() => {
    // Deep link: /admin/webhooks?edit=<id>
    const id = new URLSearchParams(window.location.search).get('edit');
    if (id && /^\d+$/.test(id)) {
      setEditingId(Number(id));
      setDrawerOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  return (
    <AppShell currentPath="/admin/webhooks" title="Webhooks">
      <div className="page-head">
        <div>
          <h2>Webhooks</h2>
          <p>Outbound endpoints the app can POST to. Each has its own URL and payload schema.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add webhook
          </button>
        )}
      </div>

      {notice && (
        <div className="alert alert-info" role="status">
          <span>{notice}</span>
        </div>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          <span>Could not load webhooks. {(error as Error).message}</span>
        </div>
      )}

      <div className="panel">
        <div className="panel-body">
          {isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <IconApi width={28} height={28} />
              <p style={{ marginTop: 10 }}>No webhooks yet.</p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 460, margin: '8px auto 0' }}>
                Add one to start sending events to an external endpoint. Use Test to confirm the
                endpoint accepts the payload before relying on it.
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>URL</th>
                  <th>Status</th>
                  <th className="num">Deliveries</th>
                  <th>Last attempt</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.WebhookID}>
                    <td>
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => openEdit(h.WebhookID)}
                      >
                        {h.Title}
                      </button>
                      {h.Description && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {h.Description}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-muted)', maxWidth: 260 }}>
                      <span style={{ wordBreak: 'break-all' }}>{h.Url}</span>
                    </td>
                    <td>
                      <StatusPill hook={h} />
                    </td>
                    <td className="num">{h.DeliveryCount}</td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {h.LastAttemptAt
                        ? new Date(h.LastAttemptAt).toLocaleString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })
                        : '—'}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={test.isPending}
                          onClick={() => test.mutate(h.WebhookID)}
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => openEdit(h.WebhookID)}
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {drawerOpen && (
        <WebhookDrawer
          webhookId={editingId}
          canDelete={!!canEdit}
          onClose={() => {
            setDrawerOpen(false);
            qc.invalidateQueries({ queryKey: ['webhooks'] });
          }}
        />
      )}
    </AppShell>
  );
}
