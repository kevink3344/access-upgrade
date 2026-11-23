import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';import type { CertificateEligibleRow, CertificateType } from '@pe/shared';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { IconReports } from '../components/icons';
import { CertificateOverrideDrawer } from '../components/CertificateOverrideDrawer';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fullName(r: CertificateEligibleRow): string {
  return [r.FirstName, r.MiddleName, r.LastName].filter(Boolean).join(' ').replace(/\s+/g, ' ');
}


export function CertificatesPage() {
  const qc = useQueryClient();

  const [schoolYearId, setSchoolYearId] = useState<number | null>(null);
  const [certType, setCertType] = useState<CertificateType>('CEU');

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [overrideFor, setOverrideFor] = useState<CertificateEligibleRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: years } = useQuery({
    queryKey: ['lookup', 'school-years'],
    queryFn: () => api.lookups.get('school-years'),
    staleTime: 10 * 60_000,
  });

  // Default to the newest year that actually has eligible participants.
  useEffect(() => {
    if (schoolYearId === null && years?.data?.length) {
      setSchoolYearId(years.data[0]!.id);
    }
  }, [years, schoolYearId]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: caps } = useQuery({
    queryKey: ['certificates', 'capabilities'],
    queryFn: () => api.certificates.capabilities(),
    staleTime: 5 * 60_000,
  });

  // Which certificate types already exist for this year, so the create dialog
  // can disable the ones that would be rejected.
  const { data, isLoading } = useQuery({
    queryKey: ['certificates', 'eligible', schoolYearId, debounced, page],
    queryFn: () =>
      api.certificates.eligible({
        schoolYearId: schoolYearId!,
        q: debounced || undefined,
        page,
        pageSize,
      }),
    enabled: schoolYearId !== null,
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const missingHours = useMemo(
    () => rows.reduce((n, r) => n + (r.MissingHoursCount > 0 ? 1 : 0), 0),
    [rows],
  );

  const downloadPdf = useMutation({
    mutationFn: async (row: CertificateEligibleRow) => {
      const url = api.certificates.pdfUrl(row.ParticipantID, schoolYearId!, certType);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${sessionStorage.getItem('pe.access_token') ?? localStorage.getItem('pe.access_token') ?? ''}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `Could not render the PDF (${res.status})`);
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `${certType}-${fullName(row).replace(/[^A-Za-z0-9]+/g, '-')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    },
    onMutate: (row) => {
      setBusyId(row.ParticipantID);
      setNotice(null);
    },
    onSuccess: (_d, row) => {
      setNotice(`Downloaded certificate for ${fullName(row)}.`);
    },
    onError: (e: Error) => setNotice(e.message),
    onSettled: () => setBusyId(null),
  });

  function preview(row: CertificateEligibleRow) {
    const url = api.certificates.previewUrl(row.ParticipantID, schoolYearId!, certType);
    // The preview endpoint needs the bearer token, so fetch then open a blob.
    fetch(url, {
      headers: { Authorization: `Bearer ${sessionStorage.getItem('pe.access_token') ?? localStorage.getItem('pe.access_token') ?? ''}` },
    })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('Preview unavailable'))))
      .then((html) => {
        const w = window.open('', '_blank');
        if (w) {
          w.document.write(html);
          w.document.close();
        }
      })
      .catch((e: Error) => setNotice(e.message));
  }

  return (
    <AppShell currentPath="/certificates" title="Certificates">
      <div className="page-head">
        <div>
          <h2>Certificates</h2>
          <p>Issue CEU and CHC certificates. To change what they look like, use the Certificate Designer.</p>
        </div>
      </div>

      {caps && !caps.pdfRendering && (
        <div className="alert alert-error" role="alert">
          <span>
            PDF downloads are unavailable — no Chromium browser was found on the server. Previews
            still work. An administrator can fix this by setting <code>CHROME_PATH</code> to a
            browser executable on the host.
          </span>
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-field">
          <label htmlFor="cert-year">School year</label>
          <select
            id="cert-year"
            className="toolbar-select"
            value={schoolYearId ?? ''}
            onChange={(e) => {
              setSchoolYearId(Number(e.target.value));
              setPage(1);
            }}
          >
            {(years?.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>
                {y.label}
              </option>
            ))}
          </select>
        </div>

        <div className="toolbar-field">
          <label htmlFor="cert-type">Certificate</label>
          <select
            id="cert-type"
            className="toolbar-select"
            value={certType}
            onChange={(e) => setCertType(e.target.value as CertificateType)}
          >
            <option value="CEU">CEU — Units of Renewal Credit</option>
            <option value="CHC">CHC — Child Care Hours</option>
          </select>
        </div>

        <span className="toolbar-count">{total.toLocaleString()} eligible</span>
      </div>

      {notice && (
        <div className="alert alert-info" role="status">
          <span>{notice}</span>
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-field" style={{ flex: '1 1 260px' }}>
          <label htmlFor="cert-search">Search</label>
          <input
            id="cert-search"
            type="search"
            placeholder="Name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {missingHours > 0 && (
          <span className="toolbar-count" style={{ color: 'var(--badge-amber-text)' }}>
            {missingHours} on this page have a workshop with no hours recorded
          </span>
        )}
      </div>

      <div className="panel">
        <div className="panel-body">
          {isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <IconReports width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced
                  ? 'No one matches that search.'
                  : 'No one is eligible for a certificate in this school year.'}
              </p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 460, margin: '8px auto 0' }}>
                Eligibility follows the Access rule: attended, not cancelled, not late, and a
                workshop code starting with “t”.
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Participant</th>
                  <th>Agency</th>
                  <th className="num">Workshops</th>
                  <th className="num">Hours</th>
                  <th className="num">CEUs</th>
                  <th>Dates</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ParticipantID}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{fullName(r) || '—'}</div>
                      {r.Email && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.Email}</div>
                      )}
                    </td>
                    <td>{r.AgencyName ?? '—'}</td>
                    <td className="num">
                      {r.WorkshopCount}
                      {r.MissingHoursCount > 0 && (
                        <span
                          className="pill pill-full"
                          style={{ marginLeft: 6 }}
                          title={`${r.MissingHoursCount} workshop(s) have no hours recorded`}
                        >
                          {r.MissingHoursCount} no hrs
                        </span>
                      )}
                    </td>
                    <td className="num">{Number(r.TotalHours ?? 0).toFixed(1)}</td>
                    <td className="num">{Number(r.TotalCeus ?? 0).toFixed(2)}</td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {fmtDate(r.FirstDate)}
                      {r.LastDate && r.LastDate !== r.FirstDate ? ` – ${fmtDate(r.LastDate)}` : ''}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => preview(r)}>
                          Preview
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busyId === r.ParticipantID || !caps?.pdfRendering}
                          onClick={() => downloadPdf.mutate(r)}
                        >
                          {busyId === r.ParticipantID ? 'Rendering…' : 'Download PDF'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setOverrideFor(r)}
                        >
                          Edit text &amp; image
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {pageCount > 1 && (
        <div className="pager">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span>
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            Next
          </button>
        </div>
      )}

      {overrideFor && schoolYearId !== null && (
        <CertificateOverrideDrawer
          participant={overrideFor}
          schoolYearId={schoolYearId}
          certificateType={certType}
          onClose={() => {
            setOverrideFor(null);
            qc.invalidateQueries({ queryKey: ['certificates', 'eligible'] });
          }}
        />
      )}
    </AppShell>
  );
}
