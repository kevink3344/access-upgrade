import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Minimum drawer width in px. Below this the form fields start to squash, so
 * the handle refuses to go narrower rather than letting the user break it.
 */
const MIN_WIDTH = 380;

/** Leave a sliver of the page visible so the drawer still reads as an overlay. */
const MIN_VISIBLE_PAGE = 120;

function maxWidth(): number {
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_VISIBLE_PAGE);
}

function clamp(px: number): number {
  return Math.min(Math.max(px, MIN_WIDTH), maxWidth());
}

/**
 * Makes a right-hand drawer resizable by dragging its left edge.
 *
 * The width is persisted per drawer key, so a user who widens the workshop
 * drawer finds it wide again next time without affecting the others.
 *
 * Returns the style to spread onto the drawer element and the props for the
 * drag handle. Width is only applied once the user has actually dragged, so
 * the CSS default governs until then.
 */
export function useResizableDrawer(storageKey: string) {
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // Restore a previously chosen width. Ignored if the window is now too
  // narrow to honour it, which is common when moving between monitors.
  useEffect(() => {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved > 0) setWidth(clamp(saved));
  }, [storageKey]);

  // A window resize can invalidate the saved width; re-clamp rather than
  // letting the drawer overflow the viewport.
  useEffect(() => {
    if (width === null) return;
    const onResize = () => setWidth((w) => (w === null ? w : clamp(w)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [width]);

  // Hold the resize cursor across the whole page while dragging, otherwise it
  // flickers as the pointer leaves the narrow handle.
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('drawer-resizing');
    return () => document.body.classList.remove('drawer-resizing');
  }, [dragging]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      // The handle overhangs the drawer's left edge, so without this the
      // mousedown bubbles to the scrim and reads as a click-outside.
      e.stopPropagation();
      const el = drawerRef.current;
      if (!el) return;

      startX.current = e.clientX;
      startWidth.current = el.getBoundingClientRect().width;
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      e.stopPropagation();
      // Dragging left widens the drawer, so the delta is inverted.
      const next = clamp(startWidth.current + (startX.current - e.clientX));
      setWidth(next);
    },
    [dragging],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      e.stopPropagation();
      setDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setWidth((w) => {
        if (w !== null) localStorage.setItem(storageKey, String(Math.round(w)));
        return w;
      });
    },
    [dragging, storageKey],
  );

  /** Double-click the handle to forget the custom width. */
  const onDoubleClick = useCallback(() => {
    localStorage.removeItem(storageKey);
    setWidth(null);
  }, [storageKey]);

  return {
    drawerRef,
    dragging,
    drawerStyle: width === null ? undefined : { width: `${width}px`, maxWidth: '100%' },
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick,
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-label': 'Resize panel',
      tabIndex: 0,
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
        // Keyboard resizing so the handle is usable without a mouse.
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setWidth((w) => {
            const base = w ?? drawerRef.current?.getBoundingClientRect().width ?? MIN_WIDTH;
            const next = clamp(base + step);
            localStorage.setItem(storageKey, String(Math.round(next)));
            return next;
          });
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          setWidth((w) => {
            const base = w ?? drawerRef.current?.getBoundingClientRect().width ?? MIN_WIDTH;
            const next = clamp(base - step);
            localStorage.setItem(storageKey, String(Math.round(next)));
            return next;
          });
        }
      },
    },
  };
}
