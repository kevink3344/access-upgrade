import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthUser } from '@pe/shared';
import { api, getToken, setToken, refreshSession } from './api';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the session on reload. The token lives in sessionStorage by
  // default, or localStorage when the user chose "remember me" — so a
  // refresh always keeps them signed in, but only "remember me" survives
  // closing the browser.
  //
  // A stored token may already be expired (it is short-lived), and a browser
  // restart leaves only the refresh cookie. So a failed /me is not a sign-out:
  // try the refresh cookie once, and only then clear the token.
  useEffect(() => {
    const token = getToken();

    const restore = async () => {
      if (token) {
        try {
          setUser(await api.me());
          return;
        } catch {
          // Fall through to the refresh attempt.
        }
      }

      if (await refreshSession()) {
        try {
          setUser(await api.me());
          return;
        } catch {
          // Refresh succeeded but the session still cannot be read.
        }
      }

      setToken(null);
    };

    restore().finally(() => setLoading(false));
  }, []);

  async function signIn(email: string, password: string, rememberMe = false) {
    const res = await api.login(email, password, rememberMe);
    setToken(res.token, rememberMe);
    setUser(res.user);
  }

  async function signOut() {
    try {
      await api.logout();
    } finally {
      setToken(null);
      setUser(null);
    }
  }

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
