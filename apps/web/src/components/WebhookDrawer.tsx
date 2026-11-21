import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';

const SAMPLE_SCHEMA = `{
  "type": "object",
  "properties": {
    "event": { "type": "string" },
    "workshopCode": { "type": "string" },
    "registered": { "type": "integer" },
    "capacity": { "type": "integer" }
  }
}`;

/**
 * Create or edit a webhook.
 *
 * The JSON Schema is validated server-side on save, and used to build the
 * test payload, so what staff define here is what gets sent.
 */
export function WebhookDrawer({
  webhookId,
  canDelete,
  onClose,
}: {
  webhookId: number | null;
  canDelete: boolean;
  onClose: () => void;
}) {
  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.webhook');
  const qc = useQueryClient();
  const isEdit = webhookId !== null;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [jsonSchema, setJsonSchema] = useState('');
  const [payloadFormat, setPayloadFormat] = useState<'json' | 'slack'>('json');
  const [secret, setSecret] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: existing, isLoading } = useQuery({
    queryKey: ['webhook', webhookId],
    queryFn: () => api.webhooks.get(webhookId!),
    enabled: isEdit,
  });

  const { data: deliveries } = useQuery({
    queryKey: ['webhook-deliveries', webhookId],
    queryFn: () => api.webhooks.deliveries(webhookId!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setTitle(existing.Title);
    setDescription(existing.Description ?? '');
    setUrl(existing.Url);
    setJsonSchema(existing.JsonSchema ?? '');
    setPayloadFormat(existing.PayloadFormat === 'slack' ? 'slack' : 'json');
    setIsActive(existing.IsActive);
  }, [existing]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        description: description.trim() || null,
        url: url.trim(),
        jsonSchema: jsonSchema.trim() || null,
        payloadFormat,
        isActive,
        secret: secret.trim() || undefined,
      };
      return isEdit
        ? api.webhooks.update(webhookId!, body)
        : api.webhooks.create(body);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      qc.invalidateQueries({ queryKey: ['webhook', webhookId] });
      if (isEdit) {
        setNotice('Saved.');
        setSecret('');
      } else {
        onClose();
      }
      void r;
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.webhooks.remove(webhookId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const test = useMutation({
    mutationFn: () => api.webhooks.test(webhookId!),
    onSuccess: (r) => {
      setNotice(
        r.succeeded
          ? `Test delivered — HTTP ${r.statusCode} in ${r.durationMs}ms.`
          : `Test failed — ${r.error ?? `HTTP ${r.statusCode}`}`,
      );
      qc.invalidateQueries({ queryKey: ['webhook-deliveries', webhookId] });
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (e: Error) => setNotice(e.message),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    if (!/^https?:\/\//i.test(url.trim())) {
      setError('URL must start with http:// or https://');
      return;
    }

    save.mutate();
  }

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="drawer drawer-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wh-title"
        ref={resize.drawerRef}
        style={resize.drawerStyle}
      >
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="wh-title">{isEdit ? 'Edit webhook' : 'Add webhook'}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {isEdit && isLoading ? (
          <div className="drawer-body">
            {[0, 1, 2].map((i) => (
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
            {notice && (
              <div className="alert alert-info" role="status">
                <span>{notice}</span>
              </div>
            )}

            <fieldset className="fieldset">
              <legend>Details</legend>

              <div className="field">
                <label htmlFor="wh-title-input">Title</label>
                <input
                  id="wh-title-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  placeholder="e.g. Workshop capacity alerts"
                />
              </div>

              <div className="field">
                <label htmlFor="wh-desc">Description</label>
                <textarea
                  id="wh-desc"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={1000}
                  placeholder="What this endpoint receives, and who looks after it."
                />
              </div>

              <div className="field">
                <label htmlFor="wh-url">Webhook URL</label>
                <input
                  id="wh-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  maxLength={2000}
                  placeholder="https://hooks.slack.com/services/..."
                />
              </div>

              <div className="field">
                <label htmlFor="wh-format">Payload format</label>
                <select
                  id="wh-format"
                  value={payloadFormat}
                  onChange={(e) => setPayloadFormat(e.target.value as 'json' | 'slack')}
                >
                  <option value="json">JSON — send the schema shape as-is</option>
                  <option value="slack">Slack — wrap the message for Slack</option>
                </select>
                <span className="field-hint">
                  {payloadFormat === 'slack'
                    ? 'Slack rejects arbitrary JSON, so the payload is wrapped in Slack’s text/blocks format. The schema below is used to build the message body.'
                    : 'The body is POSTed exactly as the schema describes, wrapped in an event envelope.'}
                </span>
              </div>

              <div className="field">
                <label htmlFor="wh-secret">Shared secret (optional)</label>
                <input
                  id="wh-secret"
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  maxLength={200}
                  placeholder={isEdit ? 'Leave blank to keep the current secret' : ''}
                />
                <span className="field-hint">
                  Sent as the <code>X-Webhook-Secret</code> header so the receiver can verify the
                  call came from us.
                </span>
              </div>

              <div className="toggle-row">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                  <span className="switch-label">
                    Active
                    <span className="field-hint" style={{ marginTop: 0 }}>
                      Inactive webhooks are skipped when events fire.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>JSON Schema</legend>
              <div className="field">
                <label htmlFor="wh-schema">Payload shape</label>
                <textarea
                  id="wh-schema"
                  rows={12}
                  value={jsonSchema}
                  onChange={(e) => setJsonSchema(e.target.value)}
                  spellCheck={false}
                  style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 }}
                  placeholder={SAMPLE_SCHEMA}
                />
                <span className="field-hint">
                  Describes the body the app will POST. Used to build the test payload, so what you
                  define here is what gets sent.
                </span>
              </div>
              {!jsonSchema.trim() && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setJsonSchema(SAMPLE_SCHEMA)}
                >
                  Insert sample schema
                </button>
              )}
            </fieldset>

            {isEdit && (
              <fieldset className="fieldset">
                <legend>Recent deliveries</legend>
                {(deliveries?.data ?? []).length === 0 ? (
                  <p className="field-hint">No deliveries yet. Use Test to send one.</p>
                ) : (
                  <table className="data-table" style={{ fontSize: 12.5 }}>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Event</th>
                        <th>Result</th>
                        <th className="num">ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(deliveries?.data ?? []).map((d) => (
                        <tr key={d.WebhookDeliveryID}>
                          <td>{new Date(d.AttemptedAt).toLocaleString('en-US')}</td>
                          <td>{d.EventKind}</td>
                          <td>
                            {d.Succeeded ? (
                              <span className="pill pill-open">HTTP {d.StatusCode}</span>
                            ) : (
                              <span className="pill pill-cancelled">
                                {d.StatusCode ? `HTTP ${d.StatusCode}` : 'Failed'}
                              </span>
                            )}
                          </td>
                          <td className="num">{d.DurationMs ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
              {isEdit && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => test.mutate()}
                  disabled={test.isPending}
                >
                  {test.isPending ? 'Sending…' : 'Send test'}
                </button>
              )}
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add webhook'}
              </button>
            </div>
          </form>
        )}
      </aside>

      {confirmDelete && (
        <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDelete(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true">
            <h2>Delete this webhook?</h2>
            <p>
              This removes the endpoint and its delivery history. Any event that would have been
              sent here will be dropped.
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
