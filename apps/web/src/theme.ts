/**
 * Light/dark theme preference.
 *
 * The choice is stored per browser, not per account: staff share accounts, and
 * a theme is a display preference for the screen in front of you.
 *
 * `index.html` runs the same read before first paint so the page never flashes
 * the light theme on the way to dark. Keep the two in sync.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'pe.theme';

/** The theme in effect right now — read from the DOM, which is the source of truth. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode or a full quota — the choice simply won't persist.
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}
