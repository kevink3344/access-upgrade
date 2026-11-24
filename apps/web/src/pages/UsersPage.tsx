import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { AuthUser, UserRole } from '@pe/shared';
import { api, HttpError } from '../api';
import { useAuth } from '../auth';
import { useScrollLock } from '../hooks/useScrollLock';
import { AppShell } from '../components/AppShell';
import { IconAlert, IconUsers } from '../components/icons';

const ROLE_LABEL: Record<UserRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Administrator',
  MANAGER: 'Manager',
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
};

const ROLE_HELP: Record<UserRole, string> = {
  SUPER_ADMIN: 'Full control, including other administrators',
  ADMIN: 'Manage users and run utilities',
  MANAGER: 'Approve workshops, run folders and mailing lists',
  EDITOR: 'Create and edit records',
  VIEWER: 'Read-only access',
};

const ROLES = Object.keys(ROLE_LABEL) as UserRole[];

const createSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  displayName: z.string().min(1, 'Name is required').max(150),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR', 'VIEWER']),
});

const editSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  displayName: z.string().min(1, 'Name is required').max(150),
  password: z.string().min(6, 'Password must be at least 6 characters').or(z.literal('')),
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR', 'VIEWER']),
});

type FieldErrors = Partial<Record<'email' | 'displayName' | 'password' | 'role', string>>;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/* ------------------------------------------------------------------ */
/*  Drawer                                                             */
/* ------------------------------------------------------------------ */

function UserDrawer({
  user,
  onClose,
  onSaved,
}: {
  user: AuthUser | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = user !== null;
  const { user: currentUser } = useAuth();

  useScrollLock();

  const [email, setEmail] = useState(user?.email ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>(user?.role ?? 'VIEWER');
  const [receivesAdminEmail, setReceivesAdminEmail] = useState(user?.receivesAdminEmail ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: async () => {
      const parsed = (isEdit ? editSchema : createSchema).safeParse({
        email,
        displayName,
        password,
        role,
      });

      if (!parsed.success) {
        const next: FieldErrors = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path[0] as keyof FieldErrors;
          if (!next[key]) next[key] = issue.message;
        }
        setErrors(next);
        throw new Error('validation');
      }

      setErrors({});

      if (isEdit) {
        const body: Record<string, unknown> = {
          email: parsed.data.email,
          displayName: parsed.data.displayName,
          role: parsed.data.role,
          receivesAdminEmail,
        };
        if (parsed.data.password) body.password = parsed.data.password;
        return api.users.update(user.userId, body);
      }

      return api.users.create({
        email: parsed.data.email,
        displayName: parsed.data.displayName,
        password: parsed.data.password,
        role: parsed.data.role,
      });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => {
      if (err instanceof HttpError) {
        setFormError(
          err.status === 409
            ? 'A user with that email already exists.'
            : err.message,
        );
      } else if (err.message !== 'validation') {
        setFormError('Could not save. Please try again.');
      }
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    save.mutate();
  }

  const editingSelf = isEdit && user.userId === currentUser?.userId;

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer-head">
          <h2 id="drawer-title">{isEdit ? 'Edit user' : 'Add user'}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <form className="drawer-body" onSubmit={onSubmit} noValidate>
          {formError && (
            <div className="alert alert-error" role="alert">
              <IconAlert width={18} height={18} />
              <span>{formError}</span>
            </div>
          )}

          <div className="field">
            <label htmlFor="u-name">Full name</label>
            <input
              id="u-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
              aria-invalid={errors.displayName ? 'true' : undefined}
              autoFocus
            />
            {errors.displayName && <span className="error" role="alert">{errors.displayName}</span>}
          </div>

          <div className="field">
            <label htmlFor="u-email">Email</label>
            <input
              id="u-email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              aria-invalid={errors.email ? 'true' : undefined}
            />
            {errors.email && <span className="error" role="alert">{errors.email}</span>}
          </div>

          <div className="field">
            <label htmlFor="u-password">
              Password {isEdit && <span className="field-hint">(leave blank to keep current)</span>}
            </label>
            <input
              id="u-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              aria-invalid={errors.password ? 'true' : undefined}
            />
            {errors.password && <span className="error" role="alert">{errors.password}</span>}
          </div>

          <div className="field">
            <label htmlFor="u-role">Role</label>
            <select
              id="u-role"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              disabled={editingSelf}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <span className="field-hint">{ROLE_HELP[role]}</span>
            {editingSelf && (
              <span className="field-hint">You cannot change your own role.</span>
            )}
          </div>

          {/* Only admins receive these emails, so the switch is shown only for
              roles that would get them. The label is deliberately generic:
              more notification types are expected, and a label naming one of
              them would need renaming each time. The in-app bell is separate
              and always on, which the hint says plainly. */}
          {(role === 'SUPER_ADMIN' || role === 'ADMIN') && (
            <div className="toggle-row">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={receivesAdminEmail}
                  onChange={(e) => setReceivesAdminEmail(e.target.checked)}
                />
                <span className="switch-track" aria-hidden="true" />
                <span className="switch-label">
                  Email alerts for admins
                  <span className="field-hint" style={{ marginTop: 0 }}>
                    Off means this admin is left out of notification emails, such as workshop
                    capacity alerts. They still see everything in the notification bell.
                  </span>
                </span>
              </label>
            </div>
          )}

          <div className="drawer-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add user'}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [drawerUser, setDrawerUser] = useState<AuthUser | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState<AuthUser | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['users', debounced, roleFilter],
    queryFn: () =>
      api.users.list({
        q: debounced || undefined,
        role: roleFilter || undefined,
      }),
  });

  const deactivate = useMutation({
    mutationFn: (id: number) => api.users.deactivate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      setConfirmDeactivate(null);
    },
  });

  const reactivate = useMutation({
    mutationFn: (id: number) => api.users.update(id, { isActive: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const users = useMemo(() => data?.data ?? [], [data]);

  function openCreate() {
    setDrawerUser(null);
    setDrawerOpen(true);
  }

  function openEdit(u: AuthUser) {
    setDrawerUser(u);
    setDrawerOpen(true);
  }

  return (
    <AppShell currentPath="/admin/users" title="Users">
      <div className="page-head">
        <div>
          <h2>Users</h2>
          <p>People who can sign in to the training database.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={openCreate}>
          Add user
        </button>
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="user-search" className="visually-hidden">
            Search users
          </label>
          <input
            id="user-search"
            type="search"
            placeholder="Search name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="field toolbar-select">
          <label htmlFor="role-filter" className="visually-hidden">
            Filter by role
          </label>
          <select id="role-filter" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>

        <span className="toolbar-count">
          {data ? `${data.total} ${data.total === 1 ? 'user' : 'users'}` : ''}
        </span>
      </div>

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load users.
            {error instanceof Error ? ` ${error.message}` : ''}
          </span>
        </div>
      )}

      <div className="panel">
        <div className="panel-body">
          {isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="empty">
              <IconUsers width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced || roleFilter ? 'No users match your filters.' : 'No users yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col" className="num">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.userId === currentUser?.userId;
                  return (
                    <tr key={u.userId}>
                      <td data-label="Name">
                        <span className="user-cell">
                          <span className="avatar avatar-sm" aria-hidden="true">
                            {initials(u.displayName)}
                          </span>
                          <span>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => openEdit(u)}
                            >
                              {u.displayName}
                            </button>
                            {isSelf && <span className="self-tag">You</span>}
                          </span>
                        </span>
                      </td>
                      <td data-label="Email" className="muted">
                        {u.email}
                      </td>
                      <td data-label="Role">
                        <span className={`role-pill role-${u.role.toLowerCase()}`}>
                          {ROLE_LABEL[u.role]}
                        </span>
                      </td>
                      <td data-label="Status">
                        <span className={`pill ${u.isActive ? 'pill-open' : 'pill-closed'}`}>
                          {u.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td data-label="Last sign-in" className="muted">
                        {fmtDate(u.lastLoginAt)}
                      </td>
                      <td data-label="Actions" className="num">
                        <span className="row-actions">
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEdit(u)}>
                            Edit
                          </button>
                          {u.isActive ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setConfirmDeactivate(u)}
                              disabled={isSelf}
                              title={isSelf ? 'You cannot deactivate your own account' : 'Deactivate'}
                            >
                              Deactivate
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => reactivate.mutate(u.userId)}
                              disabled={reactivate.isPending}
                            >
                              Reactivate
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {drawerOpen && (
        <UserDrawer
          user={drawerUser}
          onClose={() => setDrawerOpen(false)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['users'] })}
        />
      )}

      {confirmDeactivate && (
        <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDeactivate(null)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
            <h2 id="confirm-title">Deactivate {confirmDeactivate.displayName}?</h2>
            <p>
              They will be signed out and unable to sign in again. Their records and history are kept.
              You can reactivate them at any time.
            </p>
            <div className="drawer-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDeactivate(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => deactivate.mutate(confirmDeactivate.userId)}
                disabled={deactivate.isPending}
              >
                {deactivate.isPending ? 'Deactivating…' : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
