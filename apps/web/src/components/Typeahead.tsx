import { useEffect, useRef, useState } from 'react';

/**
 * Search-as-you-type picker over a server-side lookup.
 *
 * Extracted from the registration drawer so every screen that picks a
 * participant or workshop behaves the same: type two characters, choose a row,
 * and the chosen label stays visible with a clear button.
 */
export function Typeahead({
  id,
  label,
  placeholder,
  value,
  selectedLabel,
  onSelect,
  search,
  required,
  error,
  disabled,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  selectedLabel: string | null;
  onSelect: (id: number, label: string) => void;
  search: (q: string) => Promise<{ data: { id: number; label: string }[] }>;
  required?: boolean;
  error?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ id: number; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setOptions([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const t = setTimeout(() => {
      search(query)
        .then((r) => {
          if (!cancelled) setOptions(r.data);
        })
        .catch(() => {
          if (!cancelled) setOptions([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open, search]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="field" ref={boxRef} style={{ position: 'relative' }}>
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>

      {value && selectedLabel ? (
        <div className="typeahead-selected">
          <span>{selectedLabel}</span>
          <button
            type="button"
            className="typeahead-clear"
            onClick={() => {
              onSelect(0, '');
              setQuery('');
            }}
            disabled={disabled}
            aria-label={`Clear ${label}`}
          >
            ×
          </button>
        </div>
      ) : (
        <input
          id={id}
          type="search"
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          aria-invalid={error ? 'true' : undefined}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          role="combobox"
        />
      )}

      {open && !value && query.trim().length >= 2 && (
        <ul className="typeahead-list" id={`${id}-list`} role="listbox">
          {loading && <li className="typeahead-empty">Searching…</li>}
          {!loading && options.length === 0 && (
            <li className="typeahead-empty">No matches</li>
          )}
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => {
                  onSelect(o.id, o.label);
                  setOpen(false);
                  setQuery('');
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}
