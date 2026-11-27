import { Router } from 'express';
import type express from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { query, sql } from '../db.js';
import type { FormTemplateKind } from '../services/forms.js';
import {
  decodeHeaderImage,
  loadHeaderImage,
  storeHeaderImage,
} from '../services/form-header.js';
import {
  answersForParticipant,
  answersForRegistration,
  answersForWorkshop,
  archiveTemplate,
  createTemplate,
  getVersion,
  listTemplates,
  listVersions,
  publishVersion,
  restoreTemplate,
  saveDraft,
  updateTemplate,
} from '../services/forms.js';

export const formsRouter = Router();

/** Editing drafts is open to managers; publishing is not. */
const EDIT_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] as const;
const PUBLISH_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

const questionSchema = z.object({
  sortOrder: z.number().int().min(0),
  questionKey: z
    .string()
    .min(1)
    .max(50)
    // Built-in keys are camelCase (firstName); custom keys are snake_case.
    // Both are allowed, but no spaces or punctuation.
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Use letters, digits and underscores'),
  label: z.string().min(1, 'A label is required').max(200),
  helpText: z.string().max(300).nullable().optional(),
  placeholder: z.string().max(100).nullable().optional(),
  fieldType: z.enum(['text', 'longtext', 'number', 'select', 'radio', 'checkbox', 'agency', 'session']),
  isRequired: z.boolean(),
  options: z.array(z.string().min(1).max(100)).default([]),
  maxLength: z.number().int().positive().nullable().optional(),
  mapsToColumn: z.string().max(50).nullable().optional(),
  isBuiltIn: z.boolean().default(false),
  /** Question key whose answer gates this one. Null = always shown. */
  branchOnQuestionKey: z.string().max(50).nullable().optional(),
  branchOptionValue: z.string().max(100).nullable().optional(),
  /** Temporary page key from the editor; resolved to a FormPageID on save. */
  pageKey: z.string().max(50).nullable().optional(),
});

const pageSchema = z.object({
  key: z.string().min(1).max(50),
  title: z.string().min(1, 'A page title is required').max(100),
  subtitle: z.string().max(300).nullable().optional(),
});

/**
 * @openapi
 * /api/forms:
 *   get:
 *     tags: [Forms]
 *     summary: List form templates
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: includeArchived, schema: { type: boolean, default: false }, description: Include retired forms }
 *     responses:
 *       200: { description: Templates with their current version }
 */
formsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const includeArchived = req.query.includeArchived === 'true' || req.query.includeArchived === '1';
    res.json({ data: await listTemplates(includeArchived) });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms:
 *   post:
 *     tags: [Forms]
 *     summary: Create a form template
 *     description: Seeds an unpublished v1 containing only the questions the public form always asks.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Created }
 */
formsRouter.post('/', requireAuth, requireRole(...EDIT_ROLES), async (req, res, next) => {
  try {
    const parsed = z
      .object({
        name: z.string().min(1, 'A name is required').max(100),
        description: z.string().max(500).nullable().optional(),
        kind: z.enum(['registration', 'trainingRequest']).default('registration'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid template',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const created = await createTemplate({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      actor: req.user!.email,
      kind: parsed.data.kind,
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}:
 *   patch:
 *     tags: [Forms]
 *     summary: Rename, describe or activate/deactivate a template
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Updated }
 */
formsRouter.patch('/:id', requireAuth, requireRole(...EDIT_ROLES), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = z
      .object({
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).nullable().optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'Invalid template' });
      return;
    }

    await updateTemplate(id, parsed.data, req.user!.email);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/archive:
 *   post:
 *     tags: [Forms]
 *     summary: Archive a form (retire it without deleting anything)
 *     description: >
 *       The form, its versions and its answers all stay. It is hidden from the
 *       default list and from the registration-link picker, and can be
 *       restored. Refused while a registration link still uses it.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Archived }
 *       409: { description: In use by a registration link }
 */
formsRouter.post('/:id/archive', requireAuth, requireRole(...PUBLISH_ROLES), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await archiveTemplate(id, req.user!.email);
    if (!result.ok) {
      res.status(409).json({ error: 'conflict', message: result.reason });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/restore:
 *   post:
 *     tags: [Forms]
 *     summary: Restore an archived form
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Restored }
 */
formsRouter.post('/:id/restore', requireAuth, requireRole(...PUBLISH_ROLES), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }
    await restoreTemplate(id, req.user!.email);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/versions:
 *   get:
 *     tags: [Forms]
 *     summary: Versions of a template, newest first
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Versions }
 */
formsRouter.get('/:id/versions', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }
    res.json({ data: await listVersions(id) });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/versions:
 *   post:
 *     tags: [Forms]
 *     summary: Save a new draft version from a question list
 *     description: >
 *       Always creates a new version rather than editing the current one,
 *       because a published version may already have answers pointing at its
 *       question ids.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Draft created }
 *       422: { description: Validation failed }
 */
formsRouter.post('/:id/versions', requireAuth, requireRole(...EDIT_ROLES), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = z
      .object({
        questions: z.array(questionSchema).min(1),
        pages: z.array(pageSchema).max(20).default([]),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid questions',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    // Publish-time rules, enforced here so a draft cannot be saved in a state
    // that could never be published.
    const problems: string[] = [];
    const keys = new Set<string>();

    for (const q of parsed.data.questions) {
      if (keys.has(q.questionKey)) {
        problems.push(`Duplicate question key "${q.questionKey}".`);
      }
      keys.add(q.questionKey);

      // A choice field needs options — unless it maps to a real column, in
      // which case its choices come from a database picker (agency) rather
      // than a static list.
      if (q.fieldType === 'select' || q.fieldType === 'radio' || q.fieldType === 'checkbox') {
        if (q.options.length === 0 && !q.mapsToColumn) {
          problems.push(`"${q.label}" is a ${q.fieldType} and needs at least one option.`);
        }
      } else if (q.fieldType === 'agency') {
        // The school picker is its own source; a static option list would be
        // ignored, so refuse one rather than silently dropping it.
        if (q.options.length > 0) {
          problems.push(`"${q.label}" is a School or Agency field and cannot have its own options.`);
        }
      } else if (q.fieldType === 'session') {
        // Session choices come from the workshop the link points at, so a
        // static list would be meaningless.
        if (q.options.length > 0) {
          problems.push(`"${q.label}" is a Session field and cannot have its own options.`);
        }
      } else if (q.placeholder && q.placeholder.length > 100) {
        problems.push(`"${q.label}" has a placeholder longer than 100 characters.`);
      }

      // A branch needs both halves, and must point at a question that exists
      // in this version and can actually produce the value being matched.
      if (q.branchOnQuestionKey || q.branchOptionValue) {
        if (!q.branchOnQuestionKey || !q.branchOptionValue) {
          problems.push(`"${q.label}" needs both a branching question and an option.`);
        } else {
          const parent = parsed.data.questions.find(
            (x) => x.questionKey === q.branchOnQuestionKey,
          );
          if (!parent) {
            problems.push(`"${q.label}" branches on "${q.branchOnQuestionKey}", which is not in this form.`);
          } else if (parent.questionKey === q.questionKey) {
            problems.push(`"${q.label}" cannot branch on itself.`);
          } else if (!parent.options.includes(q.branchOptionValue)) {
            problems.push(
              `"${q.label}" branches on "${q.branchOptionValue}", which is not an option of "${parent.label}".`,
            );
          }
        }
      }
    }

    // Pages: keys must be unique, and every question must name a page that
    // exists. A version with no pages is the page-less form, so a stray
    // pageKey there is a mistake rather than something to silently drop.
    const pageKeys = new Set<string>();
    for (const p of parsed.data.pages) {
      if (pageKeys.has(p.key)) problems.push(`Duplicate page "${p.title}".`);
      pageKeys.add(p.key);
    }
    for (const q of parsed.data.questions) {
      if (q.pageKey && !pageKeys.has(q.pageKey)) {
        problems.push(`"${q.label}" is on a page that is not in this form.`);
      }
    }
    if (parsed.data.pages.length > 0) {
      const empty = parsed.data.pages.filter(
        (p) => !parsed.data.questions.some((q) => q.pageKey === p.key),
      );
      if (empty.length === parsed.data.pages.length) {
        problems.push('Every page is empty. Remove the pages or add a question to one.');
      }
    }

    if (problems.length > 0) {
      res.status(422).json({ error: 'validation_failed', message: problems.join(' '), details: problems });
      return;
    }

    const versionId = await saveDraft({
      formTemplateId: id,
      questions: parsed.data.questions,
      pages: parsed.data.pages,
      actor: req.user!.email,
    });

    res.status(201).json({ formTemplateVersionId: versionId });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/versions/{versionId}:
 *   get:
 *     tags: [Forms]
 *     summary: One version with its questions
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Version }
 *       404: { description: Not found }
 */
formsRouter.get('/:id/versions/:versionId', requireAuth, async (req, res, next) => {
  try {
    const versionId = Number(req.params.versionId);
    if (!Number.isInteger(versionId)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const version = await getVersion(versionId);
    if (!version) {
      res.status(404).json({ error: 'not_found', message: 'Version not found' });
      return;
    }
    res.json(version);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/versions/{versionId}/publish:
 *   post:
 *     tags: [Forms]
 *     summary: Publish a draft version
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Published }
 */
formsRouter.post(
  '/:id/versions/:versionId/publish',
  requireAuth,
  requireRole(...PUBLISH_ROLES),
  async (req, res, next) => {
    try {
      const versionId = Number(req.params.versionId);
      if (!Number.isInteger(versionId)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const version = await getVersion(versionId);
      if (!version) {
        res.status(404).json({ error: 'not_found', message: 'Version not found' });
        return;
      }
      if (version.publishedAt) {
        res.status(409).json({ error: 'conflict', message: 'This version is already published.' });
        return;
      }

      await publishVersion(versionId, req.user!.email);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/forms/answers/registration/{registrationId}:
 *   get:
 *     tags: [Forms]
 *     summary: Custom answers for one registration
 *     description: >
 *       Name/value pairs for the questions this registrant answered, in the
 *       order they appeared on the form. Agency answers are resolved to the
 *       school name.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Answers }
 */
formsRouter.get('/answers/registration/:registrationId', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.registrationId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }
    res.json(await answersForRegistration(id));
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/answers/workshop/{workshopId}:
 *   get:
 *     tags: [Forms]
 *     summary: Custom answers for a workshop's registrants
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Answers grouped by registration }
 */
formsRouter.get('/answers/workshop/:workshopId', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.workshopId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }
    res.json({ data: await answersForWorkshop(id) });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/answers/participant/{participantId}:
 *   get:
 *     tags: [Forms]
 *     summary: Custom answers for one participant, grouped by workshop
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Answers grouped by registration }
 */
formsRouter.get('/answers/participant/:participantId', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.participantId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }
    res.json({ data: await answersForParticipant(id) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Header image                                                       */
/* ------------------------------------------------------------------ */

/** Header image state for the editor: whether there is one, and its alt text. */
async function headerState(formTemplateId: number) {
  const r = await query<{ HeaderAssetID: number | null; HeaderAltText: string | null }>(
    `SELECT HeaderAssetID, HeaderAltText FROM core.FormTemplate WHERE FormTemplateID = @id`,
    { id: { type: sql.Int, value: formTemplateId } },
  );
  const row = r.recordset[0];
  if (!row) return null;
  return {
    hasHeaderImage: row.HeaderAssetID !== null,
    headerAltText: row.HeaderAltText,
    /** Authenticated bytes for the editor and the preview. */
    headerImageUrl: row.HeaderAssetID === null ? null : `/api/forms/${formTemplateId}/header/image`,
  };
}

/**
 * @openapi
 * /api/forms/{id}/header:
 *   get:
 *     tags: [Forms]
 *     summary: Header image state for a form template
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Whether the form has a header image and its alt text }
 */
formsRouter.get('/:id/header', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid form id' });
      return;
    }
    const state = await headerState(id);
    if (!state) {
      res.status(404).json({ error: 'not_found', message: 'Form not found' });
      return;
    }
    res.json(state);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/header:
 *   post:
 *     tags: [Forms]
 *     summary: Upload or replace a form's header image
 *     description: >
 *       PNG, JPEG or WebP only — SVG is refused because the same bytes are
 *       served from our origin on the public page. 2 MB ceiling.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Stored }
 *       422: { description: Unsupported type, too large, or missing alt text }
 */
formsRouter.post('/:id/header', requireAuth, requireRole(...EDIT_ROLES), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid form id' });
      return;
    }

    const parsed = z
      .object({
        data: z.string().min(1),
        contentType: z.string().min(1),
        fileName: z.string().max(260).optional(),
        altText: z.string().trim().min(1, 'Alt text is required').max(200),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: parsed.error.issues[0]?.message ?? 'Image data is required',
      });
      return;
    }

    const decoded = decodeHeaderImage(parsed.data);
    if ('error' in decoded) {
      res.status(422).json({ error: 'validation_failed', message: decoded.error });
      return;
    }

    const assetId = await storeHeaderImage(decoded, req.user?.email ?? null);

    const updated = await query(
      `UPDATE core.FormTemplate
          SET HeaderAssetID = @asset, HeaderAltText = @alt,
              UpdatedBy = @by, UpdatedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.FormTemplateID
        WHERE FormTemplateID = @id`,
      {
        asset: { type: sql.Int, value: assetId },
        alt: { type: sql.NVarChar(200), value: parsed.data.altText },
        by: { type: sql.NVarChar(200), value: req.user?.email ?? null },
        id: { type: sql.Int, value: id },
      },
    );

    if (updated.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Form not found' });
      return;
    }

    res.json(await headerState(id));
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/header:
 *   delete:
 *     tags: [Forms]
 *     summary: Remove a form's header image
 *     description: >
 *       Falls back to the standard lockup. The asset row is left in place —
 *       another form may be using the same bytes.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Removed }
 */
formsRouter.delete('/:id/header', requireAuth, requireRole(...EDIT_ROLES), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid form id' });
      return;
    }

    const updated = await query(
      `UPDATE core.FormTemplate
          SET HeaderAssetID = NULL, HeaderAltText = NULL,
              UpdatedBy = @by, UpdatedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.FormTemplateID
        WHERE FormTemplateID = @id`,
      {
        by: { type: sql.NVarChar(200), value: req.user?.email ?? null },
        id: { type: sql.Int, value: id },
      },
    );

    if (updated.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'Form not found' });
      return;
    }

    res.json(await headerState(id));
  } catch (err) {
    next(err);
  }
});

/** The image bytes, for the editor and the preview. Any signed-in staff role. */
formsRouter.get('/:id/header/image', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).end();
      return;
    }
    const image = await loadHeaderImage(id);
    if (!image) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(image.content);
  } catch (err) {
    next(err);
  }
});

/**
 * Lets a token arrive as `?token=`, but only on the preview route.
 *
 * The preview opens in its own tab, and a top-level navigation cannot set an
 * Authorization header. The token is the same one the app already holds; it
 * is promoted to the header form so `requireAuth` stays the single place that
 * validates it. Scoped to this one read-only route — never to the whole
 * router, which also handles writes.
 */
function allowPreviewToken(req: express.Request, _res: express.Response, next: express.NextFunction) {
  if (!req.headers.authorization && typeof req.query.token === 'string' && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}

/**
 * @openapi
 * /api/forms/{id}/preview:
 *   get:
 *     tags: [Forms]
 *     summary: The public page's payload for a form version, for staff preview
 *     description: >
 *       Same shape the public link endpoint returns, but for any version —
 *       draft included — with the link state forced to open. Never writes.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: query, name: version, schema: { type: integer }, description: Omit for the newest version }
 *       - { in: query, name: token, schema: { type: string }, description: Accepted in place of the bearer header — see the note on the route }
 *     responses:
 *       200: { description: Preview payload }
 *       404: { description: Form or version not found }
 */
formsRouter.get(
  '/:id/preview',
  allowPreviewToken,
  requireAuth,
  requireRole(...EDIT_ROLES),
  async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid form id' });
      return;
    }

    const template = await query<{ FormTemplateID: number; Name: string; Kind: FormTemplateKind }>(
      `SELECT FormTemplateID, Name, Kind FROM core.FormTemplate WHERE FormTemplateID = @id`,
      { id: { type: sql.Int, value: id } },
    );
    const tpl = template.recordset[0];
    if (!tpl) {
      res.status(404).json({ error: 'not_found', message: 'Form not found' });
      return;
    }

    let versionId: number | null = null;
    if (req.query.version !== undefined) {
      const requested = Number(req.query.version);
      if (!Number.isInteger(requested)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid version id' });
        return;
      }
      const owned = await query<{ FormTemplateVersionID: number }>(
        `SELECT FormTemplateVersionID FROM core.FormTemplateVersion
          WHERE FormTemplateVersionID = @v AND FormTemplateID = @id`,
        {
          v: { type: sql.Int, value: requested },
          id: { type: sql.Int, value: id },
        },
      );
      // A version from another template is a 404, never a fallback: a crafted
      // id must not preview somebody else's draft.
      if (owned.recordset.length === 0) {
        res.status(404).json({ error: 'not_found', message: 'Version not found' });
        return;
      }
      versionId = requested;
    } else {
      const newest = await query<{ FormTemplateVersionID: number }>(
        `SELECT TOP 1 FormTemplateVersionID FROM core.FormTemplateVersion
          WHERE FormTemplateID = @id ORDER BY VersionNumber DESC`,
        { id: { type: sql.Int, value: id } },
      );
      versionId = newest.recordset[0]?.FormTemplateVersionID ?? null;
    }

    const version = versionId === null ? null : await getVersion(versionId);
    const header = await headerState(id);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      state: 'open',
      kind: tpl.Kind,
      seatsRemaining: null,
      form: version,
      sessions: [],
      opensAt: null,
      redirectToPayment: false,
      paymentUrl: null,
      headerImageUrl: header?.hasHeaderImage ? header.headerImageUrl : null,
      headerAltText: header?.headerAltText ?? null,
      preview: {
        formName: tpl.Name,
        versionNumber: version?.versionNumber ?? null,
        isPublished: version?.publishedAt !== null && version?.publishedAt !== undefined,
      },
      workshop: {
        title: null,
        code: null,
        startDate: null,
        endDate: null,
        startTime: null,
        endTime: null,
        room: null,
        location: null,
        cost: null,
        credit: null,
        ceus: null,
      },
    });
  } catch (err) {
    next(err);
  }
  },
);
