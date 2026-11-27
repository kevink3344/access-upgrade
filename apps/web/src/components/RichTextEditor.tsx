import { useCallback, useEffect, useRef } from 'react';
import { isHelpHtmlEmpty, sanitizeHelpHtml } from '@pe/shared';

/**
 * A small rich-text editor for a question's help text.
 *
 * A `contentEditable` element with an explicit toolbar, rather than a
 * dependency: the allowed markup is a fixed, tiny subset (bold, italic,
 * underline, lists, links, line breaks), and `document.execCommand` covers
 * exactly that in every browser this app supports. Anything the browser
 * produces that is not in the subset is stripped on the way out.
 *
 * The value is HTML. It is sanitised on every change, so what the parent
 * holds is always safe to store and to render.
 */
export function RichTextEditor({
  id,
  value,
  onChange,
  disabled = false,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** Guards against the caret jumping when we write the value back. */
  const lastEmitted = useRef<string>(value);

  // Only touch the DOM when the value changed from outside the editor —
  // re-setting innerHTML on every keystroke would reset the caret.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value === lastEmitted.current) return;
    el.innerHTML = value;
    lastEmitted.current = value;
  }, [value]);

  const emit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const clean = sanitizeHelpHtml(el.innerHTML);
    lastEmitted.current = clean;
    onChange(clean);
  }, [onChange]);

  function exec(command: string, arg?: string) {
    if (disabled) return;
    ref.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  }

  function addLink() {
    if (disabled) return;
    const href = window.prompt('Link address (https://…)');
    if (!href) return;
    exec('createLink', href);
  }

  const empty = isHelpHtmlEmpty(value);

  return (
    <div className={`rich-editor${disabled ? ' is-disabled' : ''}`}>
      <div className="rich-editor-toolbar" role="toolbar" aria-label="Formatting" aria-controls={id}>
        <button type="button" className="rich-btn" title="Bold" aria-label="Bold" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}>
          <b>B</b>
        </button>
        <button type="button" className="rich-btn" title="Italic" aria-label="Italic" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}>
          <i>I</i>
        </button>
        <button type="button" className="rich-btn" title="Underline" aria-label="Underline" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')}>
          <u>U</u>
        </button>
        <span className="rich-sep" aria-hidden="true" />
        <button type="button" className="rich-btn" title="Bulleted list" aria-label="Bulleted list" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertUnorderedList')}>
          •≡
        </button>
        <button type="button" className="rich-btn" title="Numbered list" aria-label="Numbered list" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertOrderedList')}>
          1≡
        </button>
        <span className="rich-sep" aria-hidden="true" />
        <button type="button" className="rich-btn" title="Link" aria-label="Insert link" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={addLink}>
          🔗
        </button>
        <button type="button" className="rich-btn" title="Remove formatting" aria-label="Remove formatting" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('removeFormat')}>
          ⌫
        </button>
      </div>

      <div
        id={id}
        ref={ref}
        className="rich-editor-area"
        contentEditable={!disabled}
        role="textbox"
        aria-multiline="true"
        aria-label="Help text"
        data-placeholder={placeholder ?? ''}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onPaste={(e) => {
          // Paste as plain text: pasting a whole web page would otherwise
          // bring its markup (and its styles) into the stored value.
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          document.execCommand('insertText', false, text);
          emit();
        }}
      />

      {empty && <span className="rich-editor-placeholder" aria-hidden="true">{placeholder}</span>}
    </div>
  );
}
