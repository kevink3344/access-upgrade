import { describe, expect, it, afterAll } from 'vitest';
import { api, authToken, hasDatabase } from './helpers.js';
import { query, sql } from '../src/db.js';

/**
 * Concurrent id allocation.
 *
 * Ids on the legacy-keyed tables are allocated inside the INSERT rather than
 * by a separate SELECT MAX, so simultaneous creates must all succeed. This
 * asserts that directly: fire N creates at once and require N distinct ids.
 *
 * The rows are removed afterwards. They are tagged with a unique prefix so a
 * crashed run cannot delete anything a person created.
 */
describe.skipIf(!hasDatabase)('concurrent id allocation', () => {
  const tag = `zz-vitest-${Date.now()}`;

  afterAll(async () => {
    // Delete by tag rather than by the ids collected above: a create that
    // failed still left a row behind, and those ids were never recorded.
    await query(
      `DELETE FROM core.Agency WHERE AgencyName LIKE @tag`,
      { tag: { type: sql.NVarChar(255), value: `${tag}%` } },
    );
  });

  it('gives every simultaneous agency create a distinct id', async () => {
    const token = await authToken();
    const count = 8;

    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        api
          .post('/api/agencies')
          .set('Authorization', `Bearer ${token}`)
          .send({ agencyName: `${tag}-${i}` }),
      ),
    );

    const ids = results.map((r) => {
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.agencyId as number;
    });

    expect(new Set(ids).size).toBe(count);
  });
});
