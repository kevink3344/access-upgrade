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

  const existingTypes = (templates?.data ?? []).map((t) => t.CertificateType);
  const bothExist = existingTypes.includes('CEU') && existingTypes.includes('CHC');

  return (
    <AppShell currentPath="/admin/certificates" title="Certificate Designer">
      <div className="page-head">
        <div>
          <h2>Certificate Designer</h2>
          <p>
            Design the CEU and CHC certificates staff issue. Changes here apply to every
            certificate printed for the selected school year.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreateOpen(true)}
            disabled={schoolYearId === null || bothExist}
            title={bothExist ? 'Both certificate types already exist for this year' : undefined}
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
            onChange={(e) => setSchoolYearId(Number(e.target.value))}
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
            onChange={(e) => setCertType(e.target.value as CertificateType)}
          >
            <option value="CEU">CEU — Units of Renewal Credit</option>
            <option value="CHC">CHC — Child Care Hours</option>
          </select>
        </div>

        <span className="toolbar-count">
          {existingTypes.length === 0
            ? 'No template for this year yet'
            : `${existingTypes.length} template${existingTypes.length === 1 ? '' : 's'} for this year`}
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
          />
        </>
      )}

      {createOpen && schoolYearId !== null && (
        <CreateCertificateDialog
          schoolYearId={schoolYearId}
          existingTypes={existingTypes}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setNotice('Certificate template created.');
            qc.invalidateQueries({ queryKey: ['certificates', 'templates', schoolYearId] });
          }}
        />
      )}
    </AppShell>
  );
}
