import { describe, expect, it } from 'vitest';
import { helpHtmlToText, isHelpHtmlEmpty, sanitizeHelpHtml } from '@pe/shared';

/**
 * Help text is staff-supplied markup rendered on a public page, so the
 * sanitiser is the security boundary. These assertions are what stops a
 * pasted `<script>` or `javascript:` link reaching a visitor.
 */
describe('sanitizeHelpHtml', () => {
  it('keeps the formatting subset', () => {
    const html = '<p><b>Bold</b> <i>italic</i> <u>under</u></p><ul><li>one</li></ul>';
    expect(sanitizeHelpHtml(html)).toBe(html);
  });

  it('drops a script tag but keeps the text around it', () => {
    expect(sanitizeHelpHtml('before<script>alert(1)</script>after')).toBe(
      'beforealert(1)after',
    );
  });

  it('drops event-handler attributes', () => {
    expect(sanitizeHelpHtml('<b onclick="alert(1)">x</b>')).toBe('<b>x</b>');
  });

  it('drops a javascript: link but keeps the anchor text', () => {
    expect(sanitizeHelpHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
  });

  it('keeps http, https and mailto links', () => {
    expect(sanitizeHelpHtml('<a href="https://example.test/a?b=1">x</a>')).toBe(
      '<a href="https://example.test/a?b=1">x</a>',
    );
    expect(sanitizeHelpHtml('<a href="mailto:a@b.test">x</a>')).toBe(
      '<a href="mailto:a@b.test">x</a>',
    );
  });

  it('escapes text that looks like markup', () => {
    expect(sanitizeHelpHtml('5 < 6 and 7 > 6')).toBe('5 &lt; 6 and 7 &gt; 6');
  });

  it('treats an unterminated tag as text', () => {
    expect(sanitizeHelpHtml('a < b')).toBe('a &lt; b');
  });

  it('returns an empty string for null and empty input', () => {
    expect(sanitizeHelpHtml(null)).toBe('');
    expect(sanitizeHelpHtml('')).toBe('');
  });
});

describe('helpHtmlToText', () => {
  it('flattens lists to one line per item', () => {
    expect(helpHtmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('one\ntwo\n');
  });

  it('decodes the entities the sanitiser produces', () => {
    expect(helpHtmlToText('5 &lt; 6 &amp; 7 &gt; 6')).toBe('5 < 6 & 7 > 6');
  });

  it('does not double-decode an escaped ampersand', () => {
    expect(helpHtmlToText('&amp;lt;')).toBe('&lt;');
  });

  it('reports markup with no readable text as empty', () => {
    expect(isHelpHtmlEmpty('<p></p>')).toBe(true);
    expect(isHelpHtmlEmpty('<p>x</p>')).toBe(false);
  });
});
