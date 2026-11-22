import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { FormTemplateEditor } from '../components/FormTemplateEditor';

/**
 * Full-page form editor.
 *
 * Deliberately a page rather than a drawer: a form can have many questions and
 * the editor needs the full viewport height to scroll comfortably. The drawer
 * version could not scroll past the fold.
 */
export function FormEditorPage({ formTemplateId }: { formTemplateId: number }) {
  const { user } = useAuth();
  const canEdit = user && ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(user.role);
  const canPublish = user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role);

  function backToList() {
    window.history.pushState({}, '', '/admin/forms');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  return (
    <AppShell currentPath="/admin/forms" title="Form editor">
      <FormTemplateEditor
        formTemplateId={formTemplateId}
        canEdit={!!canEdit}
        canPublish={!!canPublish}
        onBack={backToList}
      />
    </AppShell>
  );
}
