import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormFieldType, FormQuestion, FormQuestionDraft } from '@pe/shared';
import { api } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { useResizableDrawer } from '../hooks/useResizableDrawer';

interface Props {
  formTemplateId: number;
  canEdit: boolean;
  canPublish: boolean;
  onClose: () => void;
}

const FIELD_TYPES: { value: FormFieldType; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'longtext', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Dropdown' },
  { value: 'radio', label: 'Radio buttons' },
  { value: 'checkbox', label: 'Checkboxes' },
];

const CHOICE_TYPES: FormFieldType[] = ['select', 'radio', 'checkbox'];

function toDraft(q: FormQuestion): FormQuestionDraft {
  return {
    sortOrder: q.sortOrder,
    questionKey: q.questionKey,
    label: q.label,
    helpText: q.helpText,
    placeholder: q.placeholder,
    fieldType: q.fieldType,
    isRequired: q.isRequired,
    options: q.options,
    maxLength: q.maxLength,
    mapsToColumn: q.mapsToColumn,
    isBuiltIn: q.isBuiltIn,
  };
}

/** A readable key for a new custom question. */
function slugKey(label: string, taken: Set<string>): string {
  const base =
    'custom_' +
    (label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'question');
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

/**
 * Form template editor.
 *
 * Always edits a *draft copy*. Saving writes a new version; publishing stamps
 * it. That is what keeps a shared link asking the questions it was shared
 * with, even after staff change the form.
 */
export function FormTemplateEditor({ formTemplateId, canEdit, canPublish, onClose }: Props) {
  const qc = useQueryClient();
  const resize = useResizableDrawer('pe.drawer.formEditor');
  useScrollLock(true);

  const [questions, setQuestions] = useState<FormQuestionDraft[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const versions = useQuery({
    queryKey: ['form', formTemplateId, 'versions'],
    queryFn: () => api.forms.versions(formTemplateId),
  });

  // Edit the newest version — usually the published one, or a draft if one
  // is already in progress.
  const currentVersionId = versions.data?.data[0]?.formTemplateVersionId ?? null;
  const currentVersion = versions.data?.data[0] ?? null;

  const version = useQuery({
    queryKey: ['form', formTemplateId, 'version', currentVersionId],
    queryFn: () => api.forms.version(formTemplateId, currentVersionId!),
    enabled: currentVersionId !== null,
  });

  useEffect(() => {
    if (!version.data) return;
    setQuestions(version.data.questions.map(toDraft));
    setSelected(version.data.questions[0]?.formQuestionId ?? 0);
    setDirty(false);
  }, [version.data]);

  const save = useMutation({
    mutationFn: () => api.forms.saveDraft(formTemplateId, questions),
    onSuccess: (r) => {
      setNotice(`Saved as v${(currentVersion?.versionNumber ?? 0) + 1} (draft).`);
      setError(null);
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['form', formTemplateId] });
      qc.invalidateQueries({ queryKey: ['forms'] });
      setSelected(r.formTemplateVersionId);
    },
    onError: (e: Error) => setError(e.message),
  });

  const publish = useMutation({
    mutationFn: (versionId: number) => api.forms.publish(formTemplateId, versionId),
    onSuccess: () => {
      setNotice('Published.');
      setError(null);
      qc.invalidateQueries({ queryKey: ['form', formTemplateId] });
      qc.invalidateQueries({ queryKey: ['forms'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const takenKeys = useMemo(() => new Set(questions.map((q) => q.questionKey)), [questions]);
  const active = selected !== null ? questions[selected] : undefined;

  function patch(index: number, changes: Partial<FormQuestionDraft>) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...changes } : q)));
    setDirty(true);
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= questions.length) return;
    setQuestions((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(to, 0, item!);
      return next.map((q, i) => ({ ...q, sortOrder: i + 1 }));
    });
    setSelected(to);
    setDirty(true);
  }

  function addQuestion() {
    const key = slugKey('new question', takenKeys);
    setQuestions((prev) => [
      ...prev,
      {
        sortOrder: prev.length + 1,
        questionKey: key,
        label: 'New question',
        helpText: null,
        placeholder: null,
        fieldType: 'text',
        isRequired: false,
        options: [],
        maxLength: 255,
        mapsToColumn: null,
        isBuiltIn: false,
      },
    ]);
    setSelected(questions.length);
    setDirty(true);
  }

  function removeQuestion(index: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== index).map((q, i) => ({ ...q, sortOrder: i + 1 })));
    setSelected(null);
    setDirty(true);
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer drawer-wide"
        role="dialog"
        aria-label="Form editor"
        style={resize.drawerStyle}
      >
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2>Form editor</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="form-editor-bar">
          <span className="form-editor-version">
            {currentVersion
              ? `v${currentVersion.versionNumber}${currentVersion.publishedAt ? ' · published' : ' · draft'}`
              : 'Loading…'}
          </span>
          {dirty && <span className="form-editor-dirty">Unsaved changes</span>}
          <span style={{ flex: 1 }} />
          {canEdit && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => save.mutate()}
              disabled={save.isPending || questions.length === 0}
            >
              {save.isPending ? 'Saving…' : 'Save draft'}
            </button>
          )}
          {canPublish && currentVersionId !== null && !currentVersion?.publishedAt && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => publish.mutate(currentVersionId)}
              disabled={publish.isPending}
            >
              {publish.isPending ? 'Publishing…' : 'Publish'}
            </button>
          )}
        </div>

        {notice && (
          <div className="alert alert-info" role="status" style={{ margin: '0 22px 12px' }}>
            <span>{notice}</span>
          </div>
        )}
        {error && (
          <div className="alert alert-error" role="alert" style={{ margin: '0 22px 12px' }}>
            <span>{error}</span>
          </div>
        )}

        <div className="form-editor-body">
          <div className="form-editor-list">
            <div className="form-editor-list-head">
              <span>Questions</span>
              {canEdit && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={addQuestion}>
                  + Add
                </button>
              )}
            </div>

            {version.isLoading ? (
              <div className="skeleton" style={{ height: 120, margin: 12 }} />
            ) : (
              <ul>
                {questions.map((q, i) => (
                  <li key={`${q.questionKey}-${i}`} className={selected === i ? 'is-active' : ''}>
                    <button type="button" className="form-q-row" onClick={() => setSelected(i)}>
                      <span className="form-q-label">
                        {q.isBuiltIn && <span className="form-q-lock" title="Built-in field">🔒</span>}
                        {q.label}
                      </span>
                      <span className="form-q-meta">
                        {q.fieldType}
                        {q.isRequired ? ' · required' : ''}
                      </span>
                    </button>
                    {canEdit && (
                      <span className="form-q-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => move(i, -1)}
                          disabled={i === 0}
                          aria-label={`Move ${q.label} up`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => move(i, 1)}
                          disabled={i === questions.length - 1}
                          aria-label={`Move ${q.label} down`}
                        >
                          ↓
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="form-editor-detail">
            {!active ? (
              <p className="tab-empty">Select a question to edit it.</p>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="q-label">Label</label>
                  <input
                    id="q-label"
                    className="input"
                    value={active.label}
                    maxLength={200}
                    disabled={!canEdit}
                    onChange={(e) => patch(selected!, { label: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor="q-help">Help text</label>
                  <input
                    id="q-help"
                    className="input"
                    value={active.helpText ?? ''}
                    maxLength={300}
                    disabled={!canEdit}
                    placeholder="Shown under the input, stays visible while typing"
                    onChange={(e) => patch(selected!, { helpText: e.target.value || null })}
                  />
                </div>

                <div className="field">
                  <label htmlFor="q-ph">Placeholder</label>
                  <input
                    id="q-ph"
                    className="input"
                    value={active.placeholder ?? ''}
                    maxLength={100}
                    disabled={!canEdit || CHOICE_TYPES.includes(active.fieldType)}
                    placeholder="Grey hint inside the empty input"
                    onChange={(e) => patch(selected!, { placeholder: e.target.value || null })}
                  />
                  {CHOICE_TYPES.includes(active.fieldType) && (
                    <span className="field-hint">Not used for choice fields.</span>
                  )}
                </div>

                <div className="field">
                  <label htmlFor="q-type">Field type</label>
                  <select
                    id="q-type"
                    className="input"
                    value={active.fieldType}
                    disabled={!canEdit || active.isBuiltIn}
                    onChange={(e) =>
                      patch(selected!, { fieldType: e.target.value as FormFieldType })
                    }
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  {active.isBuiltIn && (
                    <span className="field-hint">Built-in fields keep their type.</span>
                  )}
                </div>

                {CHOICE_TYPES.includes(active.fieldType) && !active.mapsToColumn && (
                  <div className="field">
                    <label htmlFor="q-opts">Options (one per line)</label>
                    <textarea
                      id="q-opts"
                      className="input"
                      rows={4}
                      disabled={!canEdit}
                      value={active.options.join('\n')}
                      onChange={(e) =>
                        patch(selected!, {
                          options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                        })
                      }
                    />
                  </div>
                )}

                <label className="form-q-check">
                  <input
                    type="checkbox"
                    checked={active.isRequired}
                    disabled={
                      !canEdit ||
                      (active.isBuiltIn &&
                        ['firstName', 'lastName', 'email'].includes(active.questionKey))
                    }
                    onChange={(e) => patch(selected!, { isRequired: e.target.checked })}
                  />
                  <span>This question is required</span>
                </label>

                {canEdit && !active.isBuiltIn && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeQuestion(selected!)}
                  >
                    Remove question
                  </button>
                )}

                <div className="form-q-preview">
                  <span className="form-q-preview-title">Preview</span>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>
                      {active.label || '(no label)'}
                      {!active.isRequired && (
                        <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}> (optional)</span>
                      )}
                    </label>
                    <input
                      className="input"
                      disabled
                      placeholder={active.placeholder ?? ''}
                      value=""
                      readOnly
                    />
                    {active.helpText && <span className="field-hint">{active.helpText}</span>}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
