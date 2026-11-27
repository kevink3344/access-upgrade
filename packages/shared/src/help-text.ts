/**
 * Help text is stored as a small subset of HTML — bold, italic, underline,
 * lists, links and line breaks — because staff want a short bulleted list
 * under a question, not a one-line hint.
 *
 * Two things follow from that, and both live here so the editor and the
 * public page cannot disagree:
 *
 *  - `sanitizeHelpHtml` runs over whatever the editor produced, and again
 *    when the public page renders it. The stored value is staff-supplied
 *    markup, so it must never be trusted as-is: a pasted `<script>`,
 *    `onclick=` or `javascript:` link would otherwise reach every visitor.
 *  - `helpHtmlToText` flattens it for places that need plain text — a
 *    screen-reader `aria-describedby` target is fine as markup, but a
 *    table cell or a log line is not.
 */

/** Tags the editor may produce and the public page may render. */
const ALLOWED_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ul',
  'ol',
  'li',
  'p',
  'div',
  'br',
  'a',
]);

/**
 * Characters a browser's contentEditable emits as markup but which mean a
 * line break to the person typing. Kept as `<br>` so the break survives a
 * save and reload, and so `pre-wrap` does not double it.
 */
const LINE_BREAK_CHARS = /[\r\n]/g;

/** Attributes kept, per tag. Everything else is dropped. */
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
};

/** Block elements end a line even when the tag itself is dropped. */
const BLOCK_TAGS = new Set(['div', 'p', 'li', 'ul', 'ol']);

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Decodes the basic entities a browser may already have escaped in text
 * nodes, so re-sanitising markup does not turn `&amp;` into `&amp;amp;`.
 * Deliberately last-in/first-out: `&amp;` is decoded last.
 */
function unescapeText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Only http(s) and mailto links survive; `javascript:` and friends do not. */
function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  return null;
}

/**
 * Rebuilds the markup from scratch, keeping only allowed tags and
 * attributes. Rebuilding rather than stripping means a malformed or
 * obfuscated tag cannot slip through: anything not recognised is dropped
 * as text.
 */
export function sanitizeHelpHtml(input: string | null | undefined): string {
  if (!input) return '';

  let out = '';
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out += escapeText(unescapeText(input.slice(i)));
      break;
    }
    out += escapeText(unescapeText(input.slice(i, lt)));

    const gt = input.indexOf('>', lt);
    if (gt === -1) {
      // An unterminated tag is not markup; show it as text.
      out += escapeText(unescapeText(input.slice(lt)));
      break;
    }

    const raw = input.slice(lt + 1, gt).trim();
    const closing = raw.startsWith('/');
    const name = (closing ? raw.slice(1) : raw).split(/[\s/]/)[0]!.toLowerCase();

    // `a < b` is text, not a tag: a real tag name is a letter followed by
    // letters, digits or hyphens. Anything else is shown as written.
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      out += escapeText(unescapeText(input.slice(lt, gt + 1)));
      i = gt + 1;
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      // Drop the tag but keep any text it wrapped. A block element still
      // ends a line, so a dropped <div> does not run two lines together.
      if (BLOCK_TAGS.has(name)) out += closing ? '\n' : '';
      i = gt + 1;
      continue;
    }

    if (closing) {
      // Void elements have no closing tag.
      if (name !== 'br') out += `</${name}>`;
      i = gt + 1;
      continue;
    }

    const attrs: string[] = [];
    for (const allowed of ALLOWED_ATTRS[name] ?? []) {
      // Match the attribute by name, quoted or not.
      const re = new RegExp(`\\b${allowed}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
      const m = re.exec(raw);
      const value = m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
      if (value === null) continue;

      if (allowed === 'href') {
        const href = safeHref(unescapeText(value));
        if (href) attrs.push(`href="${escapeText(href)}"`);
      } else {
        attrs.push(`${allowed}="${escapeText(unescapeText(value))}"`);
      }
    }

    out += `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
    i = gt + 1;
  }

  // A newline the browser left in the markup is a line break to the person
  // typing, and would otherwise be collapsed away on save.
  return out.replace(LINE_BREAK_CHARS, '<br>').trim();
}

/** True when the markup has nothing a visitor would read. */
export function isHelpHtmlEmpty(input: string | null | undefined): boolean {
  return helpHtmlToText(input).trim() === '';
}

/** Flattens help markup to plain text, one line per block. */
export function helpHtmlToText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // `&amp;` last: decoding it first would turn `&amp;lt;` into `<`.
    .replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n');
}
