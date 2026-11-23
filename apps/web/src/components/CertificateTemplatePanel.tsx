import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CertificateFieldVisibility, CertificateType } from '@pe/shared';
import { api } from '../api';

const FIELD_LABELS: { key: keyof CertificateFieldVisibility; label: string; hint?: string }[] = [
  { key: 'name', label: 'Participant name' },
  { key: 'certificateType', label: 'Certificate type' },
  { key: 'programTitle', label: 'School year / program' },
  { key: 'programDirector', label: 'Program director signature' },
  { key: 'inclusiveDates', label: 'Inclusive dates' },
  { key: 'unitsOfRenewalCredit', label: 'Units of renewal credit' },
  { key: 'agency', label: 'School / agency' },
  { key: 'employedBy', label: 'Employed by' },
  { key: 'roleFlags', label: 'Substitute / Assistant / Teacher flags' },
  { key: 'ssn', label: 'Social Security Number', hint: 'Sensitive — off by default' },
  { key: 'homeAddress', label: 'Home address', hint: 'Unnecessary exposure — off by default' },
  { key: 'expirationDate', label: 'Certificate expiration date' },
];

/**
 * Template settings with a live preview against a real attendee.
 *
 * The preview is the key affordance: staff see the actual layout with real
 * data before saving, which is what makes these settings safe to change
 * without a developer (plan §8.6.4).
 */
export function CertificateTemplatePanel({
  schoolYearId,
  certificateType,
  canEdit,
  sampleParticipantId,
  templateId,
}: {
  schoolYearId: number;
  certificateType: CertificateType;
  canEdit: boolean;
  sampleParticipantId: number | null;
  /** Which template to edit when a year has several of this type. */
  templateId?: number | null;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['certificates', 'templates', schoolYearId],
    queryFn: () => api.certificates.templates(schoolYearId),
  });

  // Several templates may exist per year and type. An explicit id wins;
  // otherwise the first is used, which is what existed before multiple
  // templates were allowed.
  const template =
    (templateId
      ? data?.data.find((t) => t.CertificateTemplateID === templateId)
      : data?.data.find((t) => t.CertificateType === certificateType)) ?? null;

  const [form, setForm] = useState({
    title: '',
    subtitle: '',
    programDirectorName: '',
    programDirectorTitle: '',
    approvingDirectorName: '',
    approvingDirectorTitle: '',
    creditUnitLabel: '',
    footerText: '',
  });
  const [visible, setVisible] = useState<CertificateFieldVisibility | null>(null);
  const [layout, setLayout] = useState<'portrait' | 'landscape'>('portrait');
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [previewScale, setPreviewScale] = useState(0.62);
  const previewColRef = useRef<HTMLDivElement>(null);

  // Scale the true-size page to fill the preview column, so landscape and
  // portrait both use the full width instead of leaving dead space.
  useEffect(() => {
    const el = previewColRef.current;
    if (!el) return;

    const pageInches = layout === 'landscape' ? 11 : 8.5;
    const recalc = () => {
      const width = el.getBoundingClientRect().width;
      // 1in = 96px in CSS.
      if (width > 0) setPreviewScale(width / (pageInches * 96));
    };

    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]);

  useEffect(() => {
    if (!template) return;
    setForm({
      title: template.Title ?? '',
      subtitle: template.Subtitle ?? '',
      programDirectorName: template.ProgramDirectorName ?? '',
      programDirectorTitle: template.ProgramDirectorTitle ?? '',
      approvingDirectorName: template.ApprovingDirectorName ?? '',
      approvingDirectorTitle: template.ApprovingDirectorTitle ?? '',
      creditUnitLabel: template.CreditUnitLabel ?? '',
      footerText: template.FooterText ?? '',
    });
    setVisible(template.VisibleFields);
    setLayout(template.Layout === 'landscape' ? 'landscape' : 'portrait');
    setDirty(false);
  }, [template]);

  // Refresh the preview whenever anything changes. The endpoint renders the
  // saved template, so the preview reflects what will print after saving.
  useEffect(() => {
    if (!sampleParticipantId) {
      setPreviewHtml('');
      return;
    }
    const url = api.certificates.previewUrl(
      sampleParticipantId,
      schoolYearId,
      certificateType,
      template?.CertificateTemplateID ?? null,
    );
    let cancelled = false;
    fetch(url, {
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem('pe.access_token') ?? localStorage.getItem('pe.access_token') ?? ''}`,
      },
    })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Preview failed (${r.status})`))))
      .then((html) => !cancelled && setPreviewHtml(html))
      .catch(() => !cancelled && setPreviewHtml(''));
    return () => {
      cancelled = true;
    };
  }, [sampleParticipantId, schoolYearId, certificateType, template?.UpdatedAt]);

  const save = useMutation({
    mutationFn: () =>
      api.certificates.updateTemplate(template!.CertificateTemplateID, {
        title: form.title || null,
        subtitle: form.subtitle || null,
        programDirectorName: form.programDirectorName || null,
        programDirectorTitle: form.programDirectorTitle || null,
        approvingDirectorName: form.approvingDirectorName || null,
        approvingDirectorTitle: form.approvingDirectorTitle || null,
        creditUnitLabel: form.creditUnitLabel || null,
        footerText: form.footerText || null,
        visibleFields: visible ?? undefined,
        layout,
      }),
    onSuccess: () => {
      setNotice('Template saved. Certificates generated from now on use these settings.');
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['certificates', 'templates', schoolYearId] });
    },
    onError: (e: Error) => setNotice(e.message),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the file'));
        reader.readAsDataURL(file);
      });
      return api.certificates.uploadLogo(template!.CertificateTemplateID, {
        data: dataUri,
        contentType: file.type,
        fileName: file.name,
      });
    },
    onSuccess: () => {
      setNotice('Logo updated.');
      qc.invalidateQueries({ queryKey: ['certificates', 'templates', schoolYearId] });
    },
    onError: (e: Error) => setNotice(e.message),
  });

  if (isLoading) {
    return (
      <div className="panel">
        <div className="panel-body panel-body-padded">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />
          ))}
        </div>
      </div>
    );
  }

  if (!template) {
    return (
      <div className="panel">
        <div className="panel-body panel-body-padded">
          <div className="empty">
            <p>No template exists for this school year and certificate type.</p>
          </div>
        </div>
      </div>
    );
  }

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function toggle(key: keyof CertificateFieldVisibility) {
    setVisible((v) => (v ? { ...v, [key]: !v[key] } : v));
    setDirty(true);
  }

  return (
    <div className="cert-template-layout">
      <div className="panel">
        <div className="panel-body panel-body-padded">
          {notice && (
            <div className="alert alert-info" role="status">
              <span>{notice}</span>
            </div>
          )}

          <fieldset className="fieldset" disabled={!canEdit}>
            <legend>Logo</legend>
            <div className="cert-logo-row">
              <div className="cert-logo-preview">
                {template.HasLogo ? (
                  <img
                    src={`/api/certificates/templates/${template.CertificateTemplateID}/logo?t=${encodeURIComponent(template.UpdatedAt)}`}
                    alt="Current logo"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <span>No logo</span>
                )}
              </div>
              <div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload.mutate(f);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!canEdit || upload.isPending}
                  onClick={() => fileRef.current?.click()}
                >
                  {upload.isPending ? 'Uploading…' : 'Upload logo'}
                </button>
                <p className="field-hint" style={{ marginTop: 6 }}>
                  PNG, JPEG, SVG or WebP, up to 2 MB. Stored in the database.
                </p>
              </div>
            </div>
          </fieldset>

          <fieldset className="fieldset" disabled={!canEdit}>
            <legend>Layout</legend>
            <div className="field">
              <label htmlFor="t-layout">Page orientation</label>
              <select
                id="t-layout"
                value={layout}
                onChange={(e) => {
                  setLayout(e.target.value as 'portrait' | 'landscape');
                  setDirty(true);
                }}
              >
                <option value="portrait">Portrait — 8.5 × 11 in</option>
                <option value="landscape">Landscape — 11 × 8.5 in</option>
              </select>
              <span className="field-hint">
                Landscape fits more across the page, so the type scale is reduced slightly to keep
                everything on one sheet. The preview updates when you save.
              </span>
            </div>
          </fieldset>

          <fieldset className="fieldset" disabled={!canEdit}>
            <legend>Text</legend>
            <div className="field">
              <label htmlFor="t-title">Title</label>
              <input id="t-title" value={form.title} onChange={(e) => set('title', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="t-subtitle">Subtitle</label>
              <input
                id="t-subtitle"
                value={form.subtitle}
                onChange={(e) => set('subtitle', e.target.value)}
              />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="t-pd-name">Program director name</label>
                <input
                  id="t-pd-name"
                  value={form.programDirectorName}
                  onChange={(e) => set('programDirectorName', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="t-pd-title">Program director title</label>
                <input
                  id="t-pd-title"
                  value={form.programDirectorTitle}
                  onChange={(e) => set('programDirectorTitle', e.target.value)}
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="t-ad-name">Approving director name</label>
                <input
                  id="t-ad-name"
                  value={form.approvingDirectorName}
                  onChange={(e) => set('approvingDirectorName', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="t-ad-title">Approving director title</label>
                <input
                  id="t-ad-title"
                  value={form.approvingDirectorTitle}
                  onChange={(e) => set('approvingDirectorTitle', e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="t-units">Credit unit label</label>
              <input
                id="t-units"
                value={form.creditUnitLabel}
                onChange={(e) => set('creditUnitLabel', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="t-footer">Footer disclaimer</label>
              <textarea
                id="t-footer"
                rows={2}
                value={form.footerText}
                onChange={(e) => set('footerText', e.target.value)}
              />
            </div>
          </fieldset>

          <fieldset className="fieldset" disabled={!canEdit}>
            <legend>Fields that print</legend>
            <div className="checkbox-grid">
              {FIELD_LABELS.map((f) => (
                <label key={f.key} className="checkbox" title={f.hint}>
                  <input
                    type="checkbox"
                    checked={visible?.[f.key] ?? false}
                    onChange={() => toggle(f.key)}
                  />
                  <span>
                    {f.label}
                    {f.hint && (
                      <span className="field-hint" style={{ display: 'block', marginTop: 0 }}>
                        {f.hint}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {canEdit && (
            <div className="drawer-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : 'Save template'}
              </button>
            </div>
          )}

          <p className="field-hint" style={{ marginTop: 12 }}>
            Layout, field positions, page size and fonts are fixed. Certificates already issued keep
            the template they were issued with.
          </p>
        </div>
      </div>

      <div className="cert-preview-column" ref={previewColRef}>
        <div className="cert-preview-label">
          Live preview
          {sampleParticipantId ? '' : ' — no eligible participant to preview against'}
        </div>
        {previewHtml ? (
          <div
            className="cert-preview-scaler"
            style={
              {
                '--cert-scale': previewScale,
                // Reserve the scaled height so the sticky column does not jump.
                height: `calc(${layout === 'landscape' ? '8.5in' : '11in'} * ${previewScale})`,
              } as React.CSSProperties
            }
          >
            <iframe
              className={`cert-preview-frame cert-preview-${layout}`}
              title="Certificate preview"
              srcDoc={previewHtml}
              sandbox=""
            />
          </div>
        ) : (
          <div className="cert-preview-empty">Preview unavailable</div>
        )}
      </div>
    </div>
  );
}
