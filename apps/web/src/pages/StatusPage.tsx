import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { AppShell } from '../components/AppShell';

/**
 * Developer > Status.
 *
 * Every check runs live on the API, so a red row is the current truth rather
 * than a stale log. The wording is aimed at whoever is on the phone with a
 * staff member: what is broken, and what it stops working.
 */

const TONE: Record<string, string> = {
  ok: 'pill pill-open',
  warn: 'pill pill-full',
  fail: 'pill pill-cancelled',
};

const LABEL: Record<string, string> = {
  ok: 'OK',
  warn: 'Attention',
  fail: 'Failing',
};

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function StatusPage() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'status'],
    queryFn: () => api.admin.status(),
    refetchInterval: 60_000,
    retry: false,
  });

  return (
    <AppShell currentPath="/admin/status" title="Status">
      <div className="page-head">
        <div>
          <h2>Status</h2>
          <p>
            Live checks of the things the app depends on. Refreshes every minute — a red row is
            the current state, not a stale log.
          </p>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="panel">
          <div className="panel-body panel-body-padded">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 52, marginBottom: 10 }} />
            ))}
          </div>
        </div>
      )}

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            The status check itself failed: {(error as Error).message}. The API may be down.
          </span>
        </div>
      )}

      {data && (
        <>
          <div className="panel">
            <div className="panel-body panel-body-padded">
              <div className="status-summary">
                <span className={TONE[data.overall] ?? 'pill'}>{LABEL[data.overall]}</span>
                <span>
                  Checked {new Date(data.checkedAt).toLocaleString()} · up{' '}
                  {fmtUptime(data.uptimeSeconds)} · v{data.version}
                </span>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-body">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Check</th>
                    <th scope="col">State</th>
                    <th scope="col">What it means</th>
                    <th scope="col" className="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.checks.map((c) => (
                    <tr key={c.key}>
                      <td data-label="Check">
                        <b>{c.label}</b>
                      </td>
                      <td data-label="State">
                        <span className={TONE[c.status] ?? 'pill'}>{LABEL[c.status]}</span>
                      </td>
                      <td data-label="What it means">
                        <div>{c.detail}</div>
                        {c.facts && (
                          <details className="status-facts">
                            <summary>Details</summary>
                            <dl>
                              {Object.entries(c.facts).map(([k, v]) => (
                                <div key={k}>
                                  <dt>{k}</dt>
                                  <dd>{v === null || v === '' ? '—' : String(v)}</dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                        )}
                      </td>
                      <td data-label="Time" className="num">
                        {c.latencyMs === undefined ? '—' : `${c.latencyMs} ms`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
