import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScoImportRow, ScoImportStatus } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconSchoolCash } from '../components/icons';
import { SchoolCashReview } from '../components/SchoolCashReview';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function StatusPill({ status }: { status: ScoImportStatus }) {
  if (status === 'Applied') return <span className="pill pill-open">Applied</span>;
  if (status === 'Discarded') return <span className="pill pill-muted">Discarded</span>;
  return <span className="pill pill-full">Staged</span>;
}

/**
 * School Cash matching.
 *
 * Two screens in one route: the upload and history list, and — once an import
 * is chosen — the review screen where matches are confirmed. Keeping them in
 * one route means the browser back button behaves the way staff expect.
 */
export function SchoolCashPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canAdmin = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';

  const [openImportId, setOpenImportId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Deep links: /school-cash?import=<id>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('import');
    if (id && /^\d+$/.test(id)) {
      setOpenImportId(Number(id));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const pageSize = 25;

  const imports = useQuery({
    queryKey: ['school-cash', 'imports', page],
    queryFn: () => api.schoolCash.imports({ page, pageSize }),
    enabled: openImportId === null,
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      return api.schoolCash.upload(file.name, text);
    },
    onSuccess: (result) => {
      setUploadError(null);
      qc.invalidateQueries({ queryKey: ['school-cash'] });
      setOpenImportId(result.importId);
    },
    onError: (err: unknown) => {
      setUploadError(err instanceof Error ? err.message : 'The upload failed.');
    },
  });

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    upload.mutate(file);
    // Clear so choosing the same file again still fires onChange.
    e.target.value = '';
  }

  if (openImportId !== null) {
    return (
      <SchoolCashReview
        importId={openImportId}
        canAdmin={!!canAdmin}
        onBack={() => {
          setOpenImportId(null);
          qc.invalidateQueries({ queryKey: ['school-cash'] });
        }}
      />
    );
  }

  const rows = imports.data?.rows ?? [];
  const total = imports.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AppShell currentPath="/school-cash" title="School Cash matching">
      <div className="page-head">
        <div>
          <h2>School Cash matching</h2>
          <p>
            Upload the daily Item Order Report, review what matched, then apply. Nothing is
            charged or recorded until you apply.
          </p>
        </div>
        {canAdmin && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={onPickFile}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => fileRef.current?.click()}
              disabled={upload.isPending}
            >
              {upload.isPending ? 'Uploading…' : 'Upload CSV'}
            </button>
          </>
        )}
      </div>

      {uploadError && (
        <div className="alert alert-error" role="alert">
          <span>{uploadError}</span>
        </div>
      )}

      {!canAdmin && (
        <div className="alert alert-info" role="status">
          <span>
            Only administrators can upload and apply. You can still review the history below.
          </span>
        </div>
      )}

      <div className="toolbar">
        <span className="toolbar-count">{total.toLocaleString()} uploads</span>
      </div>

      {imports.isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load uploads.
            {imports.error instanceof Error ? ` ${imports.error.message}` : ''}
          </span>
        </div>
      )}

      <div className="panel">
        <div className="panel-body">
          {imports.isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <IconSchoolCash width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {canAdmin
                  ? 'No School Cash uploads yet. Upload an Item Order Report to begin.'
                  : 'No School Cash uploads yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col" className="num">Rows</th>
                  <th scope="col" className="num">Matched</th>
                  <th scope="col" className="num">To review</th>
                  <th scope="col" className="num">Applied</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: ScoImportRow) => (
                  <tr key={r.ScoImportID}>
                    <td data-label="File">
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setOpenImportId(r.ScoImportID)}
                      >
                        {r.FileName}
                      </button>
                      <div className="muted" style={{ fontSize: 12 }}>by {r.UploadedBy}</div>
                    </td>
                    <td data-label="Uploaded">{fmtDate(r.UploadedAt)}</td>
                    <td data-label="Rows" className="num">{r.TotalRows.toLocaleString()}</td>
                    <td data-label="Matched" className="num">{r.MatchedCount.toLocaleString()}</td>
                    <td data-label="To review" className="num">
                      {r.ReviewCount > 0 ? (
                        <strong>{r.ReviewCount.toLocaleString()}</strong>
                      ) : (
                        '0'
                      )}
                    </td>
                    <td data-label="Applied" className="num">{r.AppliedCount.toLocaleString()}</td>
                    <td data-label="Status"><StatusPill status={r.Status} /></td>
                    <td data-label="Actions" className="num">
                      <span className="row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setOpenImportId(r.ScoImportID)}
                        >
                          {r.Status === 'Staged' && canAdmin ? 'Review' : 'View'}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {pageCount > 1 && (
          <div className="pager">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </button>
            <span className="pager-info">Page {page} of {pageCount.toLocaleString()}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
            >
              Next
            </button>
          </div>
        )}
      </div>

      <SchoolCashHistory />
    </AppShell>
  );
}

/**
 * The permanent record of what was applied.
 *
 * Separate from the upload list because its job is different: staff come here
 * to answer "did this payment come through, and which workshop did it pay
 * for?" long after the upload itself is irrelevant.
 */
function SchoolCashHistory() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const history = useQuery({
    queryKey: ['school-cash', 'history', debounced, page],
    queryFn: () => api.schoolCash.history({ page, pageSize, q: debounced || undefined }),
  });

  const rows = history.data?.rows ?? [];
  const total = history.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const money = (n: number | null) =>
    n === null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  return (
    <>
      <div className="page-head" style={{ marginTop: 28 }}>
        <div>
          <h2 style={{ fontSize: 17 }}>Applied payments</h2>
          <p>Every School Cash payment recorded by this feature, kept for staff review.</p>
        </div>
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="sc-history-search" className="visually-hidden">Search history</label>
          <input
            id="sc-history-search"
            type="search"
            placeholder="Search purchaser, participant or workshop…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="toolbar-count">
          {total.toLocaleString()} payments · {money(history.data?.totalAmount ?? 0)} item value ·{' '}
          {money(history.data?.totalFees ?? 0)} fees
        </span>
      </div>

      <div className="panel">
        <div className="panel-body">
          {history.isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <IconSchoolCash width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced
                  ? 'No applied payments match your search.'
                  : 'No payments have been applied yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Applied</th>
                  <th scope="col">Purchaser</th>
                  <th scope="col">Participant</th>
                  <th scope="col">Workshop</th>
                  <th scope="col" className="num">Item price</th>
                  <th scope="col" className="num">Fee</th>
                  <th scope="col">Method</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ScoRowID}>
                    <td data-label="Applied">
                      {fmtDate(r.AppliedAt)}
                      <div className="muted" style={{ fontSize: 12 }}>by {r.AppliedBy ?? '—'}</div>
                    </td>
                    <td data-label="Purchaser">
                      {r.PurchaserName ?? '—'}
                      <div className="muted" style={{ fontSize: 12 }}>{r.PurchaserEmail ?? ''}</div>
                    </td>
                    <td data-label="Participant">{r.ParticipantName ?? '—'}</td>
                    <td data-label="Workshop">
                      {r.WorkshopCode ? <strong>{r.WorkshopCode}</strong> : '—'}
                      {r.WorkshopName && (
                        <div className="muted" style={{ fontSize: 12 }}>{r.WorkshopName}</div>
                      )}
                    </td>
                    <td data-label="Item price" className="num">{money(r.ItemBalance)}</td>
                    <td data-label="Fee" className="num">{money(r.TransactionFee)}</td>
                    <td data-label="Method" className="muted">
                      {r.MatchMethod === 'manual'
                        ? 'Manual'
                        : r.MatchMethod === 'email+recent'
                          ? 'Automatic (newest)'
                          : r.MatchMethod === 'email+amount'
                            ? 'Automatic (amount)'
                            : 'Automatic'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {pageCount > 1 && (
          <div className="pager">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </button>
            <span className="pager-info">Page {page} of {pageCount.toLocaleString()}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}
