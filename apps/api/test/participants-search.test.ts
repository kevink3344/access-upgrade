import { describe, expect, it } from 'vitest';
import { api, authToken, hasDatabase } from './helpers.js';

/**
 * Participant search.
 *
 * The search matched FirstName, LastName and Email separately, so a full name
 * found nothing: "Kevin" matched, "Kevin Test" did not, because neither column
 * contains both words. Staff type the whole name they see on the screen, so
 * that is the case pinned here.
 *
 * Runs against the real database because the bug was in the SQL — a pure test
 * of the query string would have restated the fix rather than caught its
 * absence.
 */

async function search(q: string) {
  const token = await authToken();
  const res = await api
    .get(`/api/participants?q=${encodeURIComponent(q)}&pageSize=5`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as { total: number; data: { FirstName: string; LastName: string }[] };
}

describe.skipIf(!hasDatabase)('participant search', () => {
  it('finds a participant by first name', async () => {
    const { total } = await search('Kevin');
    expect(total).toBeGreaterThan(0);
  });

  it('finds a participant by full name, first name first', async () => {
    // The regression: this returned 0 before the full-name match was added.
    // Only the count is asserted — the page is ordered by last name, so the
    // matching row is not necessarily in the first few results.
    const { total } = await search('Kevin Test');
    expect(total).toBeGreaterThan(0);
  });

  it('finds a participant by full name in the list order, last name first', async () => {
    // The list sorts by last name, so staff sometimes copy it that way.
    const { total } = await search('Test, Kevin');
    expect(total).toBeGreaterThan(0);
  });

  it('is case-insensitive', async () => {
    const upper = await search('KEVIN TEST');
    expect(upper.total).toBeGreaterThan(0);
  });

  it('still finds a participant by email', async () => {
    const { total } = await search('key.kevin');
    expect(total).toBeGreaterThan(0);
  });

  it('returns nothing for a name that does not exist', async () => {
    const { total } = await search('Zzzznotarealname');
    expect(total).toBe(0);
  });
});
