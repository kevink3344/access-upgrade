import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth/middleware.js';
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
 *     description: Seeds an unpublished v1 containing the six built-in questions.
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

    const parsed = z.object({ questions: z.array(questionSchema).min(1) }).safeParse(req.body);

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

    if (problems.length > 0) {
      res.status(422).json({ error: 'validation_failed', message: problems.join(' '), details: problems });
      return;
    }

    const versionId = await saveDraft({
      formTemplateId: id,
      questions: parsed.data.questions,
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
