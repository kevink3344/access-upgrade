import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  PacketPrintSetup,
  PacketSectionKind,
  PacketWorkshopOption,
} from '@pe/shared';
import { api, getToken } from '../api';
import { AppShell } from '../components/AppShell';
import { IconReports } from '../components/icons';

/**
 * Folder builder.
 *
 * One workshop folder at a time: pick the workshop, choose which sheets go in
 * it, set up the printer, then look at the pages before printing. The preview
 * is the real packet — the iframe loads the same HTML the PDF is rendered
 * from — so there is no second layout to keep in step.
 *
 * Nothing here writes to the database. A folder is a printed artifact, so the
 * screen is read-only and safe for any signed-in role.
 */

const SECTION_ORDER: PacketSectionKind[] = [
  'roster',
  'blank-roster',
  'attendance',
  'eval-teacher',
  'eval-parent',
  'contact-list',
  'banner',
  'instructor-notes',
  'codification',
];

const DEFAULT_SETUP: PacketPrintSetup = {
  paper: 'Letter',
  orientation: 'Portrait',
  margin: 0.5,
  copies: 2,
};

function fmtShortDate(iso: string | null): string {
  if (!iso) return 'No date';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function FolderBuilderPage() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sections, setSections] = useState<PacketSectionKind[]>(SECTION_ORDER);
  const [setup, setSetup] = useState<PacketPrintSetup>(DEFAULT_SETUP);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const workshops = useQuery({
    queryKey: ['folders', 'workshops', debounced],
    queryFn: () => api.folders.workshops({ q: debounced || undefined, limit: 50 }),
    staleTime: 60_000,
  });

  const rows = workshops.data?.rows ?? [];

  // Opening the builder with nothing chosen should show a folder, not an
  // empty pane — the newest workshop is almost always the one being packed.
  useEffect(() => {
    if (selectedId === null && rows.length > 0) setSelectedId(rows[0]!.workshopId);
  }, [rows, selectedId]);

  const selected = useMemo(
    () => rows.find((w) => w.workshopId === selectedId) ?? null,
    [rows, selectedId],
  );

  const packet = useQuery({
    queryKey: ['folders', 'packet', selectedId, sections.join(','), setup],
    queryFn: () => api.folders.packet(selectedId!, sections, setup),
    enabled: selectedId !== null,
  });

  const detail = packet.data ?? null;

  function toggleSection(kind: PacketSectionKind) {
    setSections((prev) =>
      prev.includes(kind) ? prev.filter((s) => s !== kind) : [...prev, kind],
    );
  }

  /**
   * The preview is an iframe pointing at the API, so it needs the bearer
   * token. Cookies alone are not enough once the access token lives in
   * storage, so the token is appended as a query parameter the API accepts
   * for this read-only route.
   */
  function previewSrc(): string {
    if (selectedId === null) return 'about:blank';
    const url = api.folders.previewUrl(selectedId, sections, setup);
    const token = getToken();
    return token ? `${url}&token=${encodeURIComponent(token)}` : url;
  }

  async function downloadPdf() {
    if (selectedId === null) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const url = api.folders.pdfUrl(selectedId, sections, setup);
      const token = getToken();
      const res = await fetch(url, {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `The PDF could not be made (${res.status}).`);
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `${selected?.workshopCode ?? 'packet'}-packet.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'The PDF could not be made.');
    } finally {
      setDownloading(false);
    }
  }

  /**
   * True when the folder differs from a freshly opened one — every sheet
   * ticked, default paper and margins. Drives the Reset button's enabled
   * state, so it never looks like an action that would do nothing.
   */
  const optionsChanged = useMemo(() => {
    const sameSections =
      sections.length === SECTION_ORDER.length &&
      SECTION_ORDER.every((k) => sections.includes(k));
    return (
      !sameSections ||
      setup.paper !== DEFAULT_SETUP.paper ||
      setup.orientation !== DEFAULT_SETUP.orientation ||
      setup.margin !== DEFAULT_SETUP.margin ||
      setup.copies !== DEFAULT_SETUP.copies
    );
  }, [sections, setup]);

  function resetOptions() {
    setSections(SECTION_ORDER);
    setSetup(DEFAULT_SETUP);
  }

  /**
   * Prints the packet.
   *
   * The iframe holds the real document, so its own print dialog is the
   * correct one — the browser paginates it with the `@page` rule the template
   * already sets. The preview's grey backdrop is screen-only, so it does not
   * reach paper. Cross-origin access is safe here: the iframe is served from
   * the same origin as the app.
   */
  function printPacket() {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  }

  const pageCount = detail?.pageCount ?? 0;

  return (
    <AppShell currentPath="/folders" title="Folder builder">
      <div className="page-head fb-head">
        <div>
          <h2>
            Packet preview
            {selected ? ` — ${selected.workshopCode ?? selected.workshopName}` : ''}
          </h2>
          <p>
            {pageCount > 0 ? `Page 1 of ${pageCount}` : 'No pages yet'} ·{' '}
            {detail
              ? `${detail.workshop.participantCount} participant${
                  detail.workshop.participantCount === 1 ? '' : 's'
                }`
              : 'Choose a workshop'}
          </p>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={resetOptions}
            disabled={!optionsChanged}
            title="Restore the default sheets and print setup"
          >
            Reset options
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={downloadPdf}
            disabled={selectedId === null || downloading}
          >
            {downloading ? 'Preparing…' : 'Download PDF'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={printPacket}
            disabled={selectedId === null}
            title="Open the print dialog for this packet"
          >
            Print packet
          </button>
        </div>
      </div>

      {downloadError && (
        <div className="alert alert-error" role="alert">
          <span>{downloadError}</span>
        </div>
      )}

      <div className="fb-layout">
        <aside className="fb-side">
          <div className="panel fb-panel">
            <div className="fb-panel-head">Workshop</div>
            <div className="fb-panel-body">
              <div className="field">
                <label htmlFor="fb-search" className="visually-hidden">
                  Find a workshop
                </label>
                <input
                  id="fb-search"
                  type="search"
                  placeholder="Code or workshop name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <ul className="fb-workshop-list">
                {workshops.isLoading ? (
                  <li className="fb-workshop-empty">Loading…</li>
                ) : rows.length === 0 ? (
                  <li className="fb-workshop-empty">No workshops match.</li>
                ) : (
                  rows.map((w: PacketWorkshopOption) => (
                    <li key={w.workshopId}>
                      <button
                        type="button"
                        className={`fb-workshop${w.workshopId === selectedId ? ' is-active' : ''}`}
                        onClick={() => setSelectedId(w.workshopId)}
                      >
                        <span className="fb-workshop-code">{w.workshopCode ?? '—'}</span>
                        <span className="fb-workshop-name">{w.workshopName}</span>
                        <span className="fb-workshop-meta">
                          {fmtShortDate(w.startDate)} · {w.participantCount} registered
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>

          <div className="panel fb-panel">
            <div className="fb-panel-head">Packet contents</div>
            <div className="fb-panel-body">
              {detail === null ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  Choose a workshop to see its pages.
                </p>
              ) : (
                <ul className="fb-contents">
                  {detail.sections.map((s) => (
                    <li key={s.kind} className={s.filled ? '' : 'is-blank'}>
                      <label className="fb-contents-row">
                        <input
                          type="checkbox"
                          checked={sections.includes(s.kind)}
                          onChange={() => toggleSection(s.kind)}
                        />
                        <span className="fb-contents-text">
                          <strong>{s.label}</strong>
                          <span className="fb-contents-pages">
                            {s.startPage === s.endPage
                              ? `p. ${s.startPage}`
                              : `p. ${s.startPage}–${s.endPage}`}
                          </span>
                          {s.note && <span className="fb-contents-note">{s.note}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="panel fb-panel">
            <div className="fb-panel-head">Print setup</div>
            <div className="fb-panel-body">
              <dl className="fb-setup">
                <dt>Paper</dt>
                <dd>
                  <select
                    aria-label="Paper"
                    value={setup.paper}
                    onChange={(e) =>
                      setSetup({ ...setup, paper: e.target.value as PacketPrintSetup['paper'] })
                    }
                  >
                    <option value="Letter">Letter</option>
                    <option value="Legal">Legal</option>
                  </select>
                </dd>

                <dt>Orientation</dt>
                <dd>
                  <select
                    aria-label="Orientation"
                    value={setup.orientation}
                    onChange={(e) =>
                      setSetup({
                        ...setup,
                        orientation: e.target.value as PacketPrintSetup['orientation'],
                      })
                    }
                  >
                    <option value="Portrait">Portrait</option>
                    <option value="Landscape">Landscape</option>
                  </select>
                </dd>

                <dt>Margins</dt>
                <dd>
                  <select
                    aria-label="Margins"
                    value={String(setup.margin)}
                    onChange={(e) => setSetup({ ...setup, margin: Number(e.target.value) })}
                  >
                    <option value="0.25">0.25 in</option>
                    <option value="0.5">0.5 in</option>
                    <option value="0.75">0.75 in</option>
                    <option value="1">1 in</option>
                  </select>
                </dd>

                <dt>Copies</dt>
                <dd>
                  <input
                    aria-label="Copies"
                    type="number"
                    min={1}
                    max={20}
                    value={setup.copies}
                    onChange={(e) =>
                      setSetup({ ...setup, copies: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                </dd>
              </dl>
            </div>
          </div>
        </aside>

        <div className="fb-main">
          {packet.isError && (
            <div className="alert alert-error" role="alert">
              <span>
                Could not build this packet.
                {packet.error instanceof Error ? ` ${packet.error.message}` : ''}
              </span>
            </div>
          )}

          {detail && detail.warnings.length > 0 && (
            <div className="alert alert-warn" role="status">
              <span>
                <strong>Some sheets will print blank.</strong>
                <ul style={{ margin: '6px 0 0 18px' }}>
                  {detail.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </span>
            </div>
          )}

          <div className="fb-preview">
            {selectedId === null ? (
              <div className="empty">
                <IconReports width={28} height={28} />
                <p style={{ marginTop: 10 }}>Choose a workshop to preview its folder.</p>
              </div>
            ) : (
              <iframe
                key={`${selectedId}-${sections.join(',')}-${setup.paper}-${setup.orientation}-${setup.margin}`}
                ref={frameRef}
                className="fb-frame"
                title="Packet preview"
                src={previewSrc()}
              />
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
