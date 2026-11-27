import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { PublicRegisterPage } from './PublicRegisterPage';

/**
 * Staff preview of a form's public page.
 *
 * Renders the real `PublicRegisterPage` rather than a mock, so the preview
 * cannot drift from what a family actually sees — including a draft version
 * and its banner, neither of which a live link can show.
 *
 * The bar above the page is the only difference: it says this is not the
 * live form, and gives a way back to the editor.
 */
export function FormPreviewPage({
  formTemplateId,
  versionId,
}: {
  formTemplateId: number;
  versionId: number | null;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['form-preview', formTemplateId, versionId],
    queryFn: () => api.forms.preview(formTemplateId, versionId),
    retry: false,
  });
  const backHref = `/admin/forms/${formTemplateId}`;

  if (isLoading) {
    return (
      <div style={{ padding: 28 }}>
        <div className="skeleton" style={{ height: 320 }} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="preview-bar" role="status">
        <span>
          <strong>Preview</strong> — this form could not be previewed.
        </span>
        <a className="btn btn-ghost btn-sm" href={backHref}>
          Back to editor
        </a>
      </div>
    );
  }

  const v = data.preview;

  return (
    <>
      <div className="preview-bar" role="status">
        <span>
          <strong>Preview</strong>
          {v.versionNumber !== null && ` · v${v.versionNumber}`}
          {v.versionNumber !== null && (v.isPublished ? ' (published)' : ' (draft)')}
          {' · not the live form'}
        </span>
        <a className="btn btn-ghost btn-sm" href={backHref}>
          Back to editor
        </a>
      </div>
      <PublicRegisterPage preview={data} />
    </>
  );
}
