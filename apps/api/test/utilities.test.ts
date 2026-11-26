import { describe, expect, it } from 'vitest';
import { api, authToken, hasDatabase } from './helpers.js';

/**
 * Utilities.
 *
 * The suite is read-only by design, so the merge itself is not executed here
 * — a test that moved real registrations would break the "every test is
 * read-only" rule the shared test database depends on. What is pinned is the
 * part that decides whether a merge is *allowed*: the preview, its blockers,
 * and the confirmation token. Those are pure reads plus an in-memory token,
 * so they can run against the real data safely.
 *
 * The audit history is the one write, and it is deliberately kept out of this
 * suite: `audit.UtilityRun` is created by migration 028, and a test that
 * depends on a migration having been applied turns a missing deploy step into
 * a red suite that says "merge is broken" instead. The history endpoint is
 * checked for shape, not for the row a fake run would have written.
 */

async function get(path: string) {
  const token = await authToken();
  return api.get(path).set('Authorization', `Bearer ${token}`);
}

async function post(path: string, body: unknown) {
  const token = await authToken();
  return api.post(path).set('Authorization', `Bearer ${token}`).send(body as object);
}

/** A participant id that exists, found through the picker rather than hard-coded. */
async function anyParticipantId(): Promise<number> {
  const res = await get('/api/admin/utilities/participants?pageSize=1');
  expect(res.status).toBe(200);
  expect(res.body.total).toBeGreaterThan(0);
  return res.body.data[0].participantId as number;
}

describe.skipIf(!hasDatabase)('utilities', () => {
  it('requires authentication', async () => {
    const res = await api.get('/api/admin/utilities');
    expect(res.status).toBe(401);
  });

  it('lists the catalogue with overview counts', async () => {
    const res = await get('/api/admin/utilities');
    expect(res.status).toBe(200);

    const keys = (res.body.data as { key: string }[]).map((u) => u.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'duplicate-participants',
        'negative-payments',
        'registrations-no-workshop',
        'merge-participants',
      ]),
    );

    expect(res.body.overview).toMatchObject({
      duplicateGroups: expect.any(Number),
      duplicateParticipants: expect.any(Number),
      negativePayments: expect.any(Number),
      orphanRegistrations: expect.any(Number),
    });
  });

  it('groups duplicate participants by email, never singletons', async () => {
    const res = await get('/api/admin/utilities/duplicate-participants?pageSize=5');
    expect(res.status).toBe(200);

    for (const group of res.body.data as { email: string; participants: unknown[] }[]) {
      expect(group.email).toBe(group.email.toLowerCase());
      expect(group.participants.length).toBeGreaterThan(1);
    }
  });

  it('lists school years newest first with duplicate counts', async () => {
    const res = await get('/api/admin/utilities/school-years');
    expect(res.status).toBe(200);

    const years = res.body.data as { id: number; label: string; duplicateGroups: number }[];
    expect(years.length).toBeGreaterThan(0);

    const ids = years.map((y) => y.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    for (const y of years) expect(y.duplicateGroups).toBeGreaterThanOrEqual(0);
  });

  it('scopes duplicate groups to a school year, and the year is a subset of all years', async () => {
    const all = await get('/api/admin/utilities/duplicate-participants?pageSize=1');
    expect(all.status).toBe(200);
    expect(all.body.schoolYear).toBeNull();

    const years = await get('/api/admin/utilities/school-years');
    const newest = (years.body.data as { id: number }[])[0]!;

    const scoped = await get(
      `/api/admin/utilities/duplicate-participants?schoolYearId=${newest.id}&pageSize=1`,
    );
    expect(scoped.status).toBe(200);
    expect(scoped.body.schoolYear).toMatchObject({ id: newest.id });

    // The year filter can only narrow the list, never widen it.
    expect(scoped.body.totalGroups).toBeLessThanOrEqual(all.body.totalGroups);
  });

  it('returns every participant in a scoped group, not just the ones in the year', async () => {
    const years = await get('/api/admin/utilities/school-years');
    const newest = (years.body.data as { id: number }[])[0]!;

    const res = await get(
      `/api/admin/utilities/duplicate-participants?schoolYearId=${newest.id}&pageSize=50`,
    );
    expect(res.status).toBe(200);

    // A group exists because two people share the address. Showing one of them
    // would invite a merge with a record that is not on screen.
    for (const group of res.body.data as { participants: unknown[] }[]) {
      expect(group.participants.length).toBeGreaterThan(1);
    }
  });

  it('rejects a non-numeric school year', async () => {
    const res = await get('/api/admin/utilities/duplicate-participants?schoolYearId=abc');
    expect(res.status).toBe(422);
  });

  it('reports negative payments with a split by cancellation state', async () => {
    const res = await get('/api/admin/utilities/negative-payments');
    expect(res.status).toBe(200);

    for (const row of res.body.data as { paidAmount: number }[]) {
      expect(row.paidAmount).toBeLessThan(0);
    }

    const s = res.body.summary as { count: number; onCancelled: number; onActive: number };
    expect(s.onCancelled + s.onActive).toBe(s.count);
  });

  it('lists registrations with no workshop', async () => {
    const res = await get('/api/admin/utilities/registrations-no-workshop');
    expect(res.status).toBe(200);
    expect(res.body.summary.count).toBe((res.body.data as unknown[]).length);
  });

  it('refuses to preview a merge of a participant with itself', async () => {
    const id = await anyParticipantId();
    const res = await post('/api/admin/utilities/merge-participants/preview', {
      sourceParticipantId: id,
      targetParticipantId: id,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('validation_failed');
  });

  it('reports a missing participant rather than inventing one', async () => {
    const id = await anyParticipantId();
    const res = await post('/api/admin/utilities/merge-participants/preview', {
      sourceParticipantId: 2147483000,
      targetParticipantId: id,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('returns a preview with moves, blockers and a token', async () => {
    const res = await get('/api/admin/utilities/participants?pageSize=2');
    const [a, b] = res.body.data as { participantId: number }[];

    const preview = await post('/api/admin/utilities/merge-participants/preview', {
      sourceParticipantId: a!.participantId,
      targetParticipantId: b!.participantId,
    });
    expect(preview.status).toBe(200);

    expect(preview.body.moves).toMatchObject({
      registrations: expect.any(Number),
      attendance: expect.any(Number),
      creditSlips: expect.any(Number),
      usedCreditSlips: expect.any(Number),
      certificateOverrides: expect.any(Number),
      certificateIssues: expect.any(Number),
    });
    expect(preview.body.blockers).toMatchObject({
      sharedWorkshops: expect.any(Array),
      notes: expect.any(Array),
    });
    expect(typeof preview.body.token).toBe('string');
    expect(preview.body.token.length).toBeGreaterThan(10);
  });

  it('refuses to run with a token it did not issue', async () => {
    const res = await get('/api/admin/utilities/participants?pageSize=2');
    const [a, b] = res.body.data as { participantId: number }[];

    const run = await post('/api/admin/utilities/merge-participants/run', {
      sourceParticipantId: a!.participantId,
      targetParticipantId: b!.participantId,
      token: 'not-a-token-this-server-issued',
    });
    expect(run.status).toBe(409);
    expect(run.body.error).toBe('stale_preview');
  });

  it('returns the run history newest first', async () => {
    const res = await get('/api/admin/utilities/runs?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);

    const times = (res.body.data as { runAt: string }[]).map((r) => Date.parse(r.runAt));
    const sorted = [...times].sort((x, y) => y - x);
    expect(times).toEqual(sorted);
  });

  it('records a refused merge in the audit history', async () => {
    const res = await get('/api/admin/utilities/participants?pageSize=2');
    const [a, b] = res.body.data as { participantId: number }[];

    await post('/api/admin/utilities/merge-participants/run', {
      sourceParticipantId: a!.participantId,
      targetParticipantId: b!.participantId,
      token: 'not-a-token-this-server-issued',
    });

    const history = await get('/api/admin/utilities/runs?key=merge-participants&limit=5');
    expect(history.status).toBe(200);
    expect(history.body.data[0]).toMatchObject({
      utilityKey: 'merge-participants',
      succeeded: false,
      affectedRows: 0,
    });
  });

  it('rejects a run with no token at all', async () => {
    const res = await get('/api/admin/utilities/participants?pageSize=2');
    const [a, b] = res.body.data as { participantId: number }[];

    const run = await post('/api/admin/utilities/merge-participants/run', {
      sourceParticipantId: a!.participantId,
      targetParticipantId: b!.participantId,
    });
    expect(run.status).toBe(422);
  });
});
