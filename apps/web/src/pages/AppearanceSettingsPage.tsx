import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginTheme } from '@pe/shared';
import { api, HttpError } from '../api';
import { AppShell } from '../components/AppShell';

/**
 * Settings > Administration > Appearance.
 *
 * The login screen's left-hand panel is the first thing anyone sees, and it
 * is the same for everybody — so this is an admin choice, not a personal
 * preference. Each option is previewed in the exact colours the login page
 * uses, because a swatch alone would not tell you whether the text still
 * reads on it.
 */

const THEMES: { value: LoginTheme; label: string; description: string }[] = [
  { value: 'blue', label: 'WCPSS blue', description: 'The default. Deep blue gradient with the orange glow.' },
  { value: 'classroom', label: 'Classroom', description: 'Warm sand tones — the most "school" of the set.' },
  { value: 'garden', label: 'Garden', description: 'Soft greens, calm and outdoors.' },
  { value: 'night', label: 'Night', description: 'Deep slate, for staff who prefer a dark panel.' },
  { value: 'paper', label: 'Paper', description: 'A plain light panel with no tint — the quietest option.' },
];

export function AppearanceSettingsPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'appearance'],
    queryFn: () => api.admin.appearance(),
  });

  const save = useMutation({
    mutationFn: (loginTheme: LoginTheme) => api.admin.setLoginTheme(loginTheme),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'appearance'] });
      // The login page reads /health/config, so refresh that too.
      void qc.invalidateQueries({ queryKey: ['config'] });
    },
    onError: () => {},
  });

  const current = data?.loginTheme ?? 'blue';

  return (
    <AppShell currentPath="/admin/appearance" title="Appearance">
      <div className="page-head">
        <div>
          <h2>Appearance</h2>
          <p>
            How the app looks to everyone. Changes apply immediately to the login screen, for
            every visitor.
          </p>
        </div>
      </div>

      {save.isError && (
        <div className="alert alert-error" role="alert">
          <span>
            {save.error instanceof HttpError ? save.error.message : 'Could not save the choice.'}
          </span>
        </div>
      )}
      {save.isSuccess && (
        <div className="alert alert-info" role="status">
          <span>Saved. The login screen now uses {THEMES.find((t) => t.value === current)?.label}.</span>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3 style={{ margin: 0, fontSize: 15 }}>Login screen panel</h3>
        </div>
        <div className="panel-body panel-body-padded">
          {isLoading ? (
            <div className="skeleton" style={{ height: 180 }} />
          ) : (
            <div className="theme-grid" role="radiogroup" aria-label="Login screen panel">
              {THEMES.map((t) => {
                const selected = current === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`theme-option${selected ? ' is-selected' : ''}`}
                    onClick={() => save.mutate(t.value)}
                    disabled={save.isPending}
                  >
                    {/* The same classes the login page uses, so the preview
                        cannot drift from the real thing. */}
                    <span className={`theme-preview login-brand theme-${t.value}`} aria-hidden="true">
                      <span className="theme-preview-title">Project Enlightenment</span>
                      <span className="theme-preview-sub">Workshop database</span>
                    </span>
                    <span className="theme-option-text">
                      <b>{t.label}</b>
                      <small>{t.description}</small>
                    </span>
                    {selected && <span className="pill pill-open">Current</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
