import { useEffect, useState, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@pe/shared/tokens.css';
import './styles/layout.css';
import './styles/login.css';
import './styles/dashboard.css';
import './styles/ui.css';
import './styles/public.css';

import { AuthProvider, useAuth } from './auth';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { WorkshopsPage } from './pages/WorkshopsPage';
import { RegistrationsPage } from './pages/RegistrationsPage';
import { ParticipantsPage } from './pages/ParticipantsPage';
import { AgenciesPage } from './pages/AgenciesPage';
import { PresentersPage } from './pages/PresentersPage';
import { WorkshopNamesPage } from './pages/WorkshopNamesPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { TrainingRequestsPage } from './pages/TrainingRequestsPage';
import { CreditSlipsPage } from './pages/CreditSlipsPage';
import { SchoolCashPage } from './pages/SchoolCashPage';
import { CertificateDesignerPage } from './pages/CertificateDesignerPage';
import { CertificatesPage } from './pages/CertificatesPage';
import { ReportsPage } from './pages/ReportsPage';
import { FolderBuilderPage } from './pages/FolderBuilderPage';

/**
 * Recharts is ~500 KB of the bundle, and only this one screen uses it. Loading
 * it lazily keeps the Reports hub's first paint where it was.
 */
const VisualReportsPage = lazy(() =>
  import('./pages/VisualReportsPage').then((m) => ({ default: m.VisualReportsPage })),
);

import { WebhooksPage } from './pages/WebhooksPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { NotificationsSettingsPage } from './pages/NotificationsSettingsPage';
import { CalendarFeedSettingsPage } from './pages/CalendarFeedSettingsPage';
import { FormsPage } from './pages/FormsPage';
import { FormEditorPage } from './pages/FormEditorPage';
import { UtilitiesPage } from './pages/UtilitiesPage';
import { StatusPage } from './pages/StatusPage';
import { ApiDocsPage } from './pages/ApiDocsPage';
import { SettingsPage, SettingsUnavailable } from './pages/SettingsPage';
import { DropdownListsPage } from './pages/DropdownListsPage';
import { PublicRegisterPage } from './pages/PublicRegisterPage';
import { FormPreviewPage } from './pages/FormPreviewPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { canSeeSettings } from './settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

/**
 * Client-side redirect. Replaces the history entry rather than pushing one,
 * so the browser's Back button does not bounce between the old path and this.
 */
function Redirect({ to, search = '' }: { to: string; search?: string }) {
  useEffect(() => {
    window.history.replaceState({}, '', `${to}${search}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [to, search]);

  return null;
}

/** Minimal router — swap for TanStack Router once there are more screens. */
function usePathname(): string {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);

    // Intercept same-origin link clicks for client-side navigation.
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || !href.startsWith('/') || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      // Keep the query string — pages read it for deep links (?edit=, ?status=).
      window.history.pushState({}, '', href);
      setPath(window.location.pathname);
      // Let the target page see the new query string.
      window.dispatchEvent(new PopStateEvent('popstate'));
    };
    document.addEventListener('click', onClick);

    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onClick);
    };
  }, []);

  return path;
}

const ROUTES: Record<string, string> = {
  '/workshops': 'Workshops',
  '/workshop-names': 'Workshop catalog',
  '/admin/participants': 'Participants',
  '/admin/agencies': 'Agencies',
  '/presenters': 'Presenters & staff',
  '/registrations': 'Registrations',
  '/payments': 'Payments & receipts',
  '/certificates': 'Certificates',
  '/credit-slips': 'Credit slips',
  '/school-cash': 'School Cash matching',
  '/training-requests': 'Training requests',
  '/folders': 'Folder builder',
  '/reports': 'Reports hub',
  '/admin': 'Notifications',
  '/admin/users': 'Users',
  '/admin/utilities': 'Utilities',
  '/admin/status': 'Status',
  '/settings/dropdown-lists': 'Dropdown lists',
  '/api-docs': 'API documentation',
  '/admin/webhooks': 'Webhooks',
  '/admin/forms': 'Form Designer',
  '/settings': 'Settings',
  '/notifications': 'Notifications',
};

function Router() {
  const { user, loading } = useAuth();
  const path = usePathname();

  // Public surface — checked before auth so it never renders staff chrome
  // and never requires a session.
  const publicMatch = /^\/register\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (publicMatch) {
    return <PublicRegisterPage slug={publicMatch[1]!} />;
  }

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <p style={{ color: 'var(--text-faint)', fontSize: 14 }}>Loading…</p>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  if (path === '/') return <DashboardPage />;

  if (path === '/workshops') return <WorkshopsPage />;

  if (path === '/registrations') return <RegistrationsPage />;

  // Participants and agencies now live in Settings > Administration. The old
  // paths are kept as redirects so bookmarks and links keep working.
  if (path === '/participants') {
    return <Redirect to="/admin/participants" search={window.location.search} />;
  }
  if (path === '/agencies') {
    return <Redirect to="/admin/agencies" search={window.location.search} />;
  }

  if (path === '/admin/participants') return <ParticipantsPage />;

  if (path === '/admin/agencies') return <AgenciesPage />;

  if (path === '/presenters') return <PresentersPage />;

  if (path === '/workshop-names') return <WorkshopNamesPage />;

  if (path === '/payments') return <PaymentsPage />;
  if (path === '/training-requests') return <TrainingRequestsPage />;
  if (path === '/credit-slips') return <CreditSlipsPage />;
  if (path === '/school-cash') return <SchoolCashPage />;
  if (path === '/certificates') return <CertificatesPage />;
  if (path === '/folders') return <FolderBuilderPage />;
  if (path === '/reports') return <ReportsPage />;
  if (path === '/reports/visual') {
    return (
      <Suspense
        fallback={
          <div style={{ padding: 28 }}>
            <div className="skeleton" style={{ height: 320 }} />
          </div>
        }
      >
        <VisualReportsPage />
      </Suspense>
    );
  }

  if (path === '/notifications') return <NotificationsPage />;

  if (path === '/settings') {
    return canSeeSettings(user.role) ? <SettingsPage /> : <SettingsUnavailable />;
  }

  if (path === '/admin') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <NotificationsSettingsPage />;
  }

  if (path === '/admin/calendar') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <CalendarFeedSettingsPage />;
  }

  if (path === '/admin/users') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <UsersPage />;
  }

  if (path === '/api-docs') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <ApiDocsPage />;
  }

  if (path === '/admin/webhooks') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <WebhooksPage />;
  }

  if (path === '/admin/utilities') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <UtilitiesPage />;
  }

  if (path === '/admin/status') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <StatusPage />;
  }

  if (path === '/settings/dropdown-lists') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <DropdownListsPage />;
  }

  if (path === '/admin/forms') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN' && user.role !== 'MANAGER') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <FormsPage />;
  }

  if (path === '/admin/certificates') {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN' && user.role !== 'MANAGER') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <CertificateDesignerPage />;
  }

  const formEditorMatch = /^\/admin\/forms\/(\d+)\/?$/.exec(path);
  if (formEditorMatch) {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN' && user.role !== 'MANAGER') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    return <FormEditorPage formTemplateId={Number(formEditorMatch[1])} />;
  }

  // Staff preview of the public page. Its own tab, so the editor keeps its
  // unsaved state; the bar above the page says it is not the live form.
  const formPreviewMatch = /^\/admin\/forms\/(\d+)\/preview\/?$/.exec(path);
  if (formPreviewMatch) {
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN' && user.role !== 'MANAGER') {
      return <PlaceholderPage path={path} title="Not available" />;
    }
    const requested = new URLSearchParams(window.location.search).get('version');
    const versionId = requested !== null && /^\d+$/.test(requested) ? Number(requested) : null;
    return (
      <FormPreviewPage
        formTemplateId={Number(formPreviewMatch[1])}
        versionId={versionId}
      />
    );
  }

  const title = ROUTES[path];
  if (title) return <PlaceholderPage path={path} title={title} />;

  return <PlaceholderPage path={path} title="Not found" />;
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <ErrorBoundary>
        <Router />
      </ErrorBoundary>
    </AuthProvider>
  </QueryClientProvider>,
);
