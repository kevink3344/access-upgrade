import { describe, expect, it } from 'vitest';
import { api, authedGet, hasDatabase } from './helpers.js';
import { decodeHeaderImage } from '../src/services/form-header.js';

/**
 * The form header image's rules.
 *
 * The decoding checks are pure and always run. The route checks need the
 * database and are read-only: they assert what a request without a valid
 * session, or for a form with no live link, must NOT be able to get.
 */

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('decodeHeaderImage', () => {
  it('accepts PNG and reports its content type and size', () => {
    const out = decodeHeaderImage({
      data: `data:image/png;base64,${png.toString('base64')}`,
      contentType: 'image/png',
    });
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.contentType).toBe('image/png');
    expect(out.content.length).toBe(png.length);
  });

  it('refuses SVG — the same bytes are served from the public origin', () => {
    const out = decodeHeaderImage({
      data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
      contentType: 'image/svg+xml',
    });
    expect(out).toEqual({ error: 'Unsupported image type. Use PNG, JPEG or WebP.' });
  });

  it('refuses an image over 2 MB', () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    const out = decodeHeaderImage({ data: big.toString('base64'), contentType: 'image/png' });
    expect(out).toEqual({ error: 'Image is larger than 2 MB' });
  });
});

describe.skipIf(!hasDatabase)('form header routes', () => {
  it('will not serve a header for a form with no live link', async () => {
    // Form 1 is a seeded template; whether or not it has an image, the
    // public route must not hand one out without an active link.
    const res = await api.get('/api/public/forms/1/header');
    expect(res.status).toBe(404);
  });

  it('requires a session for the preview payload', async () => {
    const res = await api.get('/api/forms/1/preview');
    expect(res.status).toBe(401);
  });

  it('requires a session for the header state', async () => {
    const res = await api.get('/api/forms/1/header');
    expect(res.status).toBe(401);
  });

  it('returns the header state for a signed-in staff member', async () => {
    const res = await authedGet('/api/forms/1/header');
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('hasHeaderImage');
      expect(res.body).toHaveProperty('headerAltText');
    }
  });
});
