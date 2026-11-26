import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FormFieldType,
  FormPageDraft,
  FormQuestion,
  FormQuestionDraft,
  FormTemplateKind,
} from '@pe/shared';
import { api } from '../api';
import { FormLinkPanel } from './FormLinkPanel';

interface Props {
  formTemplateId: number;
  canEdit: boolean;
  canPublish: boolean;
  onBack: () => void;
}

const FIELD_TYPES: { value: FormFieldType; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'longtext', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Dropdown (your own options)' },
  { value: 'radio', label: 'Radio buttons' },
  { value: 'checkbox', label: 'Checkboxes' },
  { value: 'agency', label: 'School or Agency (from the school list)' },
  { value: 'session', label: "The workshop's sessions (from its Sessions tab)" },
];

const CHOICE_TYPES: FormFieldType[] = ['select', 'radio', 'checkbox'];

/**
 * Fields the public page renders from its own hard-coded inputs, so removing
 * one would silently drop it from the form and fail the submission.
 *
 * A registration form always asks these; a training request form asks its own
 * fields instead, so only the registration set is locked.
 */
const REQUIRED_KEYS = new Set(['registrantRole', 'firstName', 'lastName', 'email', 'phone', 'agency']);

function isRemovable(q: { questionKey: string }, kind: FormTemplateKind): boolean {
  if (kind === 'trainingRequest') return true;
  return !REQUIRED_KEYS.has(q.questionKey);
}

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
    branchOnQuestionKey: q.branchOnQuestionKey,
    branchOptionValue: q.branchOptionValue,
    pageKey: q.pageId !== null ? String(q.pageId) : null,
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
export function FormTemplateEditor({ formTemplateId, canEdit, canPublish, onBack }: Props) {
  const qc = useQueryClient();

  const [questions, setQuestions] = useState<FormQuestionDraft[]>([]);
  const [pages, setPages] = useState<FormPageDraft[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const versions = useQuery({
    queryKey: ['form', formTemplateId, 'versions'],
    queryFn: () => api.forms.versions(formTemplateId),
  });

  const templates = useQuery({
    queryKey: ['forms'],
    queryFn: () => api.forms.list(),
    staleTime: 60_000,
  });

  const templateName = templates.data?.data.find(
    (t) => t.formTemplateId === formTemplateId,
  )?.name;
  const templateKind =
    templates.data?.data.find((t) => t.formTemplateId === formTemplateId)?.kind ?? 'registration';

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
    setPages(
      version.data.pages.map((p) => ({
        key: String(p.formPageId),
        title: p.title,
        subtitle: p.subtitle,
      })),
    );
    // `selected` is an ARRAY INDEX, not a question id — open on the first
    // question so staff land straight in the editor.
    setSelected(version.data.questions.length > 0 ? 0 : null);
    setDirty(false);
  }, [version.data]);

  const save = useMutation({
    mutationFn: () =>
      api.forms.saveDraft(
        formTemplateId,
        // The options box keeps what was typed, including blank lines, so the
        // caret can move between options. Tidy them here, once, rather than on
        // every keystroke.
        questions.map((q) => ({
          ...q,
          options: q.options.map((s) => s.trim()).filter(Boolean),
        })),
        pages,
      ),
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

  /** Patch from the current value, for changes derived from what is there. */
  function patchWith(index: number, fn: (q: FormQuestionDraft) => Partial<FormQuestionDraft>) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...fn(q) } : q)));
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

  /* ---------------- pages ---------------- */

  function addPage() {
    const key = `page_${Date.now().toString(36)}`;
    setPages((prev) => [
      ...prev,
      { key, title: `Page ${prev.length + 1}`, subtitle: null },
    ]);
    setDirty(true);
  }

  function patchPage(key: string, changes: Partial<FormPageDraft>) {
    setPages((prev) => prev.map((p) => (p.key === key ? { ...p, ...changes } : p)));
    setDirty(true);
  }

  function movePage(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= pages.length) return;
    setPages((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(to, 0, item!);
      return next;
    });
    setDirty(true);
  }

  /**
   * Removing a page keeps its questions: they move to the next page, or back
   * to the page-less form when that was the only page. Deleting questions
   * would be a surprising side effect of tidying up a page.
   */
  function removePage(index: number) {
    const removed = pages[index]!;
    const fallback = pages[index + 1]?.key ?? pages[index - 1]?.key ?? null;
    setPages((prev) => prev.filter((_, i) => i !== index));
    setQuestions((prev) =>
      prev.map((q) => (q.pageKey === removed.key ? { ...q, pageKey: fallback } : q)),
    );
    setDirty(true);
  }

  /** Move a question onto a page, keeping the overall question order. */
  function moveToPage(index: number, pageKey: string | null) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, pageKey } : q)));
    setDirty(true);
  }

  /** Questions grouped for the list: each page in order, then the unassigned. */
  const groups: { page: FormPageDraft | null; items: { q: FormQuestionDraft; index: number }[] }[] = [
    ...pages.map((page) => ({
      page,
      items: questions
        .map((q, index) => ({ q, index }))
        .filter((x) => x.q.pageKey === page.key),
    })),
    {
      page: null,
      items: questions
        .map((q, index) => ({ q, index }))
        .filter((x) => !x.q.pageKey || !pages.some((p) => p.key === x.q.pageKey)),
    },
  ].filter((g) => g.page !== null || g.items.length > 0);

  /** The list is flat for ↑/↓, so a row's neighbours are its group's. */
  function moveWithinGroup(groupIndex: number, itemIndex: number, delta: number) {
    const items = groups[groupIndex]!.items;
    const a = items[itemIndex]?.index;
    const b = items[itemIndex + delta]?.index;
    if (a === undefined || b === undefined) return;
    setQuestions((prev) => {
      const next = [...prev];
      const [item] = next.splice(a, 1);
      next.splice(b, 0, item!);
      return next.map((q, i) => ({ ...q, sortOrder: i + 1 }));
    });
    setSelected(b);
    setDirty(true);
  }

  return (
    <div className="form-editor-page">
      <div className="page-head">
        <div>
          <button type="button" className="linklike" onClick={onBack} style={{ fontSize: 12.5 }}>
            ← All forms
          </button>
          <h2 style={{ marginTop: 4 }}>{templateName ?? 'Form editor'}</h2>
          <p>
            {currentVersion
              ? `Version ${currentVersion.versionNumber}${currentVersion.publishedAt ? ' · published' : ' · draft'}`
              : 'Loading…'}
            {dirty && <span className="form-editor-dirty" style={{ marginLeft: 8 }}>Unsaved changes</span>}
          </p>
          {templateKind === 'trainingRequest' && (
            <FormLinkPanel formTemplateId={formTemplateId} canEdit={!!canEdit} />
          )}
        </div>
        <div className="row-actions">
          {canEdit && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => save.mutate()}
              disabled={save.isPending || questions.length === 0}
            >
              {save.isPending ? 'Saving…' : 'Save draft'}
            </button>
          )}
          {canPublish && currentVersionId !== null && !currentVersion?.publishedAt && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => publish.mutate(currentVersionId)}
              disabled={publish.isPending}
            >
              {publish.isPending ? 'Publishing…' : 'Publish'}
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className="alert alert-info" role="status">
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="form-editor-page-body">
        <div className="form-editor-list">
            <div className="form-editor-list-head">
              <span>{pages.length > 0 ? 'Pages & questions' : 'Questions'}</span>
              {canEdit && (
                <span className="row-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={addPage}>
                    + Page
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={addQuestion}>
                    + Add
                  </button>
                </span>
              )}
            </div>

            {version.isLoading ? (
              <div className="skeleton" style={{ height: 120, margin: 12 }} />
            ) : (
              <ul>
                {groups.map((group, gi) => (
                  <li key={group.page?.key ?? '__none'} className="form-page-group">
                    {group.page ? (
                      <div className="form-page-head">
                        <span className="form-page-index">
                          Page {pages.findIndex((p) => p.key === group.page!.key) + 1}
                        </span>
                        <input
                          className="form-page-title"
                          value={group.page.title}
                          maxLength={100}
                          disabled={!canEdit}
                          aria-label="Page title"
                          onChange={(e) => patchPage(group.page!.key, { title: e.target.value })}
                        />
                        {canEdit && (
                          <span className="form-q-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => movePage(gi, -1)}
                              disabled={gi === 0}
                              aria-label={`Move page ${group.page.title} up`}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => movePage(gi, 1)}
                              disabled={gi >= pages.length - 1}
                              aria-label={`Move page ${group.page.title} down`}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => removePage(gi)}
                              aria-label={`Remove page ${group.page.title}`}
                              title="Remove page (its questions move to the next page)"
                            >
                              ✕
                            </button>
                          </span>
                        )}
                      </div>
                    ) : (
                      pages.length > 0 && (
                        <div className="form-page-head form-page-head--none">
                          <span className="form-page-index">Not on a page</span>
                        </div>
                      )
                    )}

                    {group.items.length === 0 ? (
                      <p className="form-page-empty">
                        No questions on this page yet. Select a question and set its page below.
                      </p>
                    ) : (
                      <ul>
                        {group.items.map(({ q, index }, ii) => (
                          <li key={`${q.questionKey}-${index}`} className={selected === index ? 'is-active' : ''}>
                            <button type="button" className="form-q-row" onClick={() => setSelected(index)}>
                              <span className="form-q-label">
                                {q.isBuiltIn && !isRemovable(q, templateKind) && (
                                  <span className="form-q-lock" title="Required by the public form">🔒</span>
                                )}
                                {q.label}
                              </span>
                              <span className="form-q-meta">
                                {q.fieldType}
                                {q.isRequired ? ' · required' : ''}
                                {q.branchOnQuestionKey && (
                                  <span className="form-q-branch">
                                    {' · only if '}
                                    {questions.find((x) => x.questionKey === q.branchOnQuestionKey)?.label ??
                                      q.branchOnQuestionKey}
                                    {' = '}
                                    {q.branchOptionValue}
                                  </span>
                                )}
                              </span>
                            </button>
                            {canEdit && (
                              <span className="form-q-actions">
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => moveWithinGroup(gi, ii, -1)}
                                  disabled={ii === 0}
                                  aria-label={`Move ${q.label} up`}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => moveWithinGroup(gi, ii, 1)}
                                  disabled={ii === group.items.length - 1}
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
                  {active.fieldType === 'agency' && (
                    <span className="field-hint">
                      The school picker supplies its own placeholder.
                    </span>
                  )}
                  {active.fieldType === 'session' && (
                    <span className="field-hint">
                      The options come from the workshop's Sessions tab when the form is shown.
                    </span>
                  )}
                </div>

                <div className="field">
                  <label htmlFor="q-page">Page</label>
                  <select
                    id="q-page"
                    className="input"
                    value={active.pageKey ?? ''}
                    disabled={!canEdit || pages.length === 0}
                    onChange={(e) => moveToPage(selected!, e.target.value || null)}
                  >
                    <option value="">{pages.length === 0 ? 'No pages on this form' : 'Not on a page'}</option>
                    {pages.map((p, i) => (
                      <option key={p.key} value={p.key}>
                        {i + 1}. {p.title || '(untitled page)'}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    {pages.length === 0
                      ? 'Add a page to split a long form into steps.'
                      : 'Visitors reach this question by pressing Next through the earlier pages.'}
                  </span>
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
                      // The raw text is what the visitor is typing, blank lines
                      // and all. Filtering empty lines here would delete the
                      // newline the moment it is typed, so Enter could never
                      // start a second option. The list is tidied on save.
                      value={active.options.join('\n')}
                      onChange={(e) =>
                        patch(selected!, { options: e.target.value.split('\n') })
                      }
                      onBlur={() =>
                        patchWith(selected!, (q) => ({
                          options: q.options.map((s) => s.trim()).filter(Boolean),
                        }))
                      }
                    />
                    <span className="field-hint">
                      Press Enter after each option. Blank lines are ignored when you save.
                    </span>
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

                {/* Branching: show this question only when another question's
                    answer matches. The built-in form uses this for the
                    Educator / Parent split. */}
                <fieldset className="form-branch">
                  <legend>Show this question</legend>

                  <div className="field" style={{ marginBottom: 8 }}>
                    <label htmlFor="q-branch-on">Only when</label>
                    <select
                      id="q-branch-on"
                      className="input"
                      value={active.branchOnQuestionKey ?? ''}
                      disabled={!canEdit}
                      onChange={(e) => {
                        const key = e.target.value || null;
                        const parent = questions.find((x) => x.questionKey === key);
                        patch(selected!, {
                          branchOnQuestionKey: key,
                          // Default to the parent's first option so the pair is
                          // never half-set.
                          branchOptionValue: key ? (parent?.options[0] ?? null) : null,
                        });
                      }}
                    >
                      <option value="">Always shown</option>
                      {questions
                        .filter((x) => x.questionKey !== active.questionKey && x.options.length > 0)
                        .map((x) => (
                          <option key={x.questionKey} value={x.questionKey}>
                            {x.label}
                          </option>
                        ))}
                    </select>
                  </div>

                  {active.branchOnQuestionKey && (
                    <div className="field" style={{ marginBottom: 8 }}>
                      <label htmlFor="q-branch-value">…is set to</label>
                      <select
                        id="q-branch-value"
                        className="input"
                        value={active.branchOptionValue ?? ''}
                        disabled={!canEdit}
                        onChange={(e) =>
                          patch(selected!, { branchOptionValue: e.target.value || null })
                        }
                      >
                        {(questions.find((x) => x.questionKey === active.branchOnQuestionKey)
                          ?.options ?? []
                        ).map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </fieldset>

                {canEdit && isRemovable(active, templateKind) && (
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
    </div>
  );
}
