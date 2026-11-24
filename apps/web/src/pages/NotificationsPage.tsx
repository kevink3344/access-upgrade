import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationView } from '@pe/shared';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { IconBell, IconMailOpen, IconMailUnread } from '../components/icons';

const PAGE_SIZE = 25;

const VIEWS: { key: NotificationView; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'archived', label: 'Archive' },
];

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Full notification history for the signed-in user.
 *
 * The bell popover only ever shows the newest handful; this page is where
 * staff catch up, filter to unread, and archive what they have dealt with.
 * Archiving is per-user and reversible — it hides a row from All and Unread
 * but keeps it under Archive.
 */
export function NotificationsPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<NotificationView>('all');
  const [page, setPage] = useState(0);

  // Switching views changes the result set, so paging restarts.
  useEffect(() => {
    setPage(0);
  }, [view]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['notifications', 'page', view, page],
    queryFn: () => api.notifications.list(PAGE_SIZE, { offset: page * PAGE_SIZE, view }),
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const unread = data?.unread ?? 0;
  const archived = data?.archived ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });

  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: invalidate,
  });

  const archiveAll = useMutation({
    mutationFn: () => api.notifications.archiveAll(),
    onSuccess: invalidate,
  });

  const markOne = useMutation({
    mutationFn: (id: number) => api.notifications.markRead(id),
    onSuccess: invalidate,
  });

  const markUnreadOne = useMutation({
    mutationFn: (id: number) => api.notifications.markUnread(id),
    onSuccess: invalidate,
  });

  const archiveOne = useMutation({
    mutationFn: (id: number) => api.notifications.archive(id),
    onSuccess: invalidate,
  });

  const unarchiveOne = useMutation({
    mutationFn: (id: number) => api.notifications.unarchive(id),
    onSuccess: invalidate,
  });

  const isArchivedView = view === 'archived';

  return (
    <AppShell currentPath="/notifications" title="Notifications">
      <div className="page-head">
        <div>
          <h2>Notifications</h2>
          <p>
            {unread > 0 ? `${unread} unread · ` : 'All caught up · '}
            {archived} archived.
          </p>
        </div>
        <div className="row-actions">
          {unread > 0 && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
            >
              Mark all read
            </button>
          )}
          {!isArchivedView && total > 0 && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => archiveAll.mutate()}
              disabled={archiveAll.isPending}
            >
              Archive all
            </button>
          )}
        </div>
      </div>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter notifications">
          {VIEWS.map((v) => {
            const n = v.key === 'unread' ? unread : v.key === 'archived' ? archived : 0;
            return (
              <button
                key={v.key}
                type="button"
                className={view === v.key ? 'is-active' : ''}
                aria-pressed={view === v.key}
                onClick={() => setView(v.key)}
              >
                {v.label}
                {n > 0 ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>Could not load notifications. {(error as Error).message}</span>
        </div>
      )}

      <div className="panel">
        <div className="panel-body">
          {isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton" style={{ height: 52, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <IconBell width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {view === 'unread'
                  ? 'No unread notifications.'
                  : view === 'archived'
                    ? 'Nothing archived.'
                    : 'No notifications yet.'}
              </p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 460, margin: '8px auto 0' }}>
                {view === 'archived'
                  ? 'Notifications you archive land here. Restore one to put it back in All.'
                  : 'Capacity alerts for workshops appear here once a workshop passes the threshold set on its Notifications tab.'}
              </p>
            </div>
          ) : (
            <ul className="notif-page-list">
              {rows.map((n) => (
                <li key={n.NotificationID} className={n.IsRead ? 'is-read' : ''}>
                  <span className="notif-page-dot" aria-hidden="true" />
                  <div className="notif-page-main">
                    {n.LinkPath ? (
                      <a
                        className="notif-page-title"
                        href={n.LinkPath}
                        onClick={() => {
                          if (!n.IsRead) markOne.mutate(n.NotificationID);
                        }}
                      >
                        {n.Title}
                      </a>
                    ) : (
                      <span className="notif-page-title">{n.Title}</span>
                    )}
                    {n.Body && <p className="notif-page-body">{n.Body}</p>}
                    <span className="notif-page-meta">
                      {when(n.CreatedAt)}
                      {!n.IsRead && <span className="pill pill-info">Unread</span>}
                      {n.IsArchived && <span className="pill pill-muted">Archived</span>}
                    </span>
                  </div>
                  <div className="row-actions">
                    {/* One icon that toggles, rather than two buttons that
                        are each hidden half the time — the row keeps the same
                        shape whether it is read or not. */}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon"
                      onClick={() =>
                        n.IsRead
                          ? markUnreadOne.mutate(n.NotificationID)
                          : markOne.mutate(n.NotificationID)
                      }
                      disabled={markOne.isPending || markUnreadOne.isPending}
                      title={n.IsRead ? 'Mark as unread' : 'Mark as read'}
                      aria-label={n.IsRead ? 'Mark as unread' : 'Mark as read'}
                    >
                      {n.IsRead ? (
                        <IconMailUnread width={16} height={16} />
                      ) : (
                        <IconMailOpen width={16} height={16} />
                      )}
                    </button>
                    {n.IsArchived ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => unarchiveOne.mutate(n.NotificationID)}
                        disabled={unarchiveOne.isPending}
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => archiveOne.mutate(n.NotificationID)}
                        disabled={archiveOne.isPending}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {pageCount > 1 && (
        <div className="pager">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </button>
          <span className="pager-label">
            Page {page + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </AppShell>
  );
}
