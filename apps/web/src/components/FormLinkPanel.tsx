import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError } from '../api';
import { IconAlert } from './icons';

/**
 * Public link for a standalone form (a training request, say).
 *
 * Lives in the form editor header rather than a workshop drawer, because this
 * form has no workshop to hang a link off. Renders as a single line under the
 * title so it stays out of the way until there is something to share.
 */
export function FormLinkPanel({
  formTemplateId,
  canEdit,
}: {
  formTemplateId: number;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['form-link', formTemplateId],
    queryFn: () => api.registrationLink.getForForm(formTemplateId),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['form-link', formTemplateId] });
  };

  const create = useMutation({
    mutationFn: () => api.registrationLink.createForForm(formTemplateId),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof HttpError ? e.message : 'Could not create the link.'),
  });

  const update = useMutation({
    mutationFn: (isActive: boolean) =>
      api.registrationLink.updateForForm(formTemplateId, { isActive }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof HttpError ? e.message : 'Could not update the link.'),
  });

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — select the link and copy it manually.');
    }
  }

  if (isLoading || !data) return null;

  const { link, hasPublishedVersion, isArchived } = data;

  return (
    <div className="form-link-bar">
      {error && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 8 }}>
          <IconAlert width={16} height={16} />
          <span>{error}</span>
        </div>
      )}

      {!link ? (
        <div className="form-link-row">
          <span className="form-link-label">Public link</span>
          {isArchived ? (
            <span className="field-hint">Restore this form to create a link.</span>
          ) : !hasPublishedVersion ? (
            <span className="field-hint">Publish this form to create a shareable link.</span>
          ) : canEdit ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => create.mutate()}
              disabled={create.isPending}
            >
              {create.isPending ? 'Creating…' : 'Create public link'}
            </button>
          ) : (
            <span className="field-hint">No link yet.</span>
          )}
        </div>
      ) : (
        <div className="form-link-row">
          <span className="form-link-label">Public link</span>
          <code className="link-url">{`${window.location.origin}${link.url}`}</code>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void copyLink(link.url)}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <label className="switch switch-inline">
            <input
              type="checkbox"
              checked={link.isActive}
              onChange={(e) => update.mutate(e.target.checked)}
              disabled={!canEdit || update.isPending}
            />
            <span className="switch-track" aria-hidden="true" />
            <span className="switch-label">
              {link.isActive ? 'Open' : 'Closed'}
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
