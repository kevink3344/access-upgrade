import request from 'supertest';
import type supertest from 'supertest';
import { app } from '../src/server.js';

/**
 * Shared harness for the API suite.
 *
 * These tests run against the real database named in apps/api/.env, which is
 * the TEST database. Nothing here writes data: every assertion is read-only,
 * so a failed run cannot leave rows behind.
 */
export const api: supertest.Agent = request(app);

let cachedToken: string | null = null;

/**
 * Sign in as the seeded super administrator.
 *
 * The credentials come from the same environment the API boots with, so the
 * suite needs no separate fixture account. The token is cached because every
 * authenticated request would otherwise pay for a bcrypt comparison.
 */
export async function authToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  const email = process.env.SUPER_ADMIN_EMAIL ?? process.env.SUPER_ADMIN_USERNAME;
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'SUPER_ADMIN_EMAIL/SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD must be set in apps/api/.env',
    );
  }

  const res = await api.post('/api/auth/login').send({ email, password });

  if (res.status !== 200) {
    throw new Error(`Login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  cachedToken = res.body.token as string;
  return cachedToken;
}

/** Shorthand for a GET with the bearer token attached. */
export async function authedGet(path: string) {
  const token = await authToken();
  return api.get(path).set('Authorization', `Bearer ${token}`);
}
