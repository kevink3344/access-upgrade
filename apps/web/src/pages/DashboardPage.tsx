import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { DashboardSummary, UpcomingWorkshop } from '@pe/shared';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { Sparkline } from '../components/Sparkline';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function StatusPill({ w }: { w: UpcomingWorkshop }) {
  if (w.isCancelled) return <span className="pill pill-cancelled">Cancelled</span>;
  if (w.isClosed) return <span className="pill pill-closed">Closed</span>;
  if (w.capacity !== null && w.registered >= w.capacity) {
    return <span className="pill pill-full">Full</span>;
  }
  return <span className="pill pill-open">Open</span>;
}

function Capacity({ registered, capacity }: { registered: number; capacity: number | null }) {
  if (capacity === null || capacity <= 0) {
    return <span className="capacity"><span className="txt">{registered} registered</span></span>;
  }
  const pct = Math.min(100, Math.round((registered / capacity) * 100));
  const cls = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
  return (
    <span className="capacity">
      <span className="bar" aria-hidden="true">
        <i className={cls} style={{ width: `${pct}%` }} />
      </span>
      <span className="txt">
        {registered}/{capacity}
      </span>
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
  to,
  sparkline,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 2 | 3 | 4;
  to?: string;
  sparkline?: ReactNode;
}) {
  const content = (
    <>
      <div className="stat-card-main">
        <div className="label">{label}</div>
        <div className="value">{value}</div>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {sparkline && <div className="stat-card-spark">{sparkline}</div>}
    </>
  );

  const className = `stat-card${accent ? ` accent-${accent}` : ''}`;

  return to ? (
    <a className={`${className} stat-card-link`} href={to}>
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

function DashboardBody({ data }: { data: DashboardSummary }) {
  const { schoolYear, counts, currentYear, monthly, upcomingWorkshops, unpaidRegistrations, recentActivity } = data;
  const historyLabel = `by month, ${monthly.year}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Welcome back</h2>
          <p>
            {schoolYear ? `School year ${schoolYear.name}` : 'No current school year'} ·{' '}
            {counts.workshops.toLocaleString()} workshops · {counts.registrations.toLocaleString()} registrations
          </p>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard
          label="Workshops this year"
          value={currentYear.workshops.toLocaleString()}
          sub={`${counts.workshops.toLocaleString()} total`}
          to="/workshops"
          sparkline={
            <Sparkline values={monthly.workshops} label={`Workshops started, ${historyLabel}`} />
          }
        />
        <StatCard
          label="Registrations this year"
          value={currentYear.registrations.toLocaleString()}
          sub={`${counts.registrations.toLocaleString()} total`}
          accent={2}
          to="/registrations"
          sparkline={
            <Sparkline
              values={monthly.registrations}
              label={`Registrations taken, ${historyLabel}`}
            />
          }
        />
        <StatCard
          label="Revenue this year"
          value={fmtMoney(currentYear.revenue)}
          sub="Collected, excluding cancellations"
          accent={3}
          to="/payments"
          sparkline={
            <Sparkline
              values={monthly.revenue}
              label={`Revenue, ${historyLabel}`}
              format={fmtMoney}
            />
          }
        />
        <StatCard
          label="Unpaid registrations"
          value={unpaidRegistrations.count.toLocaleString()}
          sub={`${fmtMoney(unpaidRegistrations.total)} outstanding · last 6 months`}
          accent={4}
          to="/registrations?status=active"
        />
      </div>

      <div className="grid-2">
        <section className="panel" aria-labelledby="upcoming-heading">
          <div className="panel-head">
            <h3 id="upcoming-heading">Upcoming workshops</h3>
            <span className="hint">Next 6 by start date</span>
          </div>
          <div className="panel-body">
            {upcomingWorkshops.length === 0 ? (
              <p className="empty">No workshops scheduled from today onward.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Workshop</th>
                    <th scope="col">Date</th>
                    <th scope="col">Capacity</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {upcomingWorkshops.map((w) => (
                    <tr key={w.workshopId}>
                      <td data-label="Workshop">
                        <a className="link-button" href={`/workshops?edit=${w.workshopId}`}>
                          {w.workshopName ?? 'Untitled workshop'}
                        </a>
                        {w.workshopCode && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            {w.workshopCode}
                          </div>
                        )}
                      </td>
                      <td data-label="Date">{fmtDate(w.startDate)}</td>
                      <td data-label="Capacity">
                        <Capacity registered={w.registered} capacity={w.capacity} />
                      </td>
                      <td data-label="Status">
                        <StatusPill w={w} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="activity-heading">
          <div className="panel-head">
            <h3 id="activity-heading">Recent activity</h3>
            <span className="hint">Latest registrations</span>
          </div>
          <div className="panel-body">
            {recentActivity.length === 0 ? (
              <p className="empty">No recent activity.</p>
            ) : (
              <ul className="activity">
                {recentActivity.map((a, i) => (
                  <li key={`${a.at}-${i}`}>
                    <span className="dot" aria-hidden="true" />
                    <span className="body">
                      {a.registrationId ? (
                        <a
                          className="activity-link"
                          href={`/registrations?edit=${a.registrationId}`}
                        >
                          {a.description}
                        </a>
                      ) : (
                        a.description
                      )}
                      {a.isCancelled && <span className="cancelled-tag">Cancelled</span>}
                      <span className="when">{fmtRelative(a.at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="skeleton" style={{ width: 220, height: 30, marginBottom: 8 }} />
          <div className="skeleton" style={{ width: 340, height: 16 }} />
        </div>
      </div>
      <div className="stat-grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stat-card">
            <div className="stat-card-main">
              <div className="skeleton" style={{ width: 90, height: 11, marginBottom: 12 }} />
              <div className="skeleton" style={{ width: 120, height: 30 }} />
            </div>
            {i < 3 && <div className="stat-card-spark"><div className="skeleton" style={{ width: '100%', height: 44 }} /></div>}
          </div>
        ))}
      </div>
      <div className="grid-2">
        <div className="panel"><div className="skeleton" style={{ height: 240 }} /></div>
        <div className="panel"><div className="skeleton" style={{ height: 240 }} /></div>
      </div>
    </>
  );
}

export function DashboardPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: api.dashboard,
    staleTime: 60_000,
  });

  return (
    <AppShell currentPath="/" title="Dashboard">
      {isLoading && <DashboardSkeleton />}

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load the dashboard.
            {error instanceof Error ? ` ${error.message}` : ''}
          </span>
        </div>
      )}

      {data && <DashboardBody data={data} />}
    </AppShell>
  );
}
