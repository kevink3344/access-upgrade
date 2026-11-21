import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReportCatalogueItem, ReportGroup } from '@pe/shared';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { IconReports } from '../components/icons';

const GROUP_LABELS: Record<ReportGroup, string> = {
  attendance: 'Attendance & enrollment',
  workshops: 'Workshop listings',
  evaluations: 'Evaluations',
  surveys: 'Interest surveys',
  demographics: 'Demographics',
  operational: 'Operational',
};

const GROUP_ORDER: ReportGroup[] = [
  'attendance',
  'workshops',
  'evaluations',
  'surveys',
  'demographics',
  'operational',
];

function authHeader(): Record<string, string> {
  const token =
    sessionStorage.getItem('pe.access_token') ?? localStorage.getItem('pe.access_token') ?? '';
  return { Authorization: `Bearer ${token}` };
}

export function ReportsPage() {
  const [selected, setSelected] = useState<ReportCatalogueItem | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const { data: catalogue, isLoading } = useQuery({
    queryKey: ['reports', 'catalogue'],
    queryFn: () => api.reports.catalogue(),
    staleTime: 10 * 60_000,
  });

  const { data: years } = useQuery({
    queryKey: ['lookup', 'school-years'],
    queryFn: () => api.lookups.get('school-years'),
    staleTime: 10 * 60_000,
  });

  // Default to the newest school year this specific report can produce rows
  // for. A single global default opens evaluation reports on an empty year.
  const defaultYear = selected
    ? (() => {
        const id = catalogue?.defaultSchoolYearByReport?.[selected.key];
        if (id) return String(id);
        return years?.data?.[0]?.id ? String(years.data[0].id) : '';
      })()
    : '';

  useEffect(() => {
    if (!selected) return;
    const next: Record<string, string> = {};
    for (const p of selected.parameters) {
      if (p.type === 'school-year') next[p.key] = defaultYear;
    }
    setValues(next);
    setNotice(null);
  }, [selected, defaultYear]);

  const params = useMemo(() => {
    const out: Record<string, string | number | undefined> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === '') continue;
      out[k] = k === 'schoolYearId' ? Number(v) : v;
    }
    return out;
  }, [values]);

  const {
    data: result,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['reports', 'run', selected?.key, params],
    queryFn: () => api.reports.run(selected!.key, params),
    enabled: selected !== null,
  });

  function downloadPdf() {
    if (!selected) return;
    const url = api.reports.pdfUrl(selected.key, params);
    fetch(url, { headers: authHeader() })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`PDF failed (${r.status})`))))
      .then((blob) => {
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = `${selected.key}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      })
      .catch((e: Error) => setNotice(e.message));
  }

  if (isLoading) {
    return (
      <AppShell currentPath="/reports" title="Reports hub">
        <div className="panel">
          <div className="panel-body panel-body-padded">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 60, marginBottom: 10 }} />
            ))}
          </div>
        </div>
      </AppShell>
    );
  }

  const grouped = GROUP_ORDER.map((g) => ({
    group: g,
    items: (catalogue?.data ?? []).filter((r) => r.group === g),
  })).filter((x) => x.items.length > 0);

  return (
    <AppShell currentPath="/reports" title="Reports hub">
      <div className="page-head">
        <div>
          <h2>Reports hub</h2>
          <p>Read-only reports you run to understand something. Documents for a specific workshop live on that workshop.</p>
        </div>
      </div>

      {notice && (
        <div className="alert alert-error" role="alert">
          <span>{notice}</span>
        </div>
      )}

      <div className="reports-layout">
        <aside className="reports-nav">
          {grouped.map(({ group, items }) => (
            <div key={group} className="reports-nav-group">
              <h3>{GROUP_LABELS[group]}</h3>
              <ul>
                {items.map((r) => (
                  <li key={r.key}>
                    <button
                      type="button"
                      className={`reports-nav-item${selected?.key === r.key ? ' is-active' : ''}`}
                      onClick={() => setSelected(r)}
                    >
                      {r.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {(catalogue?.links ?? []).length > 0 && (
            <div className="reports-nav-group">
              <h3>Financial</h3>
              <ul>
                {(catalogue?.links ?? []).map((l) => (
                  <li key={l.title}>
                    <a className="reports-nav-item" href={l.href}>
                      {l.title} <span className="reports-nav-ext">→</span>
                    </a>
                  </li>
                ))}
              </ul>
              <p className="reports-nav-note">
                Money lives on the Payments screen, so these link there rather than duplicating it.
              </p>
            </div>
          )}
        </aside>

        <section className="reports-main">
          {!selected ? (
            <div className="panel">
              <div className="panel-body panel-body-padded">
                <div className="empty">
                  <IconReports width={30} height={30} />
                  <p style={{ marginTop: 12 }}>Pick a report on the left to run it.</p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="panel">
                <div className="panel-body panel-body-padded">
                  <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>{selected.title}</h3>
                  <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 13.5 }}>
                    {selected.description}
                  </p>

                  <div className="reports-params">
                    {selected.parameters.map((p) => (
                      <div className="field" key={p.key}>
                        <label htmlFor={`rp-${p.key}`}>{p.label}</label>
                        {p.type === 'school-year' ? (
                          <select
                            id={`rp-${p.key}`}
                            value={values[p.key] ?? ''}
                            onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                          >
                            {(years?.data ?? []).map((y) => (
                              <option key={y.id} value={y.id}>
                                {y.label}
                              </option>
                            ))}                          </select>
                        ) : (
                          <input
                            id={`rp-${p.key}`}
                            type={p.type === 'date' ? 'date' : 'text'}
                            value={values[p.key] ?? ''}
                            onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                          />
                        )}
                      </div>
                    ))}

                    <div className="reports-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => refetch()}
                        disabled={isFetching}
                      >
                        {isFetching ? 'Running…' : 'Run'}
                      </button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={downloadPdf}>
                        Download PDF
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {error && (
                <div className="alert alert-error" role="alert">
                  <span>{(error as Error).message}</span>
                </div>
              )}

              <div className="panel">
                <div className="panel-body">
                  {isFetching && !result ? (
                    <div style={{ padding: 18 }}>
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="skeleton" style={{ height: 36, marginBottom: 8 }} />
                      ))}
                    </div>
                  ) : !result || result.data.length === 0 ? (
                    <div className="empty">
                      <p>
                        <strong>No rows matched these parameters.</strong>
                      </p>
                      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
                        {selected.parameters
                          .map((p) => {
                            const raw = values[p.key];
                            if (!raw) return `${p.label}: any`;
                            // Show the school year label, not its numeric id.
                            if (p.type === 'school-year') {
                              const label = years?.data?.find((y) => String(y.id) === raw)?.label;
                              return `${p.label}: ${label ?? raw}`;
                            }
                            return `${p.label}: ${raw}`;
                          })
                          .join(' · ')}
                      </p>
                      {selected.parameters.some((p) => p.type === 'school-year') && (
                        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
                          Try a year that already has recorded attendance — the current school
                          year fills up as workshops are held.
                        </p>
                      )}
                    </div>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          {result.columns.map((c) => (
                            <th key={c.key} className={c.align === 'right' ? 'num' : undefined}>
                              {c.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.data.map((row, i) => (
                          <tr key={i}>
                            {result.columns.map((c) => (
                              <td key={c.key} className={c.align === 'right' ? 'num' : undefined}>
                                {row[c.key] === null || row[c.key] === undefined ? '—' : String(row[c.key])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {result && (
                  <div className="reports-footer">
                    {result.total.toLocaleString()} row{result.total === 1 ? '' : 's'}
                    {result.truncated && ` · showing the first ${result.data.length.toLocaleString()}`}
                    {result.truncated && ' · download the PDF for the full set'}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}
