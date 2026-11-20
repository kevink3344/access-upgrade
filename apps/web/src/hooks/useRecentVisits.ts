import { useCallback, useEffect, useState } from 'react';

export interface RecentItem {
  id: number;
  /** Primary label, e.g. the workshop title. */
  title: string;
  /** Secondary label, e.g. the workshop code. */
  subtitle: string | null;
  /** ISO timestamp of the visit. */
  visitedAt: string;
}

const MAX_ITEMS = 8;

/**
 * Remembers recently opened records in localStorage.
 *
 * Used for the "recently visited" chips above the workshops table. Kept in
 * the browser rather than the database: it is a per-device convenience, not
 * shared state, and putting it in SQL would mean a write on every open.
 *
 * Entries are keyed by id, so revisiting moves an item to the front rather
 * than duplicating it.
 */
export function useRecentVisits(storageKey: string) {
  const [items, setItems] = useState<RecentItem[]>([]);

  // Read once on mount. Wrapped because localStorage throws in private mode
  // and when the quota is exhausted.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setItems(
          parsed
            .filter((i) => i && typeof i.id === 'number' && typeof i.title === 'string')
            .slice(0, MAX_ITEMS),
        );
      }
    } catch {
      /* ignore malformed or unavailable storage */
    }
  }, [storageKey]);

  const persist = useCallback(
    (next: RecentItem[]) => {
      setItems(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore quota errors - the list is a convenience, not critical */
      }
    },
    [storageKey],
  );

  const record = useCallback(
    (item: Omit<RecentItem, 'visitedAt'>) => {
      setItems((prev) => {
        const next = [
          { ...item, visitedAt: new Date().toISOString() },
          ...prev.filter((i) => i.id !== item.id),
        ].slice(0, MAX_ITEMS);
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  const clear = useCallback(() => persist([]), [persist]);

  return { items, record, clear };
}

/** "just now", "5m ago", "3h ago", "2d ago" — compact, for a chip. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
