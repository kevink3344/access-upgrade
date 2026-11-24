import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { api, authToken, hasDatabase } from './helpers.js';
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

/** The committed fixture. The real exports are gitignored, so CI has none. */
const REAL_FIXTURE = path.resolve(__dirname, 'fixtures/sco-items.csv');

async function authed(pathname: string) {
  const token = await authToken();
  return api.get(pathname).set('Authorization', `Bearer ${token}`);
}

describe.skipIf(!hasDatabase)('School Cash endpoints', () => {
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

  it('stages an unknown purchaser as needing review, not auto-matched', async () => {
    // Applying creates a participant and registration, which should be a
    // deliberate choice — so an unknown email is surfaced, not assumed.
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
    // One distinct item, and it has no workshop — so nothing is matched yet.
    expect(res.body.items).toBe(1);
    expect(res.body.itemsResolved).toBe(0);

    const items = await authed(`/api/school-cash/imports/${res.body.importId}/items`);
    expect(items.status).toBe(200);
    expect(items.body.ready).toBe(false);
    expect(items.body.unresolved).toBe(1);

    // Clean up so the test leaves no staged rows behind.
    await api
      .post(`/api/school-cash/imports/${res.body.importId}/discard`)
      .set('Authorization', `Bearer ${token}`);
  });

  it('allows applying with unresolved items, reporting how many were skipped', async () => {
    // Staff can continue before every item is resolved. Those items simply do
    // not match; the rest still apply, and the response says what was skipped.
    const token = await authToken();
    const unique = `unresolved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
    const csv = [
      'Purchaser Email,Item Name,Item Id,Paid Item Balance,Paid Transaction Fee,Purchased,Paid Amount,Payments',
      `${unique},Some Item,99999,$25.00,$1.10,09/15/2026,$26.10,paid`,
    ].join('\n');

    const res = await api
      .post('/api/school-cash/imports')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .set('X-File-Name', `unresolved-${Date.now()}.csv`)
      .send(csv);
    expect(res.status).toBe(201);
    expect(res.body.items).toBe(1);
    expect(res.body.itemsResolved).toBe(0);

    // Nothing is matched, so there is nothing to apply — but the refusal is
    // "nothing to apply", not "workshops unresolved".
    const apply = await api
      .post(`/api/school-cash/imports/${res.body.importId}/apply`)
      .set('Authorization', `Bearer ${token}`);
    expect(apply.status).toBe(409);
    expect(apply.body.error).toBe('nothing_to_apply');

    await api
      .post(`/api/school-cash/imports/${res.body.importId}/discard`)
      .set('Authorization', `Bearer ${token}`);
  });

  it('skips a purchase already staged by a different file', async () => {
    // Two staff exporting the same day get different files — one may have an
    // extra row — so the file hash differs while the purchases inside are the
    // same. The repeated purchase must be skipped, not staged twice.
    const token = await authToken();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const header =
      'Purchaser Email,Item Name,Item Id,Paid Item Balance,Paid Transaction Fee,Purchased,Paid Amount,Payments';
    const shared = `dupe-${stamp}@example.invalid,Sensory Processing and Self-Regulation,50295,$25.00,$1.10,09/15/2026,$26.10,paid`;
    const extra = `dupe-${stamp}@example.invalid,Handwriting: The Building Blocks,46947,$25.00,$1.10,09/16/2026,$26.10,paid`;

    const up = (name: string, body: string) =>
      api
        .post('/api/school-cash/imports')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'text/plain')
        .set('X-File-Name', name)
        .send(body);

    const first = await up(`dupe-a-${stamp}.csv`, [header, shared].join('\n'));
    expect(first.status).toBe(201);
    expect(first.body.ignored).toBe(0);

    const second = await up(`dupe-b-${stamp}.csv`, [header, shared, extra].join('\n'));
    expect(second.status).toBe(201);
    // The shared purchase is skipped; the genuinely new one is kept.
    expect(second.body.ignored).toBe(1);
    expect(second.body.TotalRows).toBe(2);

    // A byte-identical re-upload is refused outright.
    const third = await up(`dupe-b-${stamp}.csv`, [header, shared, extra].join('\n'));
    expect(third.status).toBe(409);
    expect(third.body.error).toBe('already_imported');

    for (const id of [first.body.importId, second.body.importId]) {
      await api
        .post(`/api/school-cash/imports/${id}/discard`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('deletes a staged upload so it leaves the list', async () => {
    const token = await authToken();
    const unique = `delete-me-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
    const csv = [
      'Purchaser Email,Item Name,Item Id,Paid Item Balance,Paid Transaction Fee,Purchased,Paid Amount,Payments',
      `${unique},Some Item,99999,$25.00,$1.10,09/15/2026,$26.10,paid`,
    ].join('\n');

    const created = await api
      .post('/api/school-cash/imports')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .set('X-File-Name', `delete-me-${Date.now()}.csv`)
      .send(csv);
    expect(created.status).toBe(201);
    const importId = created.body.importId as number;

    const del = await api
      .post(`/api/school-cash/imports/${importId}/discard`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    // Gone from the detail endpoint...
    const detail = await authed(`/api/school-cash/imports/${importId}`);
    expect(detail.status).toBe(404);

    // ...and gone from the list, rather than lingering as "Discarded".
    const list = await authed('/api/school-cash/imports?pageSize=200');
    expect(list.status).toBe(200);
    const ids = (list.body.rows as { ScoImportID: number }[]).map((r) => r.ScoImportID);
    expect(ids).not.toContain(importId);
  });
});
