import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { LoginTheme } from '@pe/shared';
import { useAuth } from '../auth';
import { api, HttpError } from '../api';
import { IconAlert } from '../components/icons';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type Errors = Partial<Record<'email' | 'password', string>>;

export function LoginPage() {
  const { signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<string | null>(null);
  const [theme, setTheme] = useState<LoginTheme>('blue');

  // Deployment badge ("TEST SITE") and the panel theme. Fetched before login
  // because both are for people who have not signed in yet. A failure here
  // must never block signing in, so errors are swallowed and the default
  // blue panel is used.
  useEffect(() => {
    let cancelled = false;
    api
      .config()
      .then((c) => {
        if (cancelled) return;
        setMode(c.mode);
        if (c.loginTheme) setTheme(c.loginTheme);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = schema.safeParse({ email, password });

    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof Errors;
        if (!next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    setSubmitting(true);

    try {
      await signIn(parsed.data.email, parsed.data.password, rememberMe);
    } catch (err) {
      if (err instanceof HttpError) {
        setFormError(
          err.status === 401
            ? 'Email or password is incorrect.'
            : err.status === 423
              ? 'Too many failed attempts. Try again in 15 minutes.'
              : err.message,
        );
      } else {
        setFormError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <section className={`login-brand theme-${theme}`} aria-hidden="true">
        <div className="login-brand-inner">
          <div className="login-badges">
            <span className="login-kicker">Wake County Public School System</span>
            {mode && <span className="login-mode-badge">{mode}</span>}
          </div>
          <h1>
            Project Enlightenment
            <span className="login-brand-subtitle">Workshop database</span>
          </h1>
          <p>
            Workshop scheduling, participant records, registrations, payments and
            certificates — in one place.
          </p>
          <div className="stats">
            <div className="stat">
              <b>2,599</b>
              <span>Workshops</span>
            </div>
            <div className="stat">
              <b>14,403</b>
              <span>Participants</span>
            </div>
            <div className="stat">
              <b>41,341</b>
              <span>Registrations</span>
            </div>
          </div>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <h2>Sign in</h2>
          <p className="sub">Use your Project Enlightenment account.</p>

          {formError && (
            <div className="alert alert-error" role="alert">
              <IconAlert width={18} height={18} />
              <span>{formError}</span>
            </div>
          )}

          <form onSubmit={onSubmit} noValidate>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={errors.email ? 'true' : undefined}
                aria-describedby={errors.email ? 'email-error' : undefined}
                disabled={submitting}
              />
              {errors.email && (
                <span className="error" id="email-error" role="alert">
                  {errors.email}
                </span>
              )}
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={errors.password ? 'true' : undefined}
                aria-describedby={errors.password ? 'password-error' : undefined}
                disabled={submitting}
              />
              {errors.password && (
                <span className="error" id="password-error" role="alert">
                  {errors.password}
                </span>
              )}
            </div>

            <div className="remember-row">
              <label className="checkbox remember-label" htmlFor="remember-me">
                <input
                  id="remember-me"
                  name="rememberMe"
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  disabled={submitting}
                />
                <span>Remember me</span>
              </label>
            </div>

            <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="sub" style={{ marginTop: 22, fontSize: 12.5 }}>
            Trouble signing in? Contact your administrator.
          </p>
        </div>
      </section>
    </div>
  );
}
