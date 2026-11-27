import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, getToken } from '../api';

/**
 * The form's own banner.
 *
 * The image is one combined banner staff make themselves — logo, title and
 * photographs in a single file — so this is an upload, not a designer. The
 * bytes live in the same store the certificate designer uses, which is why
 * the size limit and the accepted types match it.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

export function FormHeaderPanel({
  formTemplateId,
  canEdit,
}: {
  formTemplateId: number;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [altText, setAltText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Object URL of the image currently on screen, revoked on change. */
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['form-header', formTemplateId],
    queryFn: () => api.forms.header(formTemplateId),
  });

  useEffect(() => {
    if (data) setAltText(data.headerAltText ?? '');
  }, [data]);

  // The authenticated image route needs the bearer token, which an <img>
  // cannot send, so the bytes are fetched once and shown from a blob URL.
  useEffect(() => {
    if (!data?.headerImageUrl) {
      setPreviewSrc(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    const token = getToken();
    void fetch(data.headerImageUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('Header image unavailable'))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreviewSrc(url);
      })
      .catch(() => {
        if (!cancelled) setPreviewSrc(null);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [data?.headerImageUrl]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['form-header', formTemplateId] });
    // The preview and the public page both read the banner.
    void qc.invalidateQueries({ queryKey: ['form-preview', formTemplateId] });
  };

  const upload = useMutation({
    mutationFn: (body: { data: string; contentType: string; fileName: string; altText: string }) =>
      api.forms.uploadHeader(formTemplateId, body),
    onSuccess: () => {
      setNotice('Header image saved.');
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof HttpError ? e.message : 'Could not save the image.'),
  });

  const remove = useMutation({
    mutationFn: () => api.forms.removeHeader(formTemplateId),
    onSuccess: () => {
      setNotice('Header image removed — the standard lockup is back.');
      setError(null);
      if (fileRef.current) fileRef.current.value = '';
      refresh();
    },
    onError: (e) => setError(e instanceof HttpError ? e.message : 'Could not remove the image.'),
  });

  async function onPick(file: File | undefined) {
    setError(null);
    setNotice(null);
    if (!file) return;

    if (!ACCEPTED.includes(file.type)) {
      setError('Use a PNG, JPEG or WebP image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('That image is larger than 2 MB. Resize it and try again.');
      return;
    }
    if (!altText.trim()) {
      setError('Describe the image first — the form’s heading is inside the picture.');
      return;
    }

    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.readAsDataURL(file);
    }).catch((e: Error) => {
      setError(e.message);
      return null;
    });
    if (data === null) return;

    upload.mutate({ data, contentType: file.type, fileName: file.name, altText: altText.trim() });
  }

  const busy = upload.isPending || remove.isPending;

  return (
    <div className="form-header-panel">
      <div className="form-header-panel-head">
        <h3>Header image</h3>
        <p className="field-hint">
          Replaces the standard Project Enlightenment lockup on this form’s public page.
          Use one combined banner — the logo and title baked into a single image.
        </p>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="alert alert-info" role="status">
          <span>{notice}</span>
        </div>
      )}

      {previewSrc && (
        <figure className="form-header-preview">
          <img src={previewSrc} alt={data?.headerAltText ?? ''} />
        </figure>
      )}

      <div className="field">
        <label htmlFor="form-header-alt">
          Image description{' '}
          <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>
            (required — read aloud to screen-reader users)
          </span>
        </label>
        <input
          id="form-header-alt"
          value={altText}
          maxLength={200}
          onChange={(e) => setAltText(e.target.value)}
          placeholder="e.g. Training Requests — Project Enlightenment banner"
          disabled={!canEdit || busy}
        />
      </div>

      {canEdit && (
        <div className="row-actions">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            id="form-header-file"
            onChange={(e) => void onPick(e.target.files?.[0])}
            disabled={busy}
          />
          <label htmlFor="form-header-file" className="btn btn-ghost" aria-disabled={busy}>
            {upload.isPending ? 'Uploading…' : data?.hasHeaderImage ? 'Replace image' : 'Upload image'}
          </label>
          {data?.hasHeaderImage && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => remove.mutate()}
              disabled={busy}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
