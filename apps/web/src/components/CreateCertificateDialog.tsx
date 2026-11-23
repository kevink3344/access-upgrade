import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api';

/**
 * Creates a certificate template for a school year.
 *
 * Only two types exist (CEU and CHC), so the dialog disables whichever is
 * already present rather than letting the server return a 409.
 */
export function CreateCertificateDialog({
  schoolYearId,
  existingTypes,
  onClose,
  onCreated,
}: {
  schoolYearId: number;
  existingTypes: string[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [type, setType] = useState<'CEU' | 'CHC'>(existingTypes.includes('CEU') ? 'CHC' : 'CEU');
  const [title, setTitle] = useState('Certificate');
  const [subtitle, setSubtitle] = useState('of Attendance');
  const [layout, setLayout] = useState<'portrait' | 'landscape'>('portrait');
  const [error, setError] = useState<string | null>(null);

  const bothExist = existingTypes.includes('CEU') && existingTypes.includes('CHC');

  const create = useMutation({
    mutationFn: () =>
      api.certificates.createTemplate({
        schoolYearId,
        certificateType: type,
        title: title.trim() || 'Certificate',
        subtitle: subtitle.trim() || 'of Attendance',
        layout,
      }),
    onSuccess: (r) => onCreated(r.certificateTemplateId),
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="cc-title">
        <h2 id="cc-title">New certificate</h2>

        {bothExist ? (
          <>
            <p>
              This school year already has both a CEU and a CHC certificate. Edit the existing
              one in the Certificate Designer.
            </p>
            <div className="drawer-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              create.mutate();
            }}
            noValidate
          >
            {error && (
              <div className="alert alert-error" role="alert">
                <span>{error}</span>
              </div>
            )}

            <div className="field">
              <label htmlFor="cc-type">Certificate type</label>
              <select
                id="cc-type"
                value={type}
                onChange={(e) => setType(e.target.value as 'CEU' | 'CHC')}
              >
                <option value="CEU" disabled={existingTypes.includes('CEU')}>
                  CEU — Units of Renewal Credit
                  {existingTypes.includes('CEU') ? ' (already exists)' : ''}
                </option>
                <option value="CHC" disabled={existingTypes.includes('CHC')}>
                  CHC — Child Care Hours
                  {existingTypes.includes('CHC') ? ' (already exists)' : ''}
                </option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="cc-title-input">Title</label>
              <input
                id="cc-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
              />
            </div>

            <div className="field">
              <label htmlFor="cc-subtitle">Subtitle</label>
              <input
                id="cc-subtitle"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                maxLength={500}
              />
            </div>

            <div className="field">
              <label htmlFor="cc-layout">Layout</label>
              <select
                id="cc-layout"
                value={layout}
                onChange={(e) => setLayout(e.target.value as 'portrait' | 'landscape')}
              >
                <option value="portrait">Portrait — 8.5 × 11 in</option>
                <option value="landscape">Landscape — 11 × 8.5 in</option>
              </select>
            </div>

            <p className="field-hint">
              The new template copies sensible defaults. Edit the logo, signatories and fields
              in the Certificate Designer afterwards.
            </p>

            <div className="drawer-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create certificate'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
