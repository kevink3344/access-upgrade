import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CertificateEligibleRow, CertificateType } from '@pe/shared';
import { api } from '../api';
import { useScrollLock } from '../hooks/useScrollLock';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { IconAlert } from './icons';

/**
 * Per-participant certificate content.
 *
 * Separate from the template because the template is shared by everyone in a
 * school year — text added there would appear on every certificate. These
 * values apply to one person only.
 */
export function CertificateOverrideDrawer({
  participant,
  schoolYearId,
  certificateType,
  onClose,
}: {
  participant: CertificateEligibleRow;
  schoolYearId: number;
  certificateType: CertificateType;
  onClose: () => void;
}) {
  useScrollLock();
  const resize = useResizableDrawer('pe.drawerWidth.certificateOverride');
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const name = [participant.FirstName, participant.MiddleName, participant.LastName]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');

  const { data, isLoading } = useQuery({
    queryKey: ['certificates', 'override', participant.ParticipantID, schoolYearId, certificateType],
    queryFn: () => api.certificates.override(participant.ParticipantID, schoolYearId, certificateType),
  });

  const existing = data?.data ?? null;

  const [customText, setCustomText] = useState('');
  const [customTextLabel, setCustomTextLabel] = useState('');
  const [imageAltText, setImageAltText] = useState('');
  const [placement, setPlacement] = useState<'header' | 'body' | 'footer'>('body');
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageContentType, setImageContentType] = useState<string>('image/png');
  const [imageFileName, setImageFileName] = useState<string>('');
  const [hasExistingImage, setHasExistingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!existing) return;
    setCustomText(existing.CustomText ?? '');
    setCustomTextLabel(existing.CustomTextLabel ?? '');
    setImageAltText(existing.ImageAltText ?? '');
    setPlacement(existing.ImagePlacement ?? 'body');
    setHasExistingImage(existing.ImageAssetID !== null);
  }, [existing]);

  const save = useMutation({
    mutationFn: () =>
      api.certificates.saveOverride(participant.ParticipantID, {
        schoolYearId,
        certificateType,
        customText: customText.trim() || null,
        customTextLabel: customTextLabel.trim() || null,
        imageAltText: imageAltText.trim() || null,
        imagePlacement: placement,
        imageData,
        imageContentType,
        imageFileName,
      }),
    onSuccess: () => {
      setNotice('Saved. This applies to this participant only.');
      setImageData(null);
      qc.invalidateQueries({
        queryKey: ['certificates', 'override', participant.ParticipantID, schoolYearId, certificateType],
      });
    },
    onError: (e: Error) => setError(e.message),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    // An image without alt text is an accessibility defect; the API and the
    // database both refuse it, so catch it here with a clear message.
    if ((imageData || hasExistingImage) && !imageAltText.trim()) {
      setError('Alt text is required when an image is attached. Describe the image for screen readers.');
      return;
    }

    save.mutate();
  }

  function onPickFile(file: File | null) {
    if (!file) return;
    setError(null);
    if (file.size > 2 * 1024 * 1024) {
      setError('Image is larger than 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageData(String(reader.result));
      setImageContentType(file.type);
      setImageFileName(file.name);
      setHasExistingImage(true);
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsDataURL(file);
  }

  return (
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="drawer drawer-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="co-title"
        ref={resize.drawerRef}
        style={resize.drawerStyle}
      >
        <DrawerResizeHandle dragging={resize.dragging} handleProps={resize.handleProps} />
        <header className="drawer-head">
          <h2 id="co-title">Certificate for {name || 'participant'}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {isLoading ? (
          <div className="drawer-body">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 44, marginBottom: 12 }} />
            ))}
          </div>
        ) : (
          <form className="drawer-body" onSubmit={onSubmit} noValidate>
            {error && (
              <div className="alert alert-error" role="alert">
                <IconAlert width={18} height={18} />
                <span>{error}</span>
              </div>
            )}
            {notice && (
              <div className="alert alert-info" role="status">
                <span>{notice}</span>
              </div>
            )}

            <div className="alert alert-info" role="note">
              <span>
                These values appear on <strong>{name}</strong>'s {certificateType} certificate only.
                Everyone else uses the shared template.
              </span>
            </div>

            <fieldset className="fieldset">
              <legend>Additional text</legend>
              <div className="field">
                <label htmlFor="co-label">Label (optional)</label>
                <input
                  id="co-label"
                  maxLength={100}
                  placeholder="e.g. Awarded for"
                  value={customTextLabel}
                  onChange={(e) => setCustomTextLabel(e.target.value)}
                />
                <span className="field-hint">Shown before the text, followed by a colon.</span>
              </div>
              <div className="field">
                <label htmlFor="co-text">Text</label>
                <textarea
                  id="co-text"
                  rows={3}
                  maxLength={500}
                  placeholder="Anything you want printed on this certificate."
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                />
                <span className="field-hint">{customText.length}/500 characters</span>
              </div>
            </fieldset>

            <fieldset className="fieldset">
              <legend>Image</legend>
              <div className="field">
                <label htmlFor="co-image">Image file</label>
                <input
                  ref={fileRef}
                  id="co-image"
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                />
                <span className="field-hint">
                  PNG, JPEG, SVG or WebP, up to 2 MB. {hasExistingImage ? 'An image is attached.' : 'No image attached.'}
                </span>
              </div>

              <div className="field">
                <label htmlFor="co-alt">
                  Alt text {hasExistingImage && <span aria-hidden="true">*</span>}
                </label>
                <input
                  id="co-alt"
                  maxLength={200}
                  value={imageAltText}
                  onChange={(e) => setImageAltText(e.target.value)}
                  aria-required={hasExistingImage}
                  placeholder="Describe the image for screen readers"
                />
                <span className="field-hint">
                  Required when an image is attached. The certificate must stay readable by a screen
                  reader.
                </span>
              </div>

              <div className="field">
                <label htmlFor="co-placement">Placement</label>
                <select
                  id="co-placement"
                  value={placement}
                  onChange={(e) => setPlacement(e.target.value as 'header' | 'body' | 'footer')}
                >
                  <option value="header">Above the title</option>
                  <option value="body">Below the text</option>
                  <option value="footer">Above the signatures</option>
                </select>
              </div>
            </fieldset>

            <div className="drawer-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
