import { useState } from 'react';
import { IconMoon, IconSun } from './icons';
import { currentTheme, toggleTheme, type Theme } from '../theme';

/**
 * Light/dark switch for the topbar, sitting immediately left of the bell.
 *
 * The icon shows the theme you would get by clicking — a moon in light mode —
 * which is the convention staff already know from other apps. The button is a
 * plain toggle, not a switch role: it is one action with one effect.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const dark = theme === 'dark';

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(toggleTheme())}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={dark}
    >
      {dark ? <IconSun width={20} height={20} /> : <IconMoon width={20} height={20} />}
    </button>
  );
}
