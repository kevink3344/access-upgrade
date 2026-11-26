import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

/**
 * Staff-side management of public links for a FORM TEMPLATE.
 * Mounted at /api/forms/:id/link.
 *
 * A workshop registration link is created from the workshop, because the
 * workshop is what the public page describes. A standalone form (a training
 * request, say) has no workshop, so its link hangs off the template instead.
 *
 * The public-facing endpoints live in routes/public.ts.
 */
export const formLinkRouter = Router({ mergeParams: true });

/** 16 URL-safe characters — unguessable and short enough to paste. */
function newSlug(): string {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

const updateSchema = z.object({
  isActive: z.boolean().optional(),
  /**
   * Move the link onto a published version. Omit to leave the pinned version
   * alone — publishing a new version must never silently change a link that
   * has already been shared.
   */
  formTemplateVersionId: z.number().int().positive().optional(),
});

/** The template, or null when it does not exist. */
async function loadTemplate(formTemplateId: number) {
  const r = await query<{
    FormTemplateID: number;
    Name: string;
    Kind: string;
    ArchivedAt: Date | null;
  }>(
    `SELECT FormTemplateID, Name, Kind, ArchivedAt
       FROM core.FormTemplate WHERE FormTemplateID = @id`,
    { id: { type: sql.Int, value: formTemplateId } },
  );
  return r.recordset[0] ?? null;
}

/** Current (non-revoked) standalone link for a template, if any. */
async function currentLink(formTemplateId: number) {
  const r = await query<{
    RegistrationLinkID: number;
    Slug: string;
    IsActive: boolean;
    FormTemplateVersionID: number | null;
    CreatedBy: string;
    CreatedAt: Date;
  }>(
    `SELECT TOP 1 RegistrationLinkID, Slug, IsActive, FormTemplateVersionID, CreatedBy, CreatedAt
       FROM core.WorkshopRegistrationLink
      WHERE FormTemplateID = @id AND RevokedAt IS NULL
      ORDER BY RegistrationLinkID DESC`,
    { id: { type: sql.Int, value: formTemplateId } },
  );
  return r.recordset[0] ?? null;
}

/** The newest published version of a template, or null when none is published. */
async function latestPublishedVersion(formTemplateId: number) {
  const r = await query<{ FormTemplateVersionID: number }>(
    `SELECT TOP 1 FormTemplateVersionID
       FROM core.FormTemplateVersion
      WHERE FormTemplateID = @id AND PublishedAt IS NOT NULL
      ORDER BY VersionNumber DESC`,
    { id: { type: sql.Int, value: formTemplateId } },
  );
  return r.recordset[0]?.FormTemplateVersionID ?? null;
}

/**
 * @openapi
 * /api/forms/{id}/link:
 *   get:
 *     tags: [Public registration]
 *     summary: Current standalone link for a form template
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Link state }
 *       404: { description: Form not found }
 */
formLinkRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid form id' });
      return;
    }

    const template = await loadTemplate(id);
    if (!template) {
      res.status(404).json({ error: 'not_found', message: 'Form not found' });
      return;
    }

    const link = await currentLink(id);
    const published = await latestPublishedVersion(id);

    res.json({
      formTemplateId: template.FormTemplateID,
      formName: template.Name,
      kind: template.Kind,
      isArchived: template.ArchivedAt !== null,
      hasPublishedVersion: published !== null,
      /** The newest published version, offered as the one to pin. */
      latestPublishedVersionId: published,
      link: link
        ? {
            slug: link.Slug,
            url: `/register/${link.Slug}`,
            isActive: link.IsActive,
            formTemplateVersionId: link.FormTemplateVersionID,
            /**
             * True when a newer version has been published since the link was
             * created. The link keeps asking its pinned version until staff
             * update it — publishing alone never changes a shared link.
             */
            isBehindLatest:
              published !== null && link.FormTemplateVersionID !== published,
            createdBy: link.CreatedBy,
            createdAt: link.CreatedAt.toISOString(),
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/link:
 *   post:
 *     tags: [Public registration]
 *     summary: Create a standalone public link for a form template
 *     description: >
 *       Pins the template's newest published version. A draft cannot be
 *       shared, because nobody could answer it.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       201: { description: Link created }
 *       409: { description: A link already exists (pass rotate) }
 *       422: { description: The form has no published version }
 */
formLinkRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid form id' });
      return;
    }

    const template = await loadTemplate(id);
    if (!template) {
      res.status(404).json({ error: 'not_found', message: 'Form not found' });
      return;
    }
    if (template.ArchivedAt !== null) {
      res.status(409).json({ error: 'conflict', message: 'This form is archived. Restore it first.' });
      return;
    }

    const versionId = await latestPublishedVersion(id);
    if (versionId === null) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Publish the form before creating a public link.',
        details: [{ path: 'formTemplateVersionId', message: 'No published version' }],
      });
      return;
    }

    const rotate = req.body?.rotate === true;
    const existing = await currentLink(id);

    if (existing && !rotate) {
      res.status(409).json({
        error: 'conflict',
        message: 'This form already has a public link. Pass rotate: true to replace it.',
      });
      return;
    }

    if (existing && rotate) {
      await query(
        `UPDATE core.WorkshopRegistrationLink
            SET IsActive = 0, RevokedAt = SYSUTCDATETIME(), RevokedBy = @by
          WHERE RegistrationLinkID = @id`,
        {
          id: { type: sql.Int, value: existing.RegistrationLinkID },
          by: { type: sql.NVarChar(100), value: req.user?.email ?? 'unknown' },
        },
      );
    }

    const created = await query<{ RegistrationLinkID: number; Slug: string }>(
      `INSERT INTO core.WorkshopRegistrationLink
              (FormTemplateID, FormTemplateVersionID, Slug, IsActive, CreatedBy)
       OUTPUT INSERTED.RegistrationLinkID, INSERTED.Slug
       VALUES (@tpl, @ver, @slug, 0, @by)`,
      {
        tpl: { type: sql.Int, value: id },
        ver: { type: sql.Int, value: versionId },
        slug: { type: sql.NVarChar(24), value: newSlug() },
        by: { type: sql.NVarChar(100), value: req.user?.email ?? 'unknown' },
      },
    );

    const row = created.recordset[0]!;
    res.status(201).json({
      registrationLinkId: row.RegistrationLinkID,
      slug: row.Slug,
      url: `/register/${row.Slug}`,
      isActive: false,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/forms/{id}/link:
 *   patch:
 *     tags: [Public registration]
 *     summary: Open or close a form's public link
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Updated }
 *       404: { description: No current link }
 */
formLinkRouter.patch('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid form id' });
      return;
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid update',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const link = await currentLink(id);
    if (!link) {
      res.status(404).json({ error: 'not_found', message: 'This form has no public link' });
      return;
    }

    const sets: string[] = [];
    const params: Record<string, SqlParam> = {
      id: { type: sql.Int, value: link.RegistrationLinkID },
    };

    if (parsed.data.isActive !== undefined) {
      sets.push('IsActive = @active');
      params.active = { type: sql.Bit, value: parsed.data.isActive ? 1 : 0 };
    }

    if (parsed.data.formTemplateVersionId !== undefined) {
      // Only a version of THIS template, and only a published one: a draft has
      // never been shown to anyone, so pinning it would publish by accident.
      const v = await query<{ PublishedAt: Date | null }>(
        `SELECT PublishedAt
           FROM core.FormTemplateVersion
          WHERE FormTemplateVersionID = @v AND FormTemplateID = @tpl`,
        {
          v: { type: sql.Int, value: parsed.data.formTemplateVersionId },
          tpl: { type: sql.Int, value: id },
        },
      );
      const row = v.recordset[0];
      if (!row || !row.PublishedAt) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Pick a published version of this form.',
          details: [{ path: 'formTemplateVersionId', message: 'Not a published version of this form' }],
        });
        return;
      }
      sets.push('FormTemplateVersionID = @ftv');
      params.ftv = { type: sql.Int, value: parsed.data.formTemplateVersionId };
    }

    if (sets.length === 0) {
      res.status(422).json({ error: 'validation_failed', message: 'No fields to update' });
      return;
    }

    await query(
      `UPDATE core.WorkshopRegistrationLink SET ${sets.join(', ')} WHERE RegistrationLinkID = @id`,
      params,
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
