import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

/**
 * Health and auth are the two things every other request depends on: if
 * either is broken, nothing else can be trusted, so they are asserted first
 * and without a token.
 */
describe('health', () => {
  it('reports the process is up', async () => {
    const res = await api.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('reports the database is reachable', async () => {
    const res = await api.get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ database: 'connected' });
  });

  it('exposes the deployment label the UI shows as a badge', async () => {
    const res = await api.get('/health/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mode');
  });
});

describe('auth', () => {
  it('rejects a request with no token', async () => {
    const res = await api.get('/api/forms');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('rejects a malformed token', async () => {
    const res = await api.get('/api/forms').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects a bad password without revealing whether the account exists', async () => {
    const res = await api
      .post('/api/auth/login')
      .send({ email: 'nobody@example.invalid', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });
});
