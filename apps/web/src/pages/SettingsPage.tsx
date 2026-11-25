import { AppShell } from '../components/AppShell';
import { useAuth } from '../auth';
import { settingsGroupsFor } from '../settings';
import { IconAdmin } from '../components/icons';

/**
 * Settings — the home for the old Administration and Developer sidebar groups.
 * Cards are filtered by role, so a manager sees only the designers.
 */
export function SettingsPage() {
  const { user } = useAuth();
  const groups = settingsGroupsFor(user?.role);

  return (
    <AppShell currentPath="/settings" title="Settings">
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p>Administration and developer tools for this workspace.</p>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="panel">
          <div className="panel-body">
            <div className="empty">
              <p style={{ margin: 0 }}>Your role doesn't have access to any settings.</p>
            </div>
          </div>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.title} className="settings-group" aria-labelledby={`settings-${group.title}`}>
            <h3 className="settings-group-title" id={`settings-${group.title}`}>
              {group.title}
            </h3>
            <div className="settings-grid">
              {group.items.map((item) => (
                <a key={item.to} className="settings-card" href={item.to}>
                  <span className="settings-card-icon" aria-hidden="true">
                    <item.icon width={20} height={20} />
                  </span>
                  <span className="settings-card-text">
                    <b>{item.label}</b>
                    <small>{item.description}</small>
                  </span>
                </a>
              ))}
            </div>
          </section>
        ))
      )}
    </AppShell>
  );
}

/** Shown when a role reaches /settings without any permitted destinations. */
export function SettingsUnavailable() {
  return (
    <AppShell currentPath="/settings" title="Settings">
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p>This screen is not available for your role.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-body">
          <div className="empty">
            <p style={{ margin: 0 }}>
              <IconAdmin width={16} height={16} /> Settings is limited to administrators.
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
