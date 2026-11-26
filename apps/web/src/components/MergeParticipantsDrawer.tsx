import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MergePreview, UtilityParticipant } from '@pe/shared';
import { api } from '../api';

/**
 * Merge two participants.
 *
 * Three steps, in order, and none can be skipped:
 *   1. choose the duplicate (source) and the record to keep (target)
 *   2. preview — what moves, what is dropped, and any blocker
 *   3. confirm — type the affected row count, then run with the preview token
 *
 * The token is what makes step 3 safe: the server refuses it if the data
 * changed since the preview, so the count on screen is always the count that
 * was approved.
 */
export function MergeParticipantsDrawer({
  initialSourceId,
  initialTargetId,
  onClose,
  onMerged,
}: {
  initialSourceId?: number | null;
  initialTargetId?: number | null;
  onClose: () => void;
  onMerged: (message: string) => void;
}) {
  const qc = useQueryClient();

  const [source, setSource] = useState<UtilityParticipant | null>(null);
  const [target, setTarget] = useState<UtilityParticipant | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Opened from a duplicate group, so the pair is already chosen.
  useEffect(() => {
    if (!initialSourceId || !initialTargetId) return;
    let cancelled = false;
    Promise.all([findParticipant(initialSourceId), findParticipant(initialTargetId)])
      .then(([s, t]) => {
        if (cancelled) return;
        setSource(s);
        setTarget(t);
      })
      .catch(() => {
        /* the picker still works if the prefill fails */
      });
    return () => {
      cancelled = true;
    };
  }, [initialSourceId, initialTargetId]);

  const previewMutation = useMutation({
    mutationFn: () => api.utilities.previewMerge(source!.participantId, target!.participantId),
    onSuccess: (p) => {
      setPreview(p);
      setTyped('');
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      api.utilities.runMerge({
        sourceParticipantId: source!.participantId,
        targetParticipantId: target!.participantId,
        token: preview!.token,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['utilities'] });
      onMerged(
        `Merged participant ${r.sourceParticipantId} into ${r.targetParticipantId}. ` +
          `${r.affectedRows} row${r.affectedRows === 1 ? '' : 's'} changed` +
          (r.deletedSource ? ', and the duplicate was removed.' : '.'),
      );
    },
    onError: (e: Error) => setError(e.message),
  });

  const affected = preview
    ? preview.moves.registrations +
      preview.moves.attendance +
      preview.moves.creditSlips +
      preview.moves.usedCreditSlips +
      preview.moves.certificateOverrides +
      preview.moves.certificateIssues +
      (preview.deletesSource ? 1 : 0)
    : 0;

  const blocked = (preview?.blockers.sharedWorkshops.length ?? 0) > 0;
  const confirmed = typed.trim() === String(affected) && affected > 0 && !blocked;

  function reset(nextSource: UtilityParticipant | null, nextTarget: UtilityParticipant | null) {
    setSource(nextSource);
    setTarget(nextTarget);
    setPreview(null);
    setTyped('');
    setError(null);
  }

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="drawer drawer-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-title"
      >
        <div className="drawer-head">
          <h2 id="merge-title">Merge two participants</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="drawer-body">
          {error && (
            <div className="alert alert-error" role="alert">
              <span>{error}</span>
            </div>
          )}

          <ol className="util-steps" aria-label="Merge steps">
            <li className={preview ? 'is-done' : 'is-active'}>Choose the pair</li>
            <li className={preview ? 'is-done' : ''}>Preview</li>
            <li className={preview && !blocked ? 'is-active' : ''}>Confirm</li>
          </ol>

          <ParticipantPicker
            id="util-merge-source"
            label="Duplicate to remove (source)"
            hint="Its registrations, attendance and credit slips move to the participant you keep."
            selected={source}
            onSelect={(p) => reset(p, target)}
            excludeId={target?.participantId}
            disabled={runMutation.isPending}
          />

          <ParticipantPicker
            id="util-merge-target"
            label="Participant to keep (target)"
            hint="The record that survives. Its own details are not overwritten."
            selected={target}
            onSelect={(p) => reset(source, p)}
            excludeId={source?.participantId}
            disabled={runMutation.isPending}
          />

          {!preview && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!source || !target || previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
            >
              {previewMutation.isPending ? 'Checking…' : 'Preview merge'}
            </button>
          )}

          {preview && (
            <>
              <div className="util-compare">
                <div className="util-compare-card">
                  <span className="util-compare-tag util-tag-remove">Remove</span>
                  <b>{name(preview.source)}</b>
                  <small>{preview.source.email ?? 'No email'}</small>
                  <ParticipantCounts p={preview.source} />
                </div>
                <div className="util-compare-arrow" aria-hidden="true">
                  →
                </div>
                <div className="util-compare-card">
                  <span className="util-compare-tag util-tag-keep">Keep</span>
                  <b>{name(preview.target)}</b>
                  <small>{preview.target.email ?? 'No email'}</small>
                  <ParticipantCounts p={preview.target} />
                </div>
              </div>

              <div className="panel util-panel">
                <div className="panel-head">
                  <h3>What will change</h3>
                  <span className="hint">{affected} row{affected === 1 ? '' : 's'}</span>
                </div>
                <table className="data-table">
                  <tbody>
                    <MoveRow label="Registrations" n={preview.moves.registrations} />
                    <MoveRow label="Attendance records" n={preview.moves.attendance} />
                    <MoveRow label="Credit slips issued" n={preview.moves.creditSlips} />
                    <MoveRow label="Credit slips used" n={preview.moves.usedCreditSlips} />
                    <MoveRow label="Certificate overrides" n={preview.moves.certificateOverrides} />
                    <MoveRow label="Issued certificates" n={preview.moves.certificateIssues} />
                    <tr>
                      <td>
                        {preview.deletesSource
                          ? 'The duplicate participant record is deleted'
                          : 'The duplicate participant record is kept (it still has history)'}
                      </td>
                      <td className="num">{preview.deletesSource ? 1 : 0}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {blocked && (
                <div className="alert alert-error" role="alert">
                  <div>
                    <b>This merge is blocked.</b> Both participants are registered for the same
                    workshop, so merging would create a duplicate enrolment. Cancel one of those
                    registrations first.
                    <ul className="util-conflict-list">
                      {preview.blockers.sharedWorkshops.map((w) => (
                        <li key={`${w.workshopId}-${w.workshopCode}`}>
                          {w.workshopName ?? w.workshopCode ?? `Workshop ${w.workshopId}`}
                          {w.startDate ? ` — ${w.startDate}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {preview.blockers.notes.length > 0 && (
                <div className="alert alert-warn" role="status">
                  <div>
                    {preview.blockers.notes.map((n) => (
                      <p key={n} style={{ margin: '0 0 4px' }}>
                        {n}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {!blocked && (
                <div className="field util-confirm">
                  <label htmlFor="util-merge-confirm">
                    Type <b>{affected}</b> to confirm
                  </label>
                  <input
                    id="util-merge-confirm"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                    disabled={runMutation.isPending}
                  />
                  <span className="field-hint">
                    This is the number of rows the merge will change. Typing it is the last check
                    before real records move.
                  </span>
                </div>
              )}

              <div className="drawer-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setPreview(null);
                    setTyped('');
                    setError(null);
                  }}
                  disabled={runMutation.isPending}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!confirmed || runMutation.isPending}
                  onClick={() => runMutation.mutate()}
                >
                  {runMutation.isPending ? 'Merging…' : 'Merge participants'}
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function name(p: { firstName: string | null; lastName: string | null }): string {
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unnamed participant';
}

function ParticipantCounts({ p }: { p: UtilityParticipant }) {
  return (
    <span className="util-compare-counts">
      {p.registrationCount} reg · {p.attendanceCount} att · {p.creditSlipCount} slip
      {p.creditSlipCount === 1 ? '' : 's'} · {p.certificateCount} cert
      {p.certificateCount === 1 ? '' : 's'}
    </span>
  );
}

function MoveRow({ label, n }: { label: string; n: number }) {
  return (
    <tr className={n === 0 ? 'util-move-empty' : undefined}>
      <td>{label}</td>
      <td className="num">{n}</td>
    </tr>
  );
}

/** Looks a participant up by id for the prefill path. */
async function findParticipant(id: number): Promise<UtilityParticipant | null> {
  const r = await api.utilities.participants({ q: '', pageSize: 50 });
  const found = r.data.find((p) => p.participantId === id);
  if (found) return found;
  // Not on the first page: search by id is not supported, so fall back to the
  // participants endpoint which returns the full row.
  const detail = await api.participants.get(id);
  const d = detail as unknown as Record<string, unknown>;
  return {
    participantId: id,
    firstName: (d.FirstName as string | null) ?? null,
    lastName: (d.LastName as string | null) ?? null,
    email: (d.Email as string | null) ?? null,
    agencyName: (d.AgencyName as string | null) ?? null,
    registrationCount: 0,
    attendanceCount: 0,
    creditSlipCount: 0,
    certificateCount: 0,
    hasCeuCertificate: d.HasCeuCertificate === true,
    hasChcCertificate: d.HasChcCertificate === true,
    dateOfEntry: null,
    updatedAt: null,
  };
}

/**
 * A searchable participant picker over the utility endpoint.
 *
 * Not the shared Typeahead: that one requires two characters and returns a
 * bare label, and the merge needs the linked-record counts so the admin can
 * see which row is the duplicate before choosing.
 */
function ParticipantPicker({
  id,
  label,
  hint,
  selected,
  onSelect,
  excludeId,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  selected: UtilityParticipant | null;
  onSelect: (p: UtilityParticipant | null) => void;
  excludeId?: number;
  disabled?: boolean;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useQuery({
    queryKey: ['utilities', 'participants', debounced],
    queryFn: () => api.utilities.participants({ q: debounced || undefined, pageSize: 20 }),
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
  });

  const options = useMemo(
    () => (data?.data ?? []).filter((p) => p.participantId !== excludeId),
    [data, excludeId],
  );

  return (
    <div className="field util-picker">
      <label htmlFor={id}>{label}</label>
      {hint && <span className="field-hint">{hint}</span>}

      {selected ? (
        <div className="typeahead-selected">
          <span>
            {name(selected)} — {selected.email ?? 'no email'}
          </span>
          <button
            type="button"
            className="typeahead-clear"
            onClick={() => {
              onSelect(null);
              setQ('');
            }}
            disabled={disabled}
            aria-label={`Clear ${label}`}
          >
            ×
          </button>
        </div>
      ) : (
        <>
          <input
            id={id}
            type="search"
            value={q}
            placeholder="Search by name or email"
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-list`}
          />
          {open && debounced.length >= 2 && (
            <ul className="typeahead-list" id={`${id}-list`} role="listbox">
              {isFetching && <li className="typeahead-empty">Searching…</li>}
              {!isFetching && options.length === 0 && (
                <li className="typeahead-empty">No matches</li>
              )}
              {options.map((p) => (
                <li key={p.participantId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => {
                      onSelect(p);
                      setOpen(false);
                      setQ('');
                    }}
                  >
                    <span className="util-option-name">{name(p)}</span>
                    <span className="util-option-meta">
                      {p.email ?? 'no email'} · {p.registrationCount} reg ·{' '}
                      {p.attendanceCount} att
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
