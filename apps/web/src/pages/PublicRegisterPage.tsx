import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { FormPage, FormQuestion, PublicLinkState } from '@pe/shared';
import { api, HttpError } from '../api';
import { AgencyPicker } from '../components/AgencyPicker';

const schema = z.object({
  registrantRole: z.enum(['Educator', 'Parent/caregiver'], {
    message: 'Select whether you are an educator or a parent/caregiver',
  }),
  firstName: z.string({ required_error: 'First name is required' }).min(1, 'First name is required').max(30),
  lastName: z.string({ required_error: 'Last name is required' }).min(1, 'Last name is required').max(30),
  email: z
    .string({ required_error: 'Email is required' })
    .min(1, 'Email is required')
    .email('Enter a valid email address'),
  phone: z.string().max(15).optional(),
  classAges: z.string().max(255).optional(),
  childrenAges: z.string().max(255).optional(),
  secondCaregiverInfo: z.string().max(2000).optional(),
  notes: z.string().max(255).optional(),
});

const ROLES = ['Educator', 'Parent/caregiver'] as const;

/** Visible required marker. The asterisk is hidden from screen readers,
 *  which get the requirement from the input's `required` attribute. */
function Req() {
  return (
    <>
      <span aria-hidden="true" style={{ color: 'var(--cc-fifth-color)' }}>*</span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

type Role = (typeof ROLES)[number];

type Errors = Record<string, string>;

/**
 * One custom question, rendered from the pinned form version.
 *
 * Shared by the registration and training-request forms so a field type only
 * has to be implemented once. `includeSession` is the one difference: a
 * session picker needs a workshop, and only a registration link has one.
 */
function QuestionField({
  q,
  value,
  err,
  agencyLabel,
  sessions,
  includeSession,
  onChange,
  onAgencyLabel,
}: {
  q: FormQuestion;
  value: string | string[] | undefined;
  err: string | undefined;
  agencyLabel: string;
  sessions: { workshopSessionId: number; label: string }[];
  includeSession: boolean;
  onChange: (v: string | string[]) => void;
  onAgencyLabel: (label: string) => void;
}) {
  const describedBy = q.helpText ? `q-${q.questionKey}-help` : undefined;

  return (
    <div className="field">
      <label htmlFor={`q-${q.questionKey}`}>
        {q.label}
        {q.isRequired ? (
          <Req />
        ) : (
          <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}> (optional)</span>
        )}
      </label>

      {q.fieldType === 'agency' ? (
        <AgencyPicker
          id={`q-${q.questionKey}`}
          value={typeof value === 'string' && value ? Number(value) : null}
          label={agencyLabel}
          onChange={(id, lbl) => {
            onChange(id === null ? '' : String(id));
            onAgencyLabel(lbl);
          }}
          describedBy={describedBy}
        />
      ) : q.fieldType === 'longtext' ? (
        <textarea
          id={`q-${q.questionKey}`}
          rows={3}
          maxLength={q.maxLength ?? 2000}
          placeholder={q.placeholder ?? ''}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={!!err}
          aria-required={q.isRequired}
        />
      ) : q.fieldType === 'select' ? (
        <select
          id={`q-${q.questionKey}`}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={!!err}
          aria-required={q.isRequired}
        >
          <option value="">Select…</option>
          {q.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      ) : q.fieldType === 'session' && includeSession ? (
        <select
          id={`q-${q.questionKey}`}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={!!err}
          aria-required={q.isRequired}
        >
          <option value="">Select a session…</option>
          {sessions.map((s) => (
            <option key={s.workshopSessionId} value={s.label}>
              {s.label}
            </option>
          ))}
        </select>
      ) : q.fieldType === 'radio' ? (
        <div className="q-choices" role="radiogroup" aria-required={q.isRequired}>
          {q.options.map((o) => (
            <label key={o} className="q-choice">
              <input
                type="radio"
                name={`q-${q.questionKey}`}
                value={o}
                checked={value === o}
                onChange={() => onChange(o)}
              />
              <span>{o}</span>
            </label>
          ))}
        </div>
      ) : q.fieldType === 'checkbox' ? (
        <div className="q-choices">
          {q.options.map((o) => {
            const list = Array.isArray(value) ? value : [];
            return (
              <label key={o} className="q-choice">
                <input
                  type="checkbox"
                  value={o}
                  checked={list.includes(o)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o))
                  }
                />
                <span>{o}</span>
              </label>
            );
          })}
        </div>
      ) : (
        <input
          id={`q-${q.questionKey}`}
          type={q.fieldType === 'number' ? 'number' : 'text'}
          maxLength={q.maxLength ?? 255}
          placeholder={q.placeholder ?? ''}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={!!err}
          aria-required={q.isRequired}
        />
      )}

      {q.helpText && (
        <span className="field-hint" id={`q-${q.questionKey}-help`}>
          {q.helpText}
        </span>
      )}
      {err && <span className="error" role="alert">{err}</span>}
    </div>
  );
}

/**
 * The step indicator above a paginated form.
 *
 * Rendered as a list of step names with the current one marked, so a visitor
 * can see how much is left before they start. Steps already passed are
 * buttons: going back is always safe, and a mistyped answer is usually
 * noticed on the way to the next page.
 */
function FormSteps({
  pages,
  current,
  onGoTo,
}: {
  pages: FormPage[];
  current: number;
  onGoTo: (index: number) => void;
}) {
  return (
    <ol className="form-steps" aria-label="Form progress">
      {pages.map((p, i) => {
        const state = i === current ? 'is-current' : i < current ? 'is-done' : '';
        return (
          <li key={p.formPageId} className={state}>
            {i < current ? (
              <button type="button" onClick={() => onGoTo(i)}>
                <span aria-hidden="true">✓</span> {p.title}
              </button>
            ) : (
              <span aria-current={i === current ? 'step' : undefined}>
                <span className="form-step-num" aria-hidden="true">{i + 1}</span>
                <span className="form-step-title">{p.title}</span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'â€”';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtTime(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const suffix = (h ?? 0) >= 12 ? 'PM' : 'AM';
  const hour = (h ?? 0) % 12 || 12;
  return `${hour}:${String(m ?? 0).padStart(2, '0')} ${suffix}`;
}

/**
 * The Project Enlightenment lockup that sits at the top of every public card.
 *
 * Rendered inside the card rather than as a page banner, so the logo and the
 * workshop title share one surface instead of being split by a colour band.
 */
function PublicBrand({ subtitle = 'Workshop Registration' }: { subtitle?: string }) {
  return (
    <div className="public-brand">
      <img
        className="public-mark"
        src="/images/sunburst-logo.png"
        alt=""
        aria-hidden="true"
        width={52}
        height={46}
      />
      <span className="public-brand-text">
        <b>Project Enlightenment</b>
        <small>{subtitle}</small>
      </span>
    </div>
  );
}

/**
 * Every public state â€” the form, the "full" screen, the confirmation â€” renders
 * through here, so the tab title is set once for all of them. Without this the
 * page inherits the staff app's title from index.html, which is wrong for a
 * family who has never seen the staff app.
 */
function PublicChrome({ children, title = 'Project Enlightenment - Workshop Registration' }: { children: React.ReactNode; title?: string }) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);

  return (
    <div className="public-page">
      <main className="public-main">{children}</main>
      <p className="public-foot">
        Wake County Public School System Â· Project Enlightenment
      </p>
    </div>
  );
}

function Terminal({ title, message }: { title: string; message: string }) {
  return (
    <PublicChrome>
      <div className="public-card public-terminal">
        <PublicBrand />
        <div className="icon-wrap" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
        <h1>{title}</h1>
        <p>{message}</p>
      </div>
    </PublicChrome>
  );
}

export function PublicRegisterPage({ slug }: { slug: string }) {
  const mountedAt = useRef(Date.now());
  const [form, setForm] = useState<Record<string, string>>({});
  const [agencyId, setAgencyId] = useState<number | null>(null);
  const [agencyLabel, setAgencyLabel] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  /** Honeypot â€” a real person never fills this. */
  const [website, setWebsite] = useState('');
  /** Custom answers keyed by QuestionKey, for links pinned to a form version. */
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  /** Labels for custom `agency` questions, keyed by QuestionKey. */
  const [agencyLabels, setAgencyLabels] = useState<Record<string, string>>({});
  /** Which page of a paginated form is showing. 0 = the first page. */
  const [pageIndex, setPageIndex] = useState(0);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['public-link', slug],
    queryFn: () => api.publicRegistration.resolve(slug),
    retry: false,
  });

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /**
   * Pagination. A version is shown a page at a time only when it has more
   * than one page: a single page (or none) is the ordinary continuous form,
   * so an older link that never used pages behaves exactly as before.
   */
  const formPages = data?.form?.pages ?? [];
  const paged = formPages.length > 1;
  /** The page being shown, or null for the continuous form. */
  const currentPage = paged ? (formPages[pageIndex] ?? formPages[0]!) : null;

  /**
   * The questions to render.
   *
   * A registration form skips the ones with a `mapsToColumn` because the page
   * renders those itself. A standalone form has no such block, so it renders
   * every question on the version.
   *
   * On a paginated form only the current page's questions are returned. The
   * built-in block is page 0, so the first page holds those plus any custom
   * questions assigned to it.
   */
  function visibleQuestions(includeMapped = false) {
    return (data?.form?.questions ?? [])
      .filter((q) => includeMapped || !q.mapsToColumn)
      .filter((q) => {
        if (!paged) return true;
        const onPage =
          q.pageId === null ? pageIndex === 0 : q.pageId === currentPage?.formPageId;
        return onPage;
      })
      .filter((q) => {
        if (!q.branchOnQuestionKey) return true;
        const gate = answers[q.branchOnQuestionKey];
        return typeof gate === 'string' && gate === q.branchOptionValue;
      });
  }

  /** Page 0 of a registration form is the built-in name/agency block. */
  const showsBuiltIn = !paged || pageIndex === 0;
  const isLastPage = !paged || pageIndex >= formPages.length - 1;

  /**
   * Validate the current page before letting the visitor continue.
   *
   * Only this page's questions are checked — a required field two pages ahead
   * must not block Next here. `checkBuiltIn` is set by the registration form,
   * whose name/agency block is page 0; the training-request form has none.
   * Errors are returned rather than set, so the caller can decide whether to
   * stop or submit.
   */
  function validatePage(checkBuiltIn: boolean): { builtIn: Errors; answers: Record<string, string> } {
    const builtIn: Errors = {};
    const answerErrs: Record<string, string> = {};

    if (checkBuiltIn && showsBuiltIn) {
      const parsed = schema.safeParse(form);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const key = issue.path[0] as string;
          if (!builtIn[key]) builtIn[key] = issue.message;
        }
      }
    }

    for (const q of visibleQuestions()) {
      if (!q.isRequired) continue;
      const v = answers[q.questionKey];
      if (!v || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && !v.trim())) {
        answerErrs[q.questionKey] = `${q.label} is required`;
      }
    }

    return { builtIn, answers: answerErrs };
  }

  /** Next: check this page, then move on. The form is only sent at the end. */
  function goNext(checkBuiltIn: boolean) {
    const { builtIn, answers: answerErrs } = validatePage(checkBuiltIn);
    setErrors(builtIn);
    setAnswerErrors(answerErrs);
    if (Object.keys(builtIn).length > 0 || Object.keys(answerErrs).length > 0) {
      // Bring the first problem into view rather than leaving the visitor
      // hunting for it above the fold.
      requestAnimationFrame(() => {
        document.querySelector('.public-form .error')?.scrollIntoView({ block: 'center' });
      });
      return;
    }
    setPageIndex((i) => Math.min(i + 1, formPages.length - 1));
    window.scrollTo({ top: 0 });
  }

  function goBack() {
    setPageIndex((i) => Math.max(i - 1, 0));
    window.scrollTo({ top: 0 });
  }

  /**
   * A standalone form asks only its own questions â€” there is no registrant
   * role, name or agency block, because nothing is being registered.
   */
  async function onSubmitStandalone(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    // Every page, not just the visible one: a visitor can reach the final
    // page and submit without ever returning to an earlier page they left
    // incomplete (Next validates, but a required question can be cleared
    // again on the way back).
    const missing: Record<string, string> = {};
    for (const q of (data?.form?.questions ?? [])) {
      if (!q.isRequired) continue;
      const v = answers[q.questionKey];
      if (!v || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && !v.trim())) {
        missing[q.questionKey] = `${q.label} is required`;
      }
    }
    if (Object.keys(missing).length > 0) {
      setAnswerErrors(missing);
      // Send the visitor to the page holding the first problem.
      if (paged) {
        const firstKey = Object.keys(missing)[0]!;
        const q = data?.form?.questions.find((x) => x.questionKey === firstKey);
        const idx = q?.pageId ? formPages.findIndex((p) => p.formPageId === q.pageId) : 0;
        if (idx >= 0) setPageIndex(idx);
      }
      return;
    }
    setAnswerErrors({});
    setSubmitting(true);

    try {
      await api.publicRegistration.register(slug, {
        answers,
        website,
        elapsedMs: Date.now() - mountedAt.current,
      });
      setDone(true);
    } catch (err) {
      setFormError(
        err instanceof HttpError
          ? err.status === 429
            ? 'Too many attempts. Please try again later.'
            : err.message
          : 'Could not submit. Check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = schema.safeParse(form);

    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as string;
        if (!next[key]) next[key] = issue.message;
      }
      setErrors(next);
      // The built-in block is page 0; take the visitor there to fix it.
      if (paged) setPageIndex(0);
      return;
    }

    setErrors({});
    setSubmitting(true);

    // Custom questions on the pinned version. Built-in ones are already
    // validated by `schema` above, so only the extras are checked here.
    // Every page is checked, not just the visible one.
    const customQuestions = (data?.form?.questions ?? []).filter((q) => {
      if (q.mapsToColumn) return false;
      if (!q.branchOnQuestionKey) return true;
      const gate = answers[q.branchOnQuestionKey];
      return typeof gate === 'string' && gate === q.branchOptionValue;
    });
    const customErrors: Record<string, string> = {};
    for (const q of customQuestions) {
      if (!q.isRequired) continue;
      const v = answers[q.questionKey];
      if (!v || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && !v.trim())) {
        customErrors[q.questionKey] = `${q.label} is required`;
      }
    }
    if (Object.keys(customErrors).length > 0) {
      setAnswerErrors(customErrors);
      if (paged) {
        const firstKey = Object.keys(customErrors)[0]!;
        const q = data?.form?.questions.find((x) => x.questionKey === firstKey);
        const idx = q?.pageId ? formPages.findIndex((p) => p.formPageId === q.pageId) : 0;
        if (idx >= 0) setPageIndex(idx);
      }
      setSubmitting(false);
      return;
    }
    setAnswerErrors({});

    try {
      await api.publicRegistration.register(slug, {
        registrantRole: parsed.data.registrantRole as Role,
        firstName: parsed.data.firstName.trim(),
        lastName: parsed.data.lastName.trim(),
        email: parsed.data.email.trim(),
        phone: parsed.data.phone || undefined,
        agencyId,
        classAges: parsed.data.classAges || undefined,
        childrenAges: parsed.data.childrenAges || undefined,
        secondCaregiverInfo: parsed.data.secondCaregiverInfo || undefined,
        notes: parsed.data.notes || undefined,
        answers: Object.keys(answers).length > 0 ? answers : undefined,
        website,
        elapsedMs: Date.now() - mountedAt.current,
      });
      setDone(true);
    } catch (err) {
      if (err instanceof HttpError) {
        setFormError(
          err.status === 409
            ? 'Registration is no longer open for this workshop.'
            : err.status === 429
              ? 'Too many attempts. Please try again later.'
              : err.message,
        );
      } else {
        setFormError('Could not submit. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <PublicChrome>
        <div className="public-card">
        <PublicBrand />
          <div className="skeleton" style={{ height: 28, width: '60%', marginBottom: 14 }} />
          <div className="skeleton" style={{ height: 16, width: '40%' }} />
        </div>
      </PublicChrome>
    );
  }

  if (isError || !data) {
    return (
      <Terminal
        title="This link is not valid"
        message="The link may have expired or been withdrawn. Please contact Project Enlightenment for an up-to-date link."
      />
    );
  }

  const link = data as PublicLinkState;

  if (link.state === 'revoked') {
    return (
      <Terminal
        title="This link is no longer valid"
        message="This registration link has been withdrawn. Please contact Project Enlightenment for a current link."
      />
    );
  }

  if (link.state === 'closed') {
    return (
      <Terminal
        title="Registration is closed"
        message="Registration for this workshop has closed. Please contact Project Enlightenment if you think this is a mistake."
      />
    );
  }

  if (link.state === 'not-yet-open') {
    return (
      <Terminal
        title="Registration has not opened yet"
        message="Online registration for this workshop opens soon. Please try again later."
      />
    );
  }

  if (link.state === 'full' || done) {
    // A standalone form has no seats, so a successful submission is the only
    // thing that reaches here.
    if (done && link.kind === 'trainingRequest') {
      return (
        <PublicChrome title="Project Enlightenment - Training Request">
          <div className="public-card public-terminal">
            <PublicBrand subtitle="Training Request" />
            <div className="icon-wrap" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <h1>Request received</h1>
            <p>
              Thank you. Your training request has been submitted and Project
              Enlightenment will be in touch.
            </p>
          </div>
        </PublicChrome>
      );
    }

    return (
      <PublicChrome>
        <div className="public-card public-terminal">
        <PublicBrand />
          <div className="icon-wrap" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h1>{done ? "You're registered" : 'This workshop is full'}</h1>
          <p>
            {done
              ? 'A confirmation email is on its way. Keep it for your records.'
              : 'All places for online registration have been taken. Please contact Project Enlightenment to be added to a waiting list.'}
          </p>
          {done && link.redirectToPayment && link.paymentUrl && (
            <div className="payment-step">
              <p className="payment-step-lead">
                <strong>One more step: payment.</strong>
              </p>
              <p className="payment-step-body">
                Your place is reserved, but it is not confirmed until payment is received.
                Continue to the secure payment page to complete your registration.
              </p>
              <a className="btn btn-primary payment-step-btn" href={link.paymentUrl}>
                Proceed to payment
              </a>
              <p className="payment-step-note">
                You will leave this site. Keep this page open if you would like a record of
                your registration.
              </p>
            </div>
          )}
        </div>
      </PublicChrome>
    );
  }

  const w = link.workshop;
  const seats = link.seatsRemaining;

  // A standalone form (a training request) has no workshop to describe, so it
  // renders only its own questions.
  if (link.kind === 'trainingRequest') {
    return (
      <PublicChrome title="Project Enlightenment - Training Request">
        <div className="public-card">
          <PublicBrand subtitle="Training Request" />
          <h1>Training request</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13.5 }}>
            Tell us what training you would like Project Enlightenment to deliver.
          </p>
        </div>

        <div className="public-card">
          <h2>{currentPage ? currentPage.title : 'Your request'}</h2>
          {currentPage?.subtitle && (
            <p style={{ margin: '0 0 14px', color: 'var(--text-muted)', fontSize: 13.5 }}>
              {currentPage.subtitle}
            </p>
          )}

          {paged && <FormSteps pages={formPages} current={pageIndex} onGoTo={setPageIndex} />}

          {formError && (
            <div className="alert alert-error" role="alert">
              <span>{formError}</span>
            </div>
          )}

          <form className="public-form" onSubmit={onSubmitStandalone} noValidate>
            {visibleQuestions(true).map((q) => (
              <QuestionField
                key={q.questionKey}
                q={q}
                value={answers[q.questionKey]}
                err={answerErrors[q.questionKey]}
                agencyLabel={agencyLabels[q.questionKey] ?? ''}
                sessions={data?.sessions ?? []}
                includeSession={false}
                onChange={(v) => {
                  setAnswers((prev) => ({ ...prev, [q.questionKey]: v }));
                  setAnswerErrors((prev) => {
                    const next = { ...prev };
                    delete next[q.questionKey];
                    return next;
                  });
                }}
                onAgencyLabel={(lbl) =>
                  setAgencyLabels((prev) => ({ ...prev, [q.questionKey]: lbl }))
                }
              />
            ))}

            <div className="hp-field" aria-hidden="true">
              <label htmlFor="r-website">Website</label>
              <input
                id="r-website"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>

            <div className="form-nav">
              {paged && pageIndex > 0 && (
                <button type="button" className="btn btn-ghost" onClick={goBack}>
                  Back
                </button>
              )}
              {!isLastPage ? (
                <button type="button" className="btn btn-primary" onClick={() => goNext(false)}>
                  Next
                </button>
              ) : (
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Submitting…' : 'Submit request'}
                </button>
              )}
            </div>
          </form>
        </div>
      </PublicChrome>
    );
  }

  // Real counts from the live roster. Null means the workshop has no stated
  // capacity, so the line is omitted rather than inventing a number.
  const availLabel =
    seats === null
      ? null
      : seats <= 0
        ? 'Registration is full'
        : `${seats} ${seats === 1 ? 'spot' : 'spots'} remaining`;
  const availTone = seats === null ? null : seats <= 0 ? 'full' : seats <= 5 ? 'limited' : 'plenty';

  return (
    <PublicChrome>
      <div className="public-card">
        <PublicBrand />
        <h1>{w.title ?? 'Workshop'}</h1>
        {w.code && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13.5 }}>{w.code}</p>}

        <dl className="public-meta">
          <div>
            <dt>Date</dt>
            <dd>{fmtDate(w.startDate)}</dd>
          </div>
          {w.startTime && (
            <div>
              <dt>Time</dt>
              <dd>
                {fmtTime(w.startTime)}
                {w.endTime ? ` â€“ ${fmtTime(w.endTime)}` : ''}
              </dd>
            </div>
          )}
          {w.location && (
            <div>
              <dt>Location</dt>
              <dd>{w.location}</dd>
            </div>
          )}
          {w.cost !== null && (
            <div>
              <dt>Cost</dt>
              <dd>{w.cost === 0 ? 'Free' : `$${w.cost.toFixed(2)}`}</dd>
            </div>
          )}
          {w.credit && (
            <div>
              <dt>Credit</dt>
              <dd>
                {w.credit}
                {w.ceus ? ` Â· ${w.ceus} CEUs` : ''}
              </dd>
            </div>
          )}
        </dl>

        {availLabel && (
          <span className={`avail avail-${availTone}`}>{availLabel}</span>
        )}
      </div>

      <div className="public-card">
        <h2>{paged ? currentPage?.title ?? 'Register' : 'Register'}</h2>
        {paged && currentPage?.subtitle && (
          <p style={{ margin: '0 0 14px', color: 'var(--text-muted)', fontSize: 13.5 }}>
            {currentPage.subtitle}
          </p>
        )}

        {paged && <FormSteps pages={formPages} current={pageIndex} onGoTo={setPageIndex} />}

        {formError && (
          <div className="alert alert-error" role="alert">
            <span>{formError}</span>
          </div>
        )}

        <form className="public-form" onSubmit={onSubmit} noValidate>
          {/* Page 0 of a paginated form is the built-in block; later pages
              hold only the custom questions assigned to them. */}
          {showsBuiltIn && (
          <>
          <fieldset className="role-choice">
            <legend>I am registering as <Req /></legend>
            <div className="role-options">
              {ROLES.map((r) => (
                <label
                  key={r}
                  className={`role-option${form.registrantRole === r ? ' is-selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="registrantRole"
                    value={r}
                    checked={form.registrantRole === r}
                    onChange={() => set('registrantRole', r)}
                    required
                  />
                  <span className="role-label">{r}</span>
                  <span className="role-hint">
                    {r === 'Educator'
                      ? 'Teachers, assistants, directors and other school staff'
                      : 'Families and caregivers of young children'}
                  </span>
                </label>
              ))}
            </div>
            {errors.registrantRole && (
              <span className="error" role="alert">{errors.registrantRole}</span>
            )}
          </fieldset>

          <div className="field">
            <label htmlFor="r-first">First name <Req /></label>
            <input
              id="r-first"
              value={form.firstName ?? ''}
              onChange={(e) => set('firstName', e.target.value)}
              autoComplete="given-name"
              aria-invalid={errors.firstName ? 'true' : undefined}
              required
            />
            {errors.firstName && <span className="error" role="alert">{errors.firstName}</span>}
          </div>

          <div className="field">
            <label htmlFor="r-last">Last name <Req /></label>
            <input
              id="r-last"
              value={form.lastName ?? ''}
              onChange={(e) => set('lastName', e.target.value)}
              autoComplete="family-name"
              aria-invalid={errors.lastName ? 'true' : undefined}
              required
            />
            {errors.lastName && <span className="error" role="alert">{errors.lastName}</span>}
          </div>

          <div className="field">
            <label htmlFor="r-email">Email <Req /></label>
            <input
              id="r-email"
              type="email"
              inputMode="email"
              value={form.email ?? ''}
              onChange={(e) => set('email', e.target.value)}
              autoComplete="email"
              aria-invalid={errors.email ? 'true' : undefined}
              required
            />
            {errors.email && <span className="error" role="alert">{errors.email}</span>}
          </div>

          <div className="field">
            <label htmlFor="r-phone">Phone <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>(optional)</span></label>
            <input
              id="r-phone"
              type="tel"
              inputMode="tel"
              value={form.phone ?? ''}
              onChange={(e) => set('phone', e.target.value)}
              autoComplete="tel"
            />
          </div>

          {form.registrantRole === 'Educator' && (
            <>
              <div className="field">
                <label htmlFor="r-agency">School or agency <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>(optional)</span></label>
                <AgencyPicker
                  id="r-agency"
                  value={agencyId}
                  label={agencyLabel}
                  onChange={(id, lbl) => {
                    setAgencyId(id);
                    setAgencyLabel(lbl);
                  }}
                />
              </div>

              <div className="field">
                <label htmlFor="r-class-ages">
                  How old are the students in your class?{' '}
                  <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>(optional)</span>
                </label>
                <input
                  id="r-class-ages"
                  value={form.classAges ?? ''}
                  onChange={(e) => set('classAges', e.target.value)}
                  placeholder="e.g. 3-4 year olds"
                />
              </div>
            </>
          )}

          {form.registrantRole === 'Parent/caregiver' && (
            <>
              <div className="field">
                <label htmlFor="r-children-ages">
                  What are the ages of your children?{' '}
                  <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>(optional)</span>
                </label>
                <input
                  id="r-children-ages"
                  value={form.childrenAges ?? ''}
                  onChange={(e) => set('childrenAges', e.target.value)}
                  placeholder="e.g. 2 and 4"
                />
              </div>

              <div className="field">
                <label htmlFor="r-second-caregiver">
                  Additional information for a second parent/caregiver? Please enter it below.{' '}
                  <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>(optional)</span>
                </label>
                <textarea
                  id="r-second-caregiver"
                  rows={3}
                  maxLength={2000}
                  value={form.secondCaregiverInfo ?? ''}
                  onChange={(e) => set('secondCaregiverInfo', e.target.value)}
                  placeholder="Name, phone, email or anything else we should know"
                />
              </div>
            </>
          )}

          <div className="field">
            <label htmlFor="r-notes">Anything we should know? <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>(optional)</span></label>
            <textarea
              id="r-notes"
              rows={2}
              maxLength={255}
              value={form.notes ?? ''}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>

          {/* Custom questions from the pinned form version, for the page
              being shown. Built-in ones are rendered above, so only unmapped
              questions appear here. Branch conditions are applied inside
              visibleQuestions(). */}
          {visibleQuestions().map((q) => (
            <QuestionField
              key={q.questionKey}
              q={q}
              value={answers[q.questionKey]}
              err={answerErrors[q.questionKey]}
              agencyLabel={agencyLabels[q.questionKey] ?? ''}
              sessions={data?.sessions ?? []}
              includeSession
              onChange={(v) => {
                setAnswers((prev) => ({ ...prev, [q.questionKey]: v }));
                setAnswerErrors((prev) => {
                  const next = { ...prev };
                  delete next[q.questionKey];
                  return next;
                });
              }}
              onAgencyLabel={(lbl) =>
                setAgencyLabels((prev) => ({ ...prev, [q.questionKey]: lbl }))
              }
            />
          ))}
          </>
          )}

          {/* Honeypot: hidden from people, tempting to bots. */}
          <div className="hp-field" aria-hidden="true">
            <label htmlFor="r-website">Website</label>
            <input
              id="r-website"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>

          {link.redirectToPayment && link.paymentUrl && (
            <p className="payment-notice">
              <svg
                className="payment-notice-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
              <strong>
                After registering you will be able to continue to the SchoolCash Online website
                for payment.
              </strong>
            </p>
          )}

          <div className="form-nav">
            {paged && pageIndex > 0 && (
              <button type="button" className="btn btn-ghost" onClick={goBack}>
                Back
              </button>
            )}
            {!isLastPage ? (
              <button type="button" className="btn btn-primary" onClick={() => goNext(true)}>
                Next
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Registering…' : 'Register'}
              </button>
            )}
          </div>

          {isLastPage && !(link.redirectToPayment && link.paymentUrl) && (
            <p className="field-hint" style={{ marginTop: 12, textAlign: 'center' }}>
              Payment is arranged separately — registering does not charge you.
            </p>
          )}
        </form>
      </div>
    </PublicChrome>
  );
}
