import { useEffect, useState, type ReactNode } from 'react';
import type { AuthUser } from '@pe/shared';
import { useAuth } from '../auth';
import {
  IconDashboard,
  IconWorkshops,
  IconCatalog,
  IconPresenters,
  IconRegistrations,
  IconPayments,
  IconCreditSlips,
  IconRequests,
  IconFolder,
  IconReports,
  IconCertificate,
  IconSettings,
  IconLogout,
  IconLayoutSidebar,
  IconMenu,
  IconClose,
} from './icons';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';
import { useScrollLock } from '../hooks/useScrollLock';
import { canSeeSettings, isSettingsDestination } from '../settings';

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
      { to: '/certificates', label: 'Certificates', icon: IconCertificate },
      { to: '/reports', label: 'Reports hub', icon: IconReports },
      { to: '/reports/visual', label: 'Visual Reports', icon: IconDashboard },
    ],
  },
];

/**
 * Bottom tab bar on phones â€” only the destinations staff use standing up.
 *
 * Payments takes the middle slot: checking whether someone has paid is the
 * thing staff do most often away from a desk, and the participant list is
 * reachable from every payment anyway.
 */
const MOBILE_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: IconDashboard },
  { to: '/workshops', label: 'Workshops', icon: IconWorkshops },
  { to: '/payments', label: 'Payments', icon: IconPayments },
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

/** Sidebar width preference, remembered across visits. */
const SIDEBAR_KEY = 'pe.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

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
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [navOpen, setNavOpen] = useState(false);

  // Below 1024px the sidebar is replaced by a drawer, opened from the
  // topbar. Lock the page behind it and close it on Escape.
  useScrollLock(navOpen);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch {
      // Private mode or a full quota â€” the preference simply won't persist.
    }
  }, [collapsed]);

  // Keep the document title in sync with the screen.
  useEffect(() => {
    document.title = `${title} · Project Enlightenment, workshop database`;
  }, [title]);

  const isActive = (to: string) =>
    to === '/' ? currentPath === '/' : currentPath === to || currentPath.startsWith(`${to}/`);

  const visibleIn = (items: NavItem[]) =>
    items.filter((i) => !i.roles || (user && i.roles.includes(user.role)));

  return (
    <div
      className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}${navOpen ? ' nav-open' : ''}`}
    >
      <aside className="sidebar" id="app-nav">
        <div className="sidebar-brand">
          <a
            className="mark"
            href="/"
            aria-label="Project Enlightenment home"
            onClick={() => setNavOpen(false)}
          >
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
              <small>Workshop database</small>
            </span>
          </a>
          <button
            type="button"
            className="sidebar-close"
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
          >
            <IconClose width={18} height={18} />
          </button>
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
                    title={collapsed ? item.label : undefined}
                    onClick={() => setNavOpen(false)}
                  >
                    <item.icon />
                    <span className="sidebar-link-label">{item.label}</span>
                  </a>
                ))}
              </div>
            </nav>
          );
        })}
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="btn btn-ghost btn-sm topbar-toggle"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
          >
            <IconLayoutSidebar width={18} height={18} />
          </button>
          {/* Below 1024px the sidebar is a drawer, so the toggle above is
              hidden and this button opens it instead. */}
          <button
            type="button"
            className="btn btn-ghost btn-sm topbar-menu"
            onClick={() => setNavOpen(true)}
            title="Open menu"
            aria-label="Open menu"
            aria-controls="app-nav"
            aria-expanded={navOpen}
          >
            <IconMenu width={20} height={20} />
          </button>
          {/* The sidebar â€” and its sunburst â€” is hidden below 1024px, so the
              mark is repeated here and shown only at that width. */}
          <a className="topbar-brand" href="/" aria-label="Project Enlightenment home">
            <img
              className="topbar-brand-icon"
              src="/images/sunburst-logo.png"
              alt=""
              aria-hidden="true"
              width={30}
              height={26}
            />
          </a>
          <div className="topbar-actions">
            <ThemeToggle />
            {user && <NotificationBell />}
            {user && canSeeSettings(user.role) && (
              <a
                href="/settings"
                className={`topbar-settings${
                  isSettingsDestination(currentPath, user.role) ? ' active' : ''
                }`}
                title="Settings"
                aria-label="Settings"
                aria-current={currentPath === '/settings' ? 'page' : undefined}
              >
                <IconSettings width={20} height={20} />
              </a>
            )}
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

      <div
        className="nav-scrim"
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

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
