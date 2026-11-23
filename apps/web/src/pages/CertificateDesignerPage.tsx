import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CertificateType } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { CertificateTemplatePanel } from '../components/CertificateTemplatePanel';
import { CreateCertificateDialog } from '../components/CreateCertificateDialog';

/**
 * Where a certificate is designed.
 *
 * Kept separate from the Certificates screen, which is where staff *issue*
 * them. The split mirrors the Form Designer: one place to change what the
 * document looks like, another to use it — so issuing a certificate cannot
 * accidentally change the template everyone else is printing.
 */
export function CertificateDesignerPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const qc = useQueryClient();

  const [schoolYearId, setSchoolYearId] = useState<number | null>(null);
  const [certType, setCertType] = useState<CertificateType>('CEU');
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: years } = useQuery({
    queryKey: ['lookup', 'school-years'],
    queryFn: () => api.lookups.get('school-years'),
    staleTime: 10 * 60_000,
  });

  useEffect(() => {
    if (schoolYearId === null && years?.data?.length) {
      setSchoolYearId(years.data[0]!.id);
    }
  }, [years, schoolYearId]);

  const { data: templates } = useQuery({
    queryKey: ['certificates', 'templates', schoolYearId],
    queryFn: () => api.certificates.templates(schoolYearId!),
    enabled: schoolYearId !== null,
  });

  // The preview renders against a real attendee — a certificate with blank
  // fields would not show staff what actually prints. One eligible
  // participant for the year is enough; the designer has no roster of its own.
  const { data: sample } = useQuery({
    queryKey: ['certificates', 'sample', schoolYearId],
    queryFn: () => api.certificates.eligible({ schoolYearId: schoolYearId!, page: 1, pageSize: 1 }),
    enabled: schoolYearId !== null,
    staleTime: 5 * 60_000,
  });

  const sampleParticipantId = sample?.data?.[0]?.ParticipantID ?? null;

  // Several templates may exist per type, so the designer needs to know which
  // one is being edited. Default to the first for the selected type.
  const forType = (templates?.data ?? []).filter((t) => t.CertificateType === certType);
  const activeTemplateId =
    forType.find((t) => t.CertificateTemplateID === selectedTemplateId)?.CertificateTemplateID ??
    forType[0]?.CertificateTemplateID ??
    null;

  return (
    <AppShell currentPath="/admin/certificates" title="Certificate Designer">
      <div className="page-head">
        <div>
          <h2>Certificate Designer</h2>
          <p>
            Design the CEU and CHC certificates staff issue. A school year can have more than
            one of each — for example a director's certificate and a teacher's.
          </p>
        </div>
        {canEdit && schoolYearId !== null && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreateOpen(true)}
          >
            + Certificate
          </button>
        )}
      </div>

      {notice && (
        <div className="alert alert-info" role="status">
          <span>{notice}</span>
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-field">
          <label htmlFor="cd-year">School year</label>
          <select
            id="cd-year"
            value={schoolYearId ?? ''}
            onChange={(e) => {
              setSchoolYearId(Number(e.target.value));
              setSelectedTemplateId(null);
            }}
          >
            {(years?.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>{y.label}</option>
            ))}
          </select>
        </div>

        <div className="toolbar-field">
          <label htmlFor="cd-type">Certificate type</label>
          <select
            id="cd-type"
            value={certType}
            onChange={(e) => {
              setCertType(e.target.value as CertificateType);
              setSelectedTemplateId(null);
            }}
          >
            <option value="CEU">CEU — Units of Renewal Credit</option>
            <option value="CHC">CHC — Child Care Hours</option>
          </select>
        </div>

        <div className="toolbar-field">
          <label htmlFor="cd-template">Template</label>
          <select
            id="cd-template"
            value={activeTemplateId ?? ''}
            onChange={(e) => setSelectedTemplateId(Number(e.target.value))}
            disabled={forType.length === 0}
          >
            {forType.length === 0 ? (
              <option value="">None yet</option>
            ) : (
              forType.map((t) => (
                <option key={t.CertificateTemplateID} value={t.CertificateTemplateID}>
                  {t.Name ?? `${t.CertificateType} ${t.CertificateTemplateID}`}
                </option>
              ))
            )}
          </select>
        </div>

        <span className="toolbar-count">
          {forType.length === 0
            ? `No ${certType} template for this year yet`
            : `${forType.length} ${certType} template${forType.length === 1 ? '' : 's'} for this year`}
        </span>
      </div>

      {schoolYearId !== null && (
        <>
          {sampleParticipantId === null && (
            <div className="alert alert-info" role="status">
              <span>
                No participant is eligible for a certificate in this school year yet, so the
                preview has nothing to render against. Settings can still be saved.
              </span>
            </div>
          )}
          <CertificateTemplatePanel
            schoolYearId={schoolYearId}
            certificateType={certType}
            canEdit={!!canEdit}
            sampleParticipantId={sampleParticipantId}
            templateId={activeTemplateId}
          />
        </>
      )}

      {createOpen && schoolYearId !== null && (
        <CreateCertificateDialog
          schoolYearId={schoolYearId}
          existingTypes={(templates?.data ?? []).map((t) => t.CertificateType)}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            setSelectedTemplateId(id);
            setNotice('Certificate template created.');
            qc.invalidateQueries({ queryKey: ['certificates', 'templates', schoolYearId] });
          }}
        />
      )}
    </AppShell>
  );
}
