import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Notification bell for the topbar.
 *
 * Polls every 60s rather than holding a socket open: notifications are not
 * urgent enough to justify a persistent connection, and a poll keeps the
 * deployed app free of extra infrastructure.
 */
export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.list(20),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const unread = data?.unread ?? 0;
  const items = data?.data ?? [];

  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markOne = useMutation({
    mutationFn: (id: number) => api.notifications.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const archiveOne = useMutation({
    mutationFn: (id: number) => api.notifications.archive(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        type="button"
        className="notif-bell"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="notif-badge" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <span>Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                className="notif-markall"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
              >
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <div className="notif-empty">Nothing yet.</div>
          ) : (
            <ul className="notif-list">
              {items.map((n) => (
                <li key={n.NotificationID} className={n.IsRead ? 'is-read' : ''}>
                  <div className="notif-row">
                    <a
                      className="notif-item"
                      href={n.LinkPath ?? '#'}
                      onClick={(e) => {
                        if (!n.IsRead) markOne.mutate(n.NotificationID);
                        if (!n.LinkPath) e.preventDefault();
                        setOpen(false);
                      }}
                    >
                      <span className="notif-title">{n.Title}</span>
                      {n.Body && <span className="notif-body">{n.Body}</span>}
                      <span className="notif-time">{relative(n.CreatedAt)}</span>
                    </a>
                    <button
                      type="button"
                      className="notif-archive"
                      title="Archive"
                      aria-label={`Archive: ${n.Title}`}
                      onClick={() => archiveOne.mutate(n.NotificationID)}
                      disabled={archiveOne.isPending}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="3" y="4" width="18" height="4" rx="1" />
                        <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
                        <path d="M10 12h4" />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <a className="notif-viewall" href="/notifications" onClick={() => setOpen(false)}>
            View all notifications
            {typeof data?.total === 'number' && data.total > items.length && (
              <span className="notif-viewall-count">{data.total}</span>
            )}
          </a>
        </div>
      )}
    </div>
  );
}
