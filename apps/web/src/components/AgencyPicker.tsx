import { useEffect, useState } from 'react';
import { api } from '../api';

interface Props {
  id: string;
  value: number | null;
  label: string;
  onChange: (id: number | null, label: string) => void;
  disabled?: boolean;
  placeholder?: string;
  describedBy?: string;
}

/**
 * Type-ahead picker over the live school/agency list.
 *
 * Used by the built-in "School or agency" question and by any custom question
 * whose field type is `agency`. The choices come from `core.Agency`, so this
 * is a search box rather than a `<select>` — there are 812 agencies and a
 * plain dropdown is unusable on a phone.
 */
export function AgencyPicker({
  id,
  value,
  label,
  onChange,
  disabled,
  placeholder = 'Start typing your school…',
  describedBy,
}: Props) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<{ id: number; label: string }[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.publicRegistration
        .agencies(query)
        .then((r) => !cancelled && setOptions(r.data))
        .catch(() => !cancelled && setOptions([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  if (value) {
    return (
      <div className="typeahead-selected">
        <span>{label}</span>
        <button
          type="button"
          className="typeahead-clear"
          onClick={() => {
            onChange(null, '');
            setQuery('');
          }}
          disabled={disabled}
          aria-label={`Clear ${label}`}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        type="search"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        disabled={disabled}
        aria-describedby={describedBy}
      />
      {options.length > 0 && (
        <ul className="typeahead-list" role="listbox">
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => {
                  onChange(o.id, o.label);
                  setOptions([]);
                  setQuery('');
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
