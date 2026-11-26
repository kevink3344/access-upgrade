import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  DuplicateGroup,
  NegativePaymentRow,
  OrphanRegistrationRow,
  UtilityRisk,
} from '@pe/shared';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { MergeParticipantsDrawer } from '../components/MergeParticipantsDrawer';
import { IconUtilities } from '../components/icons';

/**
 * Utilities — the maintenance tools that replace the Access macros and action
 * queries.
 *
 * One screen with a tab per tool rather than four routes: they are all
 * "look at a list of rows that need a decision", and staff move between them
 * while working through a backlog. The merge is the only one that writes, and
 * it opens in a drawer so the list it came from stays put.
 */

type Tab = 'duplicate-participants' | 'negative-payments' | 'registrations-no-workshop';

const TABS: { key: Tab; label: string }[] = [
  { key: 'duplicate-participants', label: 'Duplicate participants' },
  { key: 'negative-payments', label: 'Negative payments' },
  { key: 'registrations-no-workshop', label: 'No workshop' },
];

const RISK_CLASS: Record<UtilityRisk, string> = {
  LOW: 'util-risk-low',
  MEDIUM: 'util-risk-medium',
  HIGH: 'util-risk-high',
};

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function date(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function name(p: { firstName: string | null; lastName: string | null }): string {
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unnamed participant';
}

export function UtilitiesPage() {
  const [tab, setTab] = useState<Tab>('duplicate-participants');
  const [notice, setNotice] = useState<string | null>(null);
  const [merge, setMerge] = useState<{ sourceId: number; targetId: number } | null>(null);

  const catalogue = useQuery({
    queryKey: ['utilities', 'catalogue'],
    queryFn: () => api.utilities.catalogue(),
    staleTime: 60_000,
  });

  const overview = catalogue.data?.overview;

  const countFor: Record<Tab, number | undefined> = {
    'duplicate-participants': overview?.duplicateGroups,
    'negative-payments': overview?.negativePayments,
    'registrations-no-workshop': overview?.orphanRegistrations,
  };

  return (
    <AppShell currentPath="/admin/utilities" title="Utilities">
      <div className="page-head">
        <div>
          <h2>Utilities</h2>
          <p>
            Maintenance tools for data the Access database left behind. Each one shows what it
            affects before anything changes.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setMerge({ sourceId: 0, targetId: 0 })}>
          Merge participants
        </button>
      </div>

      {notice && (
        <div className="alert alert-info" role="status">
          <span>{notice}</span>
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="util-stats">
        <StatCard
          label="Duplicate email groups"
          value={overview?.duplicateGroups}
          sub={
            overview
              ? `${overview.duplicateParticipants} participants involved`
              : undefined
          }
        />
        <StatCard
          label="Negative payments"
          value={overview?.negativePayments}
          sub="Registrations with a paid amount below zero"
        />
        <StatCard
          label="Registrations with no workshop"
          value={overview?.orphanRegistrations}
          sub="Cannot appear on a roster or report"
        />
      </div>

      <div className="util-tabs" role="tablist" aria-label="Utilities">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`util-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`util-panel-${t.key}`}
            className={`util-tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {countFor[t.key] !== undefined && (
              <span className="util-tab-count">{countFor[t.key]}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'duplicate-participants' && (
        <div role="tabpanel" id="util-panel-duplicate-participants" aria-labelledby="util-tab-duplicate-participants">
          <DuplicateGroups
            onMerge={(sourceId, targetId) => setMerge({ sourceId, targetId })}
            onMergeAny={() => setMerge({ sourceId: 0, targetId: 0 })}
          />
        </div>
      )}

      {tab === 'negative-payments' && (
        <div role="tabpanel" id="util-panel-negative-payments" aria-labelledby="util-tab-negative-payments">
          <NegativePayments />
        </div>
      )}

      {tab === 'registrations-no-workshop' && (
        <div
          role="tabpanel"
          id="util-panel-registrations-no-workshop"
          aria-labelledby="util-tab-registrations-no-workshop"
        >
          <OrphanRegistrations />
        </div>
      )}

      {catalogue.data && (
        <section className="util-legend" aria-label="What each tool replaces">
          <h3>What these replace</h3>
          <ul>
            {catalogue.data.data
              .filter((u) => u.mode === 'review' || u.key === 'merge-participants')
              .map((u) => (
                <li key={u.key}>
                  <span className={`util-risk ${RISK_CLASS[u.risk]}`}>{u.risk}</span>
                  <b>{u.title}</b> — {u.description}
                  <small>Replaces: {u.replaces}</small>
                </li>
              ))}
          </ul>
        </section>
      )}

      {merge && (
        <MergeParticipantsDrawer
          initialSourceId={merge.sourceId || null}
          initialTargetId={merge.targetId || null}
          onClose={() => setMerge(null)}
          onMerged={(message) => {
            setMerge(null);
            setNotice(message);
          }}
        />
      )}
    </AppShell>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number | undefined;
  sub?: string;
}) {
  return (
    <div className="util-stat">
      <span className="util-stat-label">{label}</span>
      <span className="util-stat-value">{value === undefined ? '—' : value.toLocaleString()}</span>
      {sub && <span className="util-stat-sub">{sub}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Duplicate participants                                             */
/* ------------------------------------------------------------------ */

function DuplicateGroups({
  onMerge,
  onMergeAny,
}: {
  onMerge: (sourceId: number, targetId: number) => void;
  onMergeAny: () => void;
}) {
  const [page, setPage] = useState(1);
  // null until the year list has loaded, so the first fetch waits for the
  // default rather than requesting every year and then the current one.
  const [yearId, setYearId] = useState<number | null>(null);

  const years = useQuery({
    queryKey: ['utilities', 'school-years'],
    queryFn: () => api.utilities.schoolYears(),
    staleTime: 10 * 60_000,
  });

  const yearOptions = years.data?.data ?? [];

  // The newest year is the default: it is the one staff are working in, and
  // almost every older duplicate is history nobody will merge.
  useEffect(() => {
    if (yearId !== null || yearOptions.length === 0) return;
    setYearId(yearOptions[0]!.id);
  }, [yearId, yearOptions]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['utilities', 'duplicates', yearId, page],
    queryFn: () =>
      api.utilities.duplicateGroups({
        schoolYearId: yearId ?? undefined,
        page,
        pageSize: 10,
      }),
    enabled: yearId !== null,
  });

  const groups = data?.data ?? [];
  const totalGroups = data?.totalGroups ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalGroups / 10));
  const selectedYear = yearOptions.find((y) => y.id === yearId);
  const allYearsTotal = yearOptions.reduce((sum, y) => sum + y.duplicateGroups, 0);

  const yearPicker = (
    <div className="util-year-bar">
      <label htmlFor="util-dup-year">Participants by year</label>
      <select
        id="util-dup-year"
        value={yearId ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          setYearId(v === '' ? null : Number(v));
          setPage(1);
        }}
        disabled={years.isLoading}
      >
        {yearOptions.map((y) => (
          <option key={y.id} value={y.id}>
            {y.label}
            {y.duplicateGroups > 0 ? ` — ${y.duplicateGroups} to review` : ' — none'}
          </option>
        ))}
        <option value="">All years — {allYearsTotal} to review</option>
      </select>
      {selectedYear && selectedYear.isPastYear && (
        <span className="util-year-note">
          A past year. Most duplicates here are history — merge only what still matters.
        </span>
      )}
      {yearId === null && (
        <span className="util-year-note">
          Every year at once. This is the full backlog, most of it historic.
        </span>
      )}
    </div>
  );

  if (error) {
    return (
      <>
        {yearPicker}
        <div className="alert alert-error" role="alert">
          <span>Could not load duplicate groups. {(error as Error).message}</span>
        </div>
      </>
    );
  }

  if (isLoading || years.isLoading) {
    return (
      <>
        {yearPicker}
        <div className="panel">
          <div className="panel-body" style={{ padding: 18 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 72, marginBottom: 10 }} />
            ))}
          </div>
        </div>
      </>
    );
  }

  if (groups.length === 0) {
    return (
      <>
        {yearPicker}
        <div className="panel">
          <div className="panel-body">
            <div className="empty">
              <IconUtilities width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {yearId === null
                  ? 'No duplicate email addresses.'
                  : `No duplicate email addresses in ${selectedYear?.label ?? 'this year'}.`}
              </p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '8px auto 0', maxWidth: 460 }}>
                {yearId === null
                  ? 'Every participant with an email address has a unique one. Nothing to merge.'
                  : 'Nobody registered this year shares an address with another participant. Older years may still have some — choose one above.'}
              </p>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {yearPicker}

      <p className="util-intro">
        {totalGroups.toLocaleString()} email address{totalGroups === 1 ? ' is' : 'es are'} shared by
        more than one participant
        {selectedYear ? ` in ${selectedYear.label}` : ' across all years'}. Open a group to merge
        the ones that are the same person — never merge without checking, because two people can
        share a work address.
      </p>

      <div className="util-group-list">
        {groups.map((g) => (
          <DuplicateGroupCard key={g.email} group={g} onMerge={onMerge} />
        ))}
      </div>

      <div className="pager">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
        >
          Previous
        </button>
        <span className="pager-info">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          disabled={page >= pageCount}
        >
          Next
        </button>
        <button type="button" className="link-button util-pager-any" onClick={onMergeAny}>
          Merge any two participants
        </button>
      </div>
    </>
  );
}

function DuplicateGroupCard({
  group,
  onMerge,
}: {
  group: DuplicateGroup;
  onMerge: (sourceId: number, targetId: number) => void;
}) {
  // The busiest record is the obvious one to keep: it is the one with the
  // history, and merging into it moves the least. Staff can still swap.
  const [keepId, setKeepId] = useState<number>(
    () =>
      [...group.participants].sort(
        (a, b) =>
          b.registrationCount + b.attendanceCount - (a.registrationCount + a.attendanceCount),
      )[0]?.participantId ?? group.participants[0]!.participantId,
  );

  return (
    <div className="util-group panel">
      <div className="util-group-head">
        <div>
          <b className="util-group-email">{group.email}</b>
          <span className="util-group-meta">
            {group.participants.length} participants · {group.registrationCount} registration
            {group.registrationCount === 1 ? '' : 's'} across the group
          </span>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Keep</th>
            <th>Name</th>
            <th>Agency</th>
            <th className="num">Reg</th>
            <th className="num">Att</th>
            <th className="num">Slips</th>
            <th className="num">Certs</th>
            <th>Entered</th>
          </tr>
        </thead>
        <tbody>
          {group.participants.map((p) => (
            <tr key={p.participantId}>
              <td>
                <input
                  type="radio"
                  name={`keep-${group.email}`}
                  checked={keepId === p.participantId}
                  onChange={() => setKeepId(p.participantId)}
                  aria-label={`Keep ${name(p)}`}
                />
              </td>
              <td>
                <b>{name(p)}</b>
                <span className="util-id">#{p.participantId}</span>
                {(p.hasCeuCertificate || p.hasChcCertificate) && (
                  <span className="util-cert-flags">
                    {p.hasCeuCertificate && <span className="pill pill-open">CEU</span>}
                    {p.hasChcCertificate && <span className="pill pill-info">CHC</span>}
                  </span>
                )}
              </td>
              <td className="muted">{p.agencyName ?? '—'}</td>
              <td className="num">{p.registrationCount}</td>
              <td className="num">{p.attendanceCount}</td>
              <td className="num">{p.creditSlipCount}</td>
              <td className="num">{p.certificateCount}</td>
              <td className="muted">{date(p.dateOfEntry)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="util-group-actions">
        {group.participants
          .filter((p) => p.participantId !== keepId)
          .map((p) => (
            <button
              key={p.participantId}
              type="button"
              className="btn btn-sm"
              onClick={() => onMerge(p.participantId, keepId)}
            >
              Merge {name(p)} into {name(group.participants.find((x) => x.participantId === keepId)! )}
            </button>
          ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Negative payments                                                  */
/* ------------------------------------------------------------------ */

function NegativePayments() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['utilities', 'negative-payments'],
    queryFn: () => api.utilities.negativePayments(),
  });

  if (error) {
    return (
      <div className="alert alert-error" role="alert">
        <span>Could not load negative payments. {(error as Error).message}</span>
      </div>
    );
  }

  if (isLoading) {
    return <div className="skeleton" style={{ height: 240 }} />;
  }

  const rows = data?.data ?? [];
  const summary = data?.summary;

  if (rows.length === 0) {
    return (
      <div className="panel">
        <div className="panel-body">
          <div className="empty">
            <p>No registrations have a negative paid amount.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="util-intro">
        Access stored refunds as a negative paid amount, but never recorded which convention was
        intended. Rows on a <b>cancelled</b> registration are almost certainly refunds; rows on an
        active one need a decision. This list is read-only — fix the amounts on the registration
        itself so the change is audited.
      </p>

      <div className="util-summary">
        <span>
          <b>{summary?.count}</b> rows
        </span>
        <span>
          Total <b>{money(summary?.total)}</b>
        </span>
        <span className="util-summary-split">
          {summary?.onCancelled} on cancelled registrations · {summary?.onActive} on active
        </span>
      </div>

      <div className="panel">
        <div className="panel-body">
          <table className="data-table">
            <thead>
              <tr>
                <th className="num">Amount</th>
                <th>Participant</th>
                <th>Workshop</th>
                <th>Paid</th>
                <th>Registered</th>
                <th>Status</th>
                <th>Receipt</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: NegativePaymentRow) => (
                <tr key={r.registrationId}>
                  <td className="num util-negative">{money(r.paidAmount)}</td>
                  <td>
                    <a className="linklike" href={`/admin/participants?edit=${r.participantId}`}>
                      {r.participantName ?? 'Unknown'}
                    </a>
                    {r.participantEmail && <span className="util-sub">{r.participantEmail}</span>}
                  </td>
                  <td>
                    {r.workshopName ?? r.workshopCode ?? (
                      <span className="muted">No workshop</span>
                    )}
                    {r.startDate && <span className="util-sub">{date(r.startDate)}</span>}
                  </td>
                  <td className="muted">{date(r.paidDate)}</td>
                  <td className="muted">{date(r.registrationDate)}</td>
                  <td>
                    {r.isCancelled ? (
                      <span className="pill pill-cancelled">Cancelled</span>
                    ) : (
                      <span className="pill pill-open">Active</span>
                    )}
                  </td>
                  <td className="muted">{r.receiptNumber ?? '—'}</td>
                  <td className="muted util-notes">{r.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Registrations with no workshop                                     */
/* ------------------------------------------------------------------ */

function OrphanRegistrations() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['utilities', 'orphans'],
    queryFn: () => api.utilities.orphanRegistrations(),
  });

  if (error) {
    return (
      <div className="alert alert-error" role="alert">
        <span>Could not load registrations. {(error as Error).message}</span>
      </div>
    );
  }

  if (isLoading) {
    return <div className="skeleton" style={{ height: 240 }} />;
  }

  const rows = data?.data ?? [];
  const summary = data?.summary;

  if (rows.length === 0) {
    return (
      <div className="panel">
        <div className="panel-body">
          <div className="empty">
            <p>Every registration has a workshop.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="util-intro">
        These registrations have no workshop, so they cannot appear on a roster, a folder or a
        report. Access left them behind when a workshop was deleted. Open a registration to attach
        it to the right workshop, or cancel it if it was a mistake.
      </p>

      <div className="util-summary">
        <span>
          <b>{summary?.count}</b> registrations
        </span>
        <span>
          <b>{summary?.withPayment}</b> carry a payment ({money(summary?.totalPaid)})
        </span>
      </div>

      <div className="panel">
        <div className="panel-body">
          <table className="data-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Registered</th>
                <th className="num">Paid</th>
                <th>Source</th>
                <th>Status</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r: OrphanRegistrationRow) => (
                <tr key={r.registrationId}>
                  <td>
                    {r.participantId ? (
                      <a className="linklike" href={`/admin/participants?edit=${r.participantId}`}>
                        {r.participantName ?? `Participant ${r.participantId}`}
                      </a>
                    ) : (
                      <span className="muted">No participant</span>
                    )}
                    {r.participantEmail && <span className="util-sub">{r.participantEmail}</span>}
                  </td>
                  <td className="muted">{date(r.registrationDate)}</td>
                  <td className="num">{r.paidAmount === null ? '—' : money(r.paidAmount)}</td>
                  <td>
                    <span className="source-tag">{r.source}</span>
                  </td>
                  <td>
                    {r.isCancelled ? (
                      <span className="pill pill-cancelled">Cancelled</span>
                    ) : (
                      <span className="pill pill-open">Active</span>
                    )}
                  </td>
                  <td className="muted util-notes">{r.notes ?? '—'}</td>
                  <td>
                    <a className="btn btn-sm" href={`/registrations?edit=${r.registrationId}`}>
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
