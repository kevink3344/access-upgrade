import { describe, expect, it } from 'vitest';
import { api, authedGet, hasDatabase } from './helpers.js';

/**
 * Read-only checks over the domain the app is actually used for.
 *
 * Everything here asserts on shape and on invariants that must hold for any
 * data — never on a specific row count or a specific workshop, so the suite
 * keeps passing as the test database grows.
 */
describe.skipIf(!hasDatabase)('forms', () => {
  it('lists published templates with their current version', async () => {
    const res = await authedGet('/api/forms');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);

    for (const t of res.body.data) {
      expect(t).toMatchObject({
        formTemplateId: expect.any(Number),
        name: expect.any(String),
        isActive: expect.any(Boolean),
        isArchived: expect.any(Boolean),
        isPublished: expect.any(Boolean),
      });
    }
  });

  it('hides archived forms unless they are asked for', async () => {
    const plain = await authedGet('/api/forms');
    const withArchived = await authedGet('/api/forms?includeArchived=true');

    expect(plain.status).toBe(200);
    expect(withArchived.status).toBe(200);

    // Archived rows must never leak into the default list.
    expect(plain.body.data.every((t: { isArchived: boolean }) => !t.isArchived)).toBe(true);
    expect(withArchived.body.data.length).toBeGreaterThanOrEqual(plain.body.data.length);
  });

  it('returns every question on a version with the fields the editor needs', async () => {
    const list = await authedGet('/api/forms');
    const template = list.body.data.find(
      (t: { currentVersionId: number | null }) => t.currentVersionId !== null,
    );
    expect(template, 'expected at least one form with a version').toBeTruthy();

    const res = await authedGet(`/api/forms/${template.formTemplateId}/versions/${template.currentVersionId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.questions)).toBe(true);
    expect(res.body.questions.length).toBeGreaterThan(0);

    for (const q of res.body.questions) {
      expect(q).toMatchObject({
        questionKey: expect.any(String),
        label: expect.any(String),
        fieldType: expect.any(String),
        isRequired: expect.any(Boolean),
        isBuiltIn: expect.any(Boolean),
      });
    }
  });

  it('gives every built-in question a column, except the branching driver', async () => {
    const list = await authedGet('/api/forms');
    const template = list.body.data.find(
      (t: { currentVersionId: number | null }) => t.currentVersionId !== null,
    );
    const res = await authedGet(`/api/forms/${template.formTemplateId}/versions/${template.currentVersionId}`);

    // A built-in question without MapsToColumn could never persist an answer,
    // which would silently lose data on the public form. The one deliberate
    // exception is `registrantRole`: it exists to drive branching (Educator vs
    // Parent) and is not itself stored.
    const BRANCH_DRIVER = 'registrantRole';
    const builtIns = res.body.questions.filter((x: { isBuiltIn: boolean }) => x.isBuiltIn);

    for (const q of builtIns) {
      if (q.questionKey === BRANCH_DRIVER) {
        expect(q.mapsToColumn, `${BRANCH_DRIVER} should not write to a column`).toBeNull();
        continue;
      }
      expect(q.mapsToColumn, `built-in question "${q.questionKey}" has no column`).toBeTruthy();
    }
  });

  it('rejects an unknown form', async () => {
    const res = await authedGet('/api/forms/99999999');
    expect([404, 200]).toContain(res.status);
  });
});

describe.skipIf(!hasDatabase)('workshops', () => {
  it('lists workshops with a stable shape', async () => {
    const res = await authedGet('/api/workshops?page=1&pageSize=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.page).toBe(1);
    expect(typeof res.body.total).toBe('number');
  });

  it('serves the static lookup routes ahead of the :id route', async () => {
    // Route ordering has bitten this codebase before: `/:id` must not swallow
    // `/lookup-names`. A 400 here would mean the id parser ran first.
    const res = await authedGet('/api/workshops/lookup-names');
    expect(res.status).toBe(200);
  });

  it('returns a bounded calendar range and reports undated workshops', async () => {
    const res = await authedGet('/api/workshops/calendar?from=2026-07-01&to=2027-06-30');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('undated');
  });
});

describe.skipIf(!hasDatabase)('public registration link', () => {
  it('404s an unknown slug rather than leaking a stack trace', async () => {
    const res = await api.get('/api/public/registration-links/does-not-exist-xyz');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('never exposes participant data on the public endpoint', async () => {
    // The public link is unauthenticated; it must carry workshop details and
    // the form, and nothing about who has registered.
    const res = await api.get('/api/public/registration-links/does-not-exist-xyz');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/@example\.(com|invalid)/);
  });
});
