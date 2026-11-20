import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RegistrationLinkState } from '@pe/shared';
import { api, HttpError } from '../api';
import { IconAlert } from './icons';

/**
 * Staff panel for the public registration link (plan §4.1).
 *
 * Two independent switches, deliberately:
 *  - "Registration open" is the workshop-level business decision. Closing it
 *    tells the public "Registration is closed" rather than 404.
 *  - The link's own switch revokes one specific URL. That is usually a
 *    distribution mistake — posted to the wrong audience, shared too widely.
 *
 * Both default to off. A workshop is never publicly registerable by accident.
 */
export function RegistrationLinkPanel({ workshopId }: { workshopId: number }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['registration-link', workshopId],
    queryFn: () => api.registrationLink.get(workshopId),
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['registration-link', workshopId] });
  }

  const create = useMutation({
    mutationFn: (rotate: boolean) => api.registrationLink.create(workshopId, { rotate }),
    onSuccess: () => {
      refresh();
      setConfirmRotate(false);
    },
    onError: (err) => setError(err instanceof HttpError ? err.message : 'Could not create the link.'),
  });

  const update = useMutation({
    mutationFn: (body: { isActive?: boolean; webSeatCap?: number | null }) =>
      api.registrationLink.update(workshopId, body),
    onSuccess: refresh,
    onError: (err) => setError(err instanceof HttpError ? err.message : 'Could not update the link.'),
  });

  async function copyLink(url: string) {
    const full = `${window.location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — select the link and copy it manually.');
    }
  }

  if (isLoading) {
    return (
      <fieldset className="fieldset">
        <legend>Public registration</legend>
        <div className="skeleton" style={{ height: 60 }} />
      </fieldset>
    );
  }

  if (!data) return null;

  const { workshop, link } = data as RegistrationLinkState;

  return (
    <fieldset className="fieldset">
      <legend>Public registration</legend>

      {error && (
        <div className="alert alert-error" role="alert">
          <IconAlert width={18} height={18} />
          <span>{error}</span>
        </div>
      )}

      {!link ? (
        <>
          <p className="field-hint" style={{ marginBottom: 12 }}>
            Create a shareable link so participants can register online. The link is
            inactive until you open it.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => create.mutate(false)}
            disabled={create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create registration link'}
          </button>
        </>
      ) : (
        <>
          <div className="link-row">
            <code className="link-url">{`${window.location.origin}${link.url}`}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void copyLink(link.url)}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className="toggle-row">
            <label className="switch">
              <input
                type="checkbox"
                checked={link.isActive}
                onChange={(e) => update.mutate({ isActive: e.target.checked })}
                disabled={update.isPending}
              />
              <span className="switch-track" aria-hidden="true" />
              <span className="switch-label">
                Link active
                <span className="field-hint" style={{ marginTop: 0 }}>
                  Off means the URL shows &ldquo;This link is no longer valid&rdquo;.
                </span>
              </span>
            </label>
          </div>

          <div className="link-stats">
            <span>
              <strong>{link.webRegistrations}</strong> web registration
              {link.webRegistrations === 1 ? '' : 's'}
            </span>
            {link.webSeatCap !== null && (
              <span>
                cap <strong>{link.webSeatCap}</strong>
              </span>
            )}
          </div>

          {!confirmRotate ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-danger-text"
              onClick={() => setConfirmRotate(true)}
            >
              Revoke and issue a new link
            </button>
          ) : (
            <div className="rotate-confirm">
              <p>
                The current link stops working immediately. Registrations already taken
                are unaffected.
              </p>
              <div className="drawer-actions" style={{ marginTop: 10, paddingTop: 0, borderTop: 0 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRotate(false)}>
                  Keep current link
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => create.mutate(true)}
                  disabled={create.isPending}
                >
                  {create.isPending ? 'Reissuing…' : 'Revoke and reissue'}
                </button>
              </div>
            </div>
          )}

          <p className="field-hint" style={{ marginTop: 12 }}>
            Workshop registration is{' '}
            <strong>{workshop.isRegistrationOpen ? 'open' : 'closed'}</strong>. Closing it
            (via the workshop status) shows &ldquo;Registration is closed&rdquo; to the
            public rather than an error.
          </p>
        </>
      )}
    </fieldset>
  );
}
