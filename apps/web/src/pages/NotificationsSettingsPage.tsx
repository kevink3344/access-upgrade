import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { IconBell, IconMail, IconSchoolCash, IconWorkshops } from '../components/icons';

/**
 * Notifications — the home for everything the system tells staff about.
 *
 * This is a settings screen, not an inbox: the inbox is the bell and the
 * Notifications page. What belongs here is the *catalogue* — which events
 * raise a notification, who receives them, and how they are delivered — so
 * that when more kinds are added there is one place that describes them all.
 *
 * The kinds are declared in the API rather than stored, because a kind only
 * exists when some code produces it. This page reports that list; it does not
 * configure it.
 */

const KIND_ICONS: Record<string, (p: { width?: number; height?: number }) => ReactNode> = {
  'school-cash-applied': IconSchoolCash,
  'workshop-capacity': IconWorkshops,
};

export function NotificationsSettingsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['notifications', 'catalogue'],
    queryFn: () => api.notifications.catalogue(),
    staleTime: 60_000,
  });

  const kinds = data?.kinds ?? [];
  const channels = data?.channels ?? [];
  const stats = data?.stats;

  return (
    <AppShell currentPath="/admin" title="Notifications">
      <div className="page-head">
        <div>
          <h2>Notifications</h2>
          <p>
            What the system tells staff about, who receives it, and how it is delivered.
          </p>
        </div>
        <div className="row-actions">
          <a className="btn btn-ghost" href="/notifications">
            Open my notifications
          </a>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load the notification catalogue.
            {error instanceof Error ? ` ${error.message}` : ''}
          </span>
        </div>
      )}

      {stats && (
        <div className="notif-stats">
          <div className="notif-stat">
            <span className="notif-stat-value">{stats.total.toLocaleString()}</span>
            <span className="notif-stat-label">Sent all time</span>
          </div>
          <div className="notif-stat">
            <span className="notif-stat-value">{stats.last7Days.toLocaleString()}</span>
            <span className="notif-stat-label">In the last 7 days</span>
          </div>
          <div className="notif-stat">
            <span className="notif-stat-value">{stats.unreadForMe.toLocaleString()}</span>
            <span className="notif-stat-label">Unread for you</span>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3 style={{ margin: 0, fontSize: 15 }}>Notification types</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {kinds.length} type{kinds.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="panel-body">
          {isLoading ? (
            <div style={{ padding: 8 }}>
              {[0, 1].map((i) => (
                <div key={i} className="skeleton" style={{ height: 64, marginBottom: 8 }} />
              ))}
            </div>
          ) : kinds.length === 0 ? (
            <div className="empty">
              <IconBell width={28} height={28} />
              <p style={{ marginTop: 10 }}>No notification types are configured.</p>
            </div>
          ) : (
            <ul className="notif-kind-list">
              {kinds.map((k) => {
                const Icon = KIND_ICONS[k.kind] ?? IconBell;
                return (
                  <li key={k.kind} className="notif-kind">
                    <span className="notif-kind-icon" aria-hidden="true">
                      <Icon width={18} height={18} />
                    </span>
                    <div className="notif-kind-text">
                      <div className="notif-kind-head">
                        <b>{k.label}</b>
                        <span className={`pill ${k.active ? 'pill-open' : 'pill-muted'}`}>
                          {k.active ? 'Active' : 'Planned'}
                        </span>
                      </div>
                      <p className="notif-kind-desc">{k.description}</p>
                      <div className="notif-kind-meta">
                        <span>To: {k.audience}</span>
                        <span className="muted">·</span>
                        <code>{k.kind}</code>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 style={{ margin: 0, fontSize: 15 }}>Delivery</h3>
        </div>
        <div className="panel-body">
          <ul className="notif-kind-list">
            {channels.map((c) => {
              const Icon = c.key === 'email' ? IconMail : IconBell;
              return (
                <li key={c.key} className="notif-kind">
                  <span className="notif-kind-icon" aria-hidden="true">
                    <Icon width={18} height={18} />
                  </span>
                  <div className="notif-kind-text">
                    <div className="notif-kind-head">
                      <b>{c.label}</b>
                      <span className={`pill ${c.enabled ? 'pill-open' : 'pill-muted'}`}>
                        {c.enabled ? 'On' : 'Off'}
                      </span>
                    </div>
                    <p className="notif-kind-desc">{c.description}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </AppShell>
  );
}
