import { useEffect } from 'react';

/**
 * Locks page scrolling while an overlay (drawer, dialog) is open.
 *
 * Without this, an open drawer shows two scrollbars: the page's and the
 * drawer body's. The scrollbar width is compensated with padding so the
 * content behind does not shift when it disappears.
 */
export function useScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;

    const body = document.body;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    body.classList.add('scroll-locked');
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    return () => {
      body.classList.remove('scroll-locked');
      body.style.paddingRight = '';
    };
  }, [active]);
}
