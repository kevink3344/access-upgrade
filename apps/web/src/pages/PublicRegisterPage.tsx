import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { PublicLinkState } from '@pe/shared';
import { api, HttpError } from '../api';

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

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
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

function PublicChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-page">
      <header className="public-header">
        <div className="public-header-inner">
          <span className="public-mark" aria-hidden="true">PE</span>
          <span>
            <b>Project Enlightenment</b>
            <small>Workshop registration</small>
          </span>
        </div>
      </header>
      <main className="public-main">{children}</main>
      <p className="public-foot">
        Wake County Public School System · Project Enlightenment
      </p>
    </div>
  );
}

function Terminal({ title, message }: { title: string; message: string }) {
  return (
    <PublicChrome>
      <div className="public-card public-terminal">
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
  const [agencyQuery, setAgencyQuery] = useState('');
  const [agencyOptions, setAgencyOptions] = useState<{ id: number; label: string }[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  /** Honeypot — a real person never fills this. */
  const [website, setWebsite] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['public-link', slug],
    queryFn: () => api.publicRegistration.resolve(slug),
    retry: false,
  });

  // Agency type-ahead.
  useEffect(() => {
    if (agencyQuery.trim().length < 2) {
      setAgencyOptions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.publicRegistration
        .agencies(agencyQuery)
        .then((r) => !cancelled && setAgencyOptions(r.data))
        .catch(() => !cancelled && setAgencyOptions([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [agencyQuery]);

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
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
      return;
    }

    setErrors({});
    setSubmitting(true);

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
    return (
      <PublicChrome>
        <div className="public-card public-terminal">
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
                {w.endTime ? ` – ${fmtTime(w.endTime)}` : ''}
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
                {w.ceus ? ` · ${w.ceus} CEUs` : ''}
              </dd>
            </div>
          )}
        </dl>

        {availLabel && (
          <span className={`avail avail-${availTone}`}>{availLabel}</span>
        )}
      </div>

      <div className="public-card">
        <h2>Register</h2>

        {formError && (
          <div className="alert alert-error" role="alert">
            <span>{formError}</span>
          </div>
        )}

        <form className="public-form" onSubmit={onSubmit} noValidate>
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
              <div className="field" style={{ position: 'relative' }}>
                <label htmlFor="r-agency">School or agency <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>(optional)</span></label>
                {agencyId ? (
                  <div className="typeahead-selected">
                    <span>{agencyLabel}</span>
                    <button
                      type="button"
                      className="typeahead-clear"
                      onClick={() => {
                        setAgencyId(null);
                        setAgencyLabel('');
                        setAgencyQuery('');
                      }}
                      aria-label="Clear school"
                    >
                      Ã—
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      id="r-agency"
                      type="search"
                      placeholder="Start typing your school…"
                      value={agencyQuery}
                      onChange={(e) => setAgencyQuery(e.target.value)}
                      autoComplete="off"
                    />
                    {agencyOptions.length > 0 && (
                      <ul className="typeahead-list" role="listbox">
                        {agencyOptions.map((o) => (
                          <li key={o.id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected="false"
                              onClick={() => {
                                setAgencyId(o.id);
                                setAgencyLabel(o.label);
                                setAgencyOptions([]);
                              }}
                            >
                              {o.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
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
              <strong>
                After registering you will be able to continue to the website for payment.
              </strong>
            </p>
          )}

          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Registering…' : 'Register'}
          </button>

          {!(link.redirectToPayment && link.paymentUrl) && (
            <p className="field-hint" style={{ marginTop: 12, textAlign: 'center' }}>
              Payment is arranged separately — registering does not charge you.
            </p>
          )}
        </form>
      </div>
    </PublicChrome>
  );
}
