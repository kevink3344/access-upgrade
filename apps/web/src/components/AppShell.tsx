import { useEffect, type ReactNode } from 'react';
import type { AuthUser } from '@pe/shared';
import { useAuth } from '../auth';
import {
  IconDashboard,
  IconWorkshops,
  IconCatalog,
  IconParticipants,
  IconAgencies,
  IconPresenters,
  IconRegistrations,
  IconPayments,
  IconCreditSlips,
  IconRequests,
  IconFolder,
  IconApproval,
  IconReports,
  IconMail,
  IconUsers,
  IconUtilities,
  IconApi,
  IconAdmin,
  IconCertificate,
  IconWebhook,
  IconLogout,
} from './icons';
import { NotificationBell } from './NotificationBell';

interface NavItem {
  to: string;
  label: string;
  icon: (p: { width?: number; height?: number }) => ReactNode;
  roles?: AuthUser['role'][];
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * Full navigation, mirroring the Access switchboard (plan §7.1) so staff
 * recognise where things live. Grouped rather than flat because there are
 * now 16 destinations.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: IconDashboard }],
  },
  {
    title: 'Data',
    items: [
      { to: '/workshops', label: 'Workshops', icon: IconWorkshops },
      { to: '/workshop-names', label: 'Workshop catalog', icon: IconCatalog },
      { to: '/participants', label: 'Participants', icon: IconParticipants },
      { to: '/agencies', label: 'Agencies', icon: IconAgencies },
      { to: '/presenters', label: 'Presenters & staff', icon: IconPresenters },
      { to: '/registrations', label: 'Registrations', icon: IconRegistrations },
      { to: '/payments', label: 'Payments & receipts', icon: IconPayments },
      { to: '/credit-slips', label: 'Credit slips', icon: IconCreditSlips },
      { to: '/training-requests', label: 'Training requests', icon: IconRequests },
    ],
  },
  {
    title: 'Reports',
    items: [
      { to: '/folders', label: 'Folder builder', icon: IconFolder },
      { to: '/workshops/approval', label: 'Workshop approval', icon: IconApproval },
      { to: '/certificates', label: 'Certificates', icon: IconCertificate },
      { to: '/reports', label: 'Reports hub', icon: IconReports },
      { to: '/mailing-lists', label: 'Mailing lists', icon: IconMail },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/admin/users', label: 'Users', icon: IconUsers, roles: ['SUPER_ADMIN', 'ADMIN'] },
      {
        to: '/admin/forms',
        label: 'Form Designer',
        icon: IconRequests,
        roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'],
      },
      { to: '/admin/utilities', label: 'Utilities', icon: IconUtilities, roles: ['SUPER_ADMIN', 'ADMIN'] },
      { to: '/admin', label: 'Admin', icon: IconAdmin, roles: ['SUPER_ADMIN', 'ADMIN'] },
    ],
  },
  {
    title: 'Developer',
    items: [
      { to: '/api-docs', label: 'API documentation', icon: IconApi, roles: ['SUPER_ADMIN', 'ADMIN'] },
      { to: '/admin/webhooks', label: 'Webhooks', icon: IconWebhook, roles: ['SUPER_ADMIN', 'ADMIN'] },
    ],
  },
];

/** Bottom tab bar on phones — only the destinations staff use standing up. */
const MOBILE_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: IconDashboard },
  { to: '/workshops', label: 'Workshops', icon: IconWorkshops },
  { to: '/participants', label: 'People', icon: IconParticipants },
  { to: '/registrations', label: 'Register', icon: IconRegistrations },
  { to: '/reports', label: 'Reports', icon: IconReports },
];

const ROLE_LABEL: Record<AuthUser['role'], string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Administrator',
  MANAGER: 'Manager',
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function AppShell({
  currentPath,
  title,
  children,
}: {
  currentPath: string;
  title: string;
  children: ReactNode;
}) {
  const { user, signOut } = useAuth();

  // Keep the document title in sync with the screen.
  useEffect(() => {
    document.title = `${title} · Project Enlightenment`;
  }, [title]);

  const isActive = (to: string) =>
    to === '/' ? currentPath === '/' : currentPath === to || currentPath.startsWith(`${to}/`);

  const visibleIn = (items: NavItem[]) =>
    items.filter((i) => !i.roles || (user && i.roles.includes(user.role)));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <a className="mark" href="/">
            <img
              className="mark-icon"
              src="/images/sunburst-logo.png"
              alt=""
              aria-hidden="true"
              width={34}
              height={30}
            />
            <span className="mark-text">
              <b>Project Enlightenment</b>
              <small>Training Database</small>
            </span>
          </a>
        </div>

        {NAV_GROUPS.map((group) => {
          const items = visibleIn(group.items);
          if (items.length === 0) return null;

          return (
            <nav
              key={group.title}
              className="sidebar-section"
              aria-label={group.title}
            >
              <div className="sidebar-section-title">{group.title}</div>
              <div className="sidebar-nav">
                {items.map((item) => (
                  <a
                    key={item.to}
                    href={item.to}
                    className={`sidebar-link${isActive(item.to) ? ' active' : ''}`}
                    aria-current={isActive(item.to) ? 'page' : undefined}
                  >
                    <item.icon />
                    {item.label}
                  </a>
                ))}
              </div>
            </nav>
          );
        })}
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="topbar-actions">
            {user && <NotificationBell />}
            {user && (
              <div className="user-chip topbar-user">
                <span className="avatar" aria-hidden="true">{initials(user.displayName)}</span>
                <span className="meta">
                  <b title={user.email}>{user.displayName}</b>
                  <small>{ROLE_LABEL[user.role]}</small>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void signOut()}
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <IconLogout width={14} height={14} />
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="content" id="main">
          {children}
        </main>
      </div>

      <nav className="mobile-tabs" aria-label="Main">
        {visibleIn(MOBILE_NAV).map((item) => (
          <a
            key={item.to}
            href={item.to}
            className={isActive(item.to) ? 'active' : ''}
            aria-current={isActive(item.to) ? 'page' : undefined}
          >
            <item.icon width={20} height={20} />
            {item.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
