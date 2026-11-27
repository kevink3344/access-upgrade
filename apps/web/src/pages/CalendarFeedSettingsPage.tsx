import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { IconWorkshops } from '../components/icons';

/**
 * Workshop calendar feed.
 *
 * A read-only iCalendar URL that Google Calendar, Outlook, or any other
 * calendar app subscribes to. It is off until an administrator switches it
 * on, because the URL is a credential: anyone holding it can read the
 * workshop schedule.
 *
 * The URL comes from the server on every load: the token is stored sealed
 * (AES-256-GCM) next to its hash, so the page can show the current link at
 * any time. Issuing a new one still stops the old one working, which is the
 * remedy for a link that has been shared too widely.
 */
export function CalendarFeedSettingsPage() {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-feed', 'settings'],
    queryFn: () => api.calendarFeed.settings(),
    staleTime: 30_000,
  });

  const enabled = data?.enabled ?? false;
  /** The link the server last reported; null when none exists or it predates migration 033. */
  const url = data?.url ?? null;

  const toggle = useMutation({
    mutationFn: (next: boolean) => api.calendarFeed.setEnabled(next),
    onSuccess: () => {
      setError(null);
      setCopied(false);
      qc.invalidateQueries({ queryKey: ['calendar-feed', 'settings'] });
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'That setting could not be saved.'),
  });

  const regenerate = useMutation({
    mutationFn: () => api.calendarFeed.regenerate(),
    onSuccess: () => {
      setError(null);
      setCopied(false);
      void qc.invalidateQueries({ queryKey: ['calendar-feed', 'settings'] });
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'A new link could not be created.'),
  });

  const busy = toggle.isPending || regenerate.isPending;

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the URL is on screen to select.
      setError('The link could not be copied automatically. Select it and copy manually.');
    }
  }

  return (
    <AppShell currentPath="/admin/calendar" title="Calendar feed">
      <div className="page-head">
        <div>
          <h2>Calendar feed</h2>
          <p>
            Publish the workshops calendar so staff can subscribe to it from Google Calendar,
            Outlook, or any other calendar app.
          </p>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="panel">
        <div className="panel-body">
          <ul className="notif-kind-list">
            <li className="notif-kind">
              <span className="notif-kind-icon" aria-hidden="true">
                <IconWorkshops width={18} height={18} />
              </span>
              <div className="notif-kind-text">
                <div className="notif-kind-head">
                  <b>Publish the workshop calendar</b>
                  {!isLoading && (
                    <span className={`pill ${enabled ? 'pill-info' : 'pill-muted'}`}>
                      {enabled ? 'On' : 'Off'}
                    </span>
                  )}
                </div>
                <p className="notif-kind-desc">
                  Creates a read-only subscription link covering the past year and the next two.
                  Changes made here appear in the subscriber&apos;s calendar within a few hours.
                  Nothing is ever written back from the calendar.
                </p>
                <div className="notif-kind-meta">
                  <span>
                    {data?.hasLink
                      ? 'A link has been issued.'
                      : 'No link has been issued yet.'}
                  </span>
                  {data?.updatedAt && (
                    <>
                      <span className="muted">·</span>
                      <span>
                        Last changed {new Date(data.updatedAt).toLocaleString()}
                        {data.updatedBy ? ` by ${data.updatedBy}` : ''}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="Workshop calendar feed"
                className={`notif-toggle${enabled ? ' is-on' : ''}`}
                onClick={() => toggle.mutate(!enabled)}
                disabled={isLoading || busy}
              >
                <span className="notif-toggle-knob" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </div>
      </div>

      {enabled && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3 style={{ margin: 0, fontSize: 15 }}>Subscription link</h3>
          </div>
          <div className="panel-body">
            <div className="feed-link-body">
              {url ? (
                <>
                  <p className="notif-kind-desc" style={{ marginTop: 0 }}>
                    In Google Calendar, choose
                    <b> Other calendars → + → From URL</b> and paste it. In Outlook, choose
                    <b> Add calendar → Subscribe from web</b>.
                  </p>
                  <div className="feed-link-row">
                    <input
                      className="feed-link-input"
                      value={url}
                      readOnly
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label="Calendar subscription link"
                    />
                    <button type="button" className="btn btn-primary" onClick={copy}>
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                  </div>
                </>
              ) : data?.hasLink ? (
                <p className="notif-kind-desc" style={{ marginTop: 0 }}>
                  This link was issued before the app could show it again, so only its
                  fingerprint is stored. Issue a new one to get a link you can copy — the old
                  link stops working immediately and existing subscribers must be given the new
                  one.
                </p>
              ) : (
                <p className="notif-kind-desc" style={{ marginTop: 0 }}>
                  No link exists yet. Issue one to start subscribing.
                </p>
              )}

              <div className="feed-link-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => regenerate.mutate()}
                  disabled={busy}
                >
                  {data?.hasLink ? 'Issue a new link' : 'Create link'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
