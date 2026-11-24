import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { api, authToken } from './helpers.js';
import { parseScoCsv } from '../src/services/schoolcash.js';

/**
 * The School Cash endpoints, exercised end to end against the real database.
 *
 * These exist because the pure unit tests cannot catch a query that names a
 * column which does not exist — that only fails when the statement reaches SQL
 * Server. A `w.Price` reference shipped once and broke every upload with
 * "Invalid column name 'Price'"; the workshop price is `Cost1`.
 *
 * Deliberately calling the routes rather than re-writing their SQL here: a
 * copy of a query cannot catch a bug in the original.
 *
 * Nothing here writes data. Upload is exercised only through its validation
 * failures, which return before any insert.
 */

const REAL_FIXTURE = path.resolve(__dirname, '../../../database/ItemOrderReport_1795535397115.csv');

async function authed(pathname: string) {
  const token = await authToken();
  return api.get(pathname).set('Authorization', `Bearer ${token}`);
}

describe('School Cash endpoints', () => {
  it('lists imports', async () => {
    const res = await authed('/api/school-cash/imports');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rows');
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  it('lists applied-payments history', async () => {
    const res = await authed('/api/school-cash/history');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalAmount');
  });

  it('rejects an upload that is not an Item Order Report, naming the columns', async () => {
    const token = await authToken();
    const res = await api
      .post('/api/school-cash/imports')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .set('X-File-Name', 'not-a-report.csv')
      .send('foo,bar\n1,2');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('not_item_order_report');
    expect(res.body.missing).toContain('Purchaser Email');
  });

  it('rejects an empty body', async () => {
    const token = await authToken();
    const res = await api
      .post('/api/school-cash/imports')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .send('');
    expect(res.status).toBe(400);
  });

  it('returns 404 for an import that does not exist', async () => {
    const res = await authed('/api/school-cash/imports/999999999');
    expect(res.status).toBe(404);
  });

  it('serves candidates for a real purchaser without a SQL error', async () => {
    const p = REAL_FIXTURE;
    if (!fs.existsSync(p)) return; // The sample export is gitignored.

    const parsed = parseScoCsv(fs.readFileSync(p, 'utf8'));
    expect(parsed.ok).toBe(true);
    const email = parsed.rows.find((r) => r.purchaserEmail)?.purchaserEmail;
    expect(email).toBeTruthy();

    // This is the statement that used w.Price. An invalid column here would
    // surface as a 500 rather than a 200 with rows.
    const res = await authed(
      `/api/school-cash/imports/1/candidates?q=${encodeURIComponent(email!)}`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    for (const row of res.body.rows) {
      expect(row).toHaveProperty('Owed');
      expect(row).toHaveProperty('WorkshopPrice');
    }
  });

  it('stages an unknown purchaser as matched, not as needing review', async () => {
    // A purchaser with no participant record is not a failure: applying the
    // import creates the participant and registration. This asserts the row
    // is staged High so it needs no manual work.
    const token = await authToken();
    // The email is unique per run: the import is keyed on a hash of the whole
    // file, so a byte-identical CSV would be refused as already imported.
    const unique = `no-such-purchaser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
    const csv = [
      'Purchaser Email,Item Name,Item Id,Paid Item Balance,Paid Transaction Fee,Purchased,Paid Amount,Payments',
      `${unique},Some Item,99999,$25.00,$1.10,09/15/2026,$26.10,paid`,
    ].join('\n');

    const res = await api
      .post('/api/school-cash/imports')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .set('X-File-Name', `unknown-purchaser-${Date.now()}.csv`)
      .send(csv);

    expect(res.status).toBe(201);
    expect(res.body.matched).toBe(1);
    expect(res.body.review).toBe(0);

    // Clean up so the test leaves no staged rows behind.
    const detail = await authed(`/api/school-cash/imports/${res.body.importId}`);
    expect(detail.status).toBe(200);
    const row = detail.body.rows[0];
    expect(row.MatchConfidence).toBe('High');
    expect(row.MatchNote).toContain('New purchaser');

    await api
      .post(`/api/school-cash/imports/${res.body.importId}/discard`)
      .set('Authorization', `Bearer ${token}`);
  });
});
