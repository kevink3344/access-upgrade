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
  const [type, setType] = useState<'CEU' | 'CHC'>('CEU');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('Certificate');
  const [subtitle, setSubtitle] = useState('of Attendance');
  const [layout, setLayout] = useState<'portrait' | 'landscape'>('portrait');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.certificates.createTemplate({
        schoolYearId,
        certificateType: type,
        name: name.trim() || null,
        title: title.trim() || 'Certificate',
        subtitle: subtitle.trim() || 'of Attendance',
        layout,
      }),
    onSuccess: (r) => onCreated(r.certificateTemplateId),
    onError: (e: Error) => setError(e.message),
  });

  const existingOfType = existingTypes.filter((t) => t === type).length;

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="cc-title">
        <h2 id="cc-title">New certificate</h2>

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
              <option value="CEU">CEU — Units of Renewal Credit</option>
              <option value="CHC">CHC — Child Care Hours</option>
            </select>
            {existingOfType > 0 && (
              <span className="field-hint">
                This year already has {existingOfType} {type} certificate
                {existingOfType === 1 ? '' : 's'}. A new one is added alongside them.
              </span>
            )}
          </div>

          <div className="field">
            <label htmlFor="cc-name">Name</label>
            <input
              id="cc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder={existingOfType > 0 ? 'e.g. Director certificate' : 'e.g. Standard certificate'}
            />
            <span className="field-hint">
              How staff tell this certificate apart from the others. Left blank, it is numbered.
            </span>
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
      </div>
    </div>
  );
}
