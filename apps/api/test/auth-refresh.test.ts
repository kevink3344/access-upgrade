import { describe, expect, it, beforeAll } from 'vitest';
import { api, hasDatabase } from './helpers.js';

/**
 * Refresh-token rotation.
 *
 * The interesting behaviour is not "a new token comes back" but what happens
 * when the same token is presented twice. Rotation exists so that a stolen
 * cookie is usable at most once, and the second use revokes the whole chain.
 *
 * These tests sign in as the seeded super administrator and clean up after
 * themselves: every token they create is revoked at the end, so a failed run
 * cannot leave a live session behind.
 */
describe.skipIf(!hasDatabase)('refresh token rotation', () => {
  let email: string;
  let password: string;

  beforeAll(() => {
    email = (process.env.SUPER_ADMIN_EMAIL ?? process.env.SUPER_ADMIN_USERNAME)!;
    password = process.env.SUPER_ADMIN_PASSWORD!;
  });

  /** Pull the refresh cookie out of a Set-Cookie header. */
  function refreshCookie(res: { headers: Record<string, unknown> }): string | null {
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const match = list.find((c: string) => c.startsWith('pe_refresh='));
    return match ? match.split(';')[0]! : null;
  }

  it('refuses a refresh with no cookie', async () => {
    const res = await api.post('/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_refresh_token');
  });

  it('refuses an unknown cookie value', async () => {
    const res = await api
      .post('/api/auth/refresh')
      .set('Cookie', 'pe_refresh=not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_refresh_token');
  });

  it('rotates the token and returns a usable access token', async () => {
    const login = await api.post('/api/auth/login').send({ email, password });
    expect(login.status).toBe(200);

    const first = refreshCookie(login);
    expect(first).toBeTruthy();

    const refreshed = await api.post('/api/auth/refresh').set('Cookie', first!);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.token).toBeTruthy();

    // The new access token must actually work.
    const me = await api
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email.toLowerCase());

    // The refresh token must have changed.
    const second = refreshCookie(refreshed);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // Clean up the live chain.
    await api.post('/api/auth/logout').set('Cookie', second!);
  });

  it('treats a replayed token as theft and revokes the chain', async () => {
    const login = await api.post('/api/auth/login').send({ email, password });
    const first = refreshCookie(login)!;

    // First use succeeds and rotates.
    const refreshed = await api.post('/api/auth/refresh').set('Cookie', first);
    expect(refreshed.status).toBe(200);
    const second = refreshCookie(refreshed)!;

    // Replaying the original is the attack signature.
    const replay = await api.post('/api/auth/refresh').set('Cookie', first);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('refresh_token_reused');

    // And the legitimate successor is now dead too — the session is over.
    const afterRevoke = await api.post('/api/auth/refresh').set('Cookie', second);
    expect(afterRevoke.status).toBe(401);
  });

  it('revokes the token on logout so it cannot be replayed', async () => {
    const login = await api.post('/api/auth/login').send({ email, password });
    const cookie = refreshCookie(login)!;

    const out = await api.post('/api/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(204);

    const replay = await api.post('/api/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });
});
