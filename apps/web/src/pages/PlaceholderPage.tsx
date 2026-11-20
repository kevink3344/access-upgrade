import { AppShell } from '../components/AppShell';

/**
 * Placeholder for screens not yet built. Keeps navigation honest —
 * clicking a link never lands on a blank page.
 */
export function PlaceholderPage({ path, title }: { path: string; title: string }) {
  return (
    <AppShell currentPath={path} title={title}>
      <div className="page-head">
        <div>
          <h2>{title}</h2>
          <p>This screen is next in the build.</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-body">
          <div className="empty">
            <p style={{ marginBottom: 6 }}>
              <strong>{title}</strong> is not built yet.
            </p>
            <p style={{ margin: 0 }}>
              The API and database are ready — this screen is scheduled for Phase 2.
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
