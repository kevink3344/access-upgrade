import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

/**
 * Staff-side management of public registration links.
 * Mounted at /api/workshops/:id/registration-link.
 *
 * The public-facing endpoints live in routes/public.ts — they are a
 * separate surface with no authentication and their own rate limits.
 */
export const registrationLinkRouter = Router({ mergeParams: true });

/** 16 URL-safe characters — unguessable and short enough to paste. */
function newSlug(): string {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

const updateSchema = z.object({
  isActive: z.boolean().optional(),
  webSeatCap: z.number().int().min(0).nullable().optional(),
  opensAt: z.string().datetime().nullable().optional(),
  closesAt: z.string().datetime().nullable().optional(),
  redirectToPayment: z.boolean().optional(),
  /** Which form version the public form asks. Null = the built-in form. */
  formTemplateVersionId: z.number().int().positive().nullable().optional(),
  /** Must be an absolute http(s) URL, or null to clear. */
  paymentUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), {
      message: 'Enter a full URL starting with http:// or https://',
    })
    .nullable()
    .optional(),
});

async function loadWorkshop(workshopId: number) {
  const r = await query<{
    WorkshopID: number;
    WorkshopCode: string | null;
    WorkshopName: string | null;
    MaxEnrollment: number | null;
    IsRegistrationOpen: boolean;
    IsCancelled: boolean;
    IsClosed: boolean;
  }>(
    `SELECT w.WorkshopID, w.WorkshopCode, n.WorkshopName, w.MaxEnrollment,
            w.IsRegistrationOpen, w.IsCancelled, w.IsClosed
       FROM core.Workshop w
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      WHERE w.WorkshopID = @id`,
    { id: { type: sql.Int, value: workshopId } },
  );
  return r.recordset[0] ?? null;
}

/** Current (non-revoked) link for a workshop, if any. */
async function currentLink(workshopId: number) {
  const r = await query<{
    RegistrationLinkID: number;
    Slug: string;
    IsActive: boolean;
    WebSeatCap: number | null;
    OpensAt: Date | null;
    ClosesAt: Date | null;
    RedirectToPayment: boolean;
    PaymentUrl: string | null;
    FormTemplateVersionID: number | null;
    CreatedBy: string;
    CreatedAt: Date;
  }>(
    `SELECT TOP 1 RegistrationLinkID, Slug, IsActive, WebSeatCap, OpensAt, ClosesAt,
                  RedirectToPayment, PaymentUrl, FormTemplateVersionID, CreatedBy, CreatedAt
       FROM core.WorkshopRegistrationLink
      WHERE WorkshopID = @id AND RevokedAt IS NULL
      ORDER BY RegistrationLinkID DESC`,
    { id: { type: sql.Int, value: workshopId } },
  );
  return r.recordset[0] ?? null;
}

async function webRegistrations(workshopId: number) {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM core.Registration
      WHERE WorkshopID = @id AND Source = 'Web' AND IsCancelled = 0`,
    { id: { type: sql.Int, value: workshopId } },
  );
  return r.recordset[0]?.n ?? 0;
}

/**
 * @openapi
 * /api/workshops/{id}/registration-link:
 *   get:
 *     tags: [Public registration]
 *     summary: Current registration link
 *     description: >
 *       Returns the workshop's master switch, its current link (if any),
 *       and how many web registrations have been taken. All toggles
 *       default to off — a workshop is never publicly registerable until
 *       staff deliberately open it.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: Link state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workshop:
 *                   type: object
 *                   properties:
 *                     workshopId: { type: integer }
 *                     workshopCode: { type: string, nullable: true }
 *                     workshopName: { type: string, nullable: true }
 *                     isRegistrationOpen: { type: boolean }
 *                     maxEnrollment: { type: integer, nullable: true }
 *                 link:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     slug: { type: string }
 *                     url: { type: string }
 *                     isActive: { type: boolean }
 *                     webSeatCap: { type: integer, nullable: true }
 *                     webRegistrations: { type: integer }
 *       404: { description: Workshop not found }
 */
registrationLinkRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const workshopId = Number(req.params.id);
    if (!Number.isInteger(workshopId)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid workshop id' });
      return;
    }

    const workshop = await loadWorkshop(workshopId);
    if (!workshop) {
      res.status(404).json({ error: 'not_found', message: 'Workshop not found' });
      return;
    }

    const link = await currentLink(workshopId);
    const web = await webRegistrations(workshopId);

    res.json({
      workshop: {
        workshopId: workshop.WorkshopID,
        workshopCode: workshop.WorkshopCode,
        workshopName: workshop.WorkshopName,
        isRegistrationOpen: workshop.IsRegistrationOpen,
        maxEnrollment: workshop.MaxEnrollment,
      },
      link: link
        ? {
            slug: link.Slug,
            url: `/register/${link.Slug}`,
            isActive: link.IsActive,
            webSeatCap: link.WebSeatCap,
            opensAt: link.OpensAt?.toISOString() ?? null,
            closesAt: link.ClosesAt?.toISOString() ?? null,
            redirectToPayment: link.RedirectToPayment,
            paymentUrl: link.PaymentUrl,
            formTemplateVersionId: link.FormTemplateVersionID,
            webRegistrations: web,
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
 * /api/workshops/{id}/registration-link:
 *   post:
 *     tags: [Public registration]
 *     summary: Create or rotate the registration link
 *     description: >
 *       Creates a link if none exists. If one does, pass `rotate: true` to
 *       revoke it and issue a new slug — existing registrations are
 *       unaffected. Links start inactive.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               rotate: { type: boolean, default: false }
 *               webSeatCap: { type: integer, nullable: true }
 *     responses:
 *       201: { description: Link created }
 *       409: { description: A link already exists (pass rotate) }
 */
registrationLinkRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const workshopId = Number(req.params.id);
    if (!Number.isInteger(workshopId)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid workshop id' });
      return;
    }

    const workshop = await loadWorkshop(workshopId);
    if (!workshop) {
      res.status(404).json({ error: 'not_found', message: 'Workshop not found' });
      return;
    }

    const rotate = req.body?.rotate === true;
    const existing = await currentLink(workshopId);

    if (existing && !rotate) {
      res.status(409).json({
        error: 'conflict',
        message: 'This workshop already has a registration link. Pass rotate: true to replace it.',
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

    const cap = typeof req.body?.webSeatCap === 'number' ? req.body.webSeatCap : null;

    const created = await query<{ RegistrationLinkID: number; Slug: string }>(
      `INSERT INTO core.WorkshopRegistrationLink
              (WorkshopID, Slug, IsActive, WebSeatCap, CreatedBy)
       OUTPUT INSERTED.RegistrationLinkID, INSERTED.Slug
       VALUES (@wid, @slug, 0, @cap, @by)`,
      {
        wid: { type: sql.Int, value: workshopId },
        slug: { type: sql.NVarChar(24), value: newSlug() },
        cap: { type: sql.Int, value: cap },
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
 * /api/workshops/{id}/registration-link:
 *   patch:
 *     tags: [Public registration]
 *     summary: Update the link or the workshop switch
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isActive: { type: boolean }
 *               webSeatCap: { type: integer, nullable: true }
 *               opensAt: { type: string, format: date-time, nullable: true }
 *               closesAt: { type: string, format: date-time, nullable: true }
 *     responses:
 *       200: { description: Updated }
 *       404: { description: No link exists }
 */
registrationLinkRouter.patch('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const workshopId = Number(req.params.id);
    if (!Number.isInteger(workshopId)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid workshop id' });
      return;
    }

    const parsed = updateSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid link settings',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const link = await currentLink(workshopId);
    if (!link) {
      res.status(404).json({ error: 'not_found', message: 'This workshop has no registration link yet' });
      return;
    }

    const sets: string[] = [];
    const params: Record<string, SqlParam> = {
      id: { type: sql.Int, value: link.RegistrationLinkID },
    };

    const d = parsed.data;
    if (d.isActive !== undefined) {
      sets.push('IsActive = @active');
      params.active = { type: sql.Bit, value: d.isActive ? 1 : 0 };
    }
    if (d.webSeatCap !== undefined) {
      sets.push('WebSeatCap = @cap');
      params.cap = { type: sql.Int, value: d.webSeatCap };
    }
    if (d.opensAt !== undefined) {
      sets.push('OpensAt = @opens');
      params.opens = { type: sql.DateTime2(0), value: d.opensAt };
    }
    if (d.closesAt !== undefined) {
      sets.push('ClosesAt = @closes');
      params.closes = { type: sql.DateTime2(0), value: d.closesAt };
    }
    if (d.redirectToPayment !== undefined) {
      sets.push('RedirectToPayment = @redirect');
      params.redirect = { type: sql.Bit, value: d.redirectToPayment ? 1 : 0 };
    }
    if (d.paymentUrl !== undefined) {
      const url = d.paymentUrl && d.paymentUrl.trim() !== '' ? d.paymentUrl.trim() : null;
      sets.push('PaymentUrl = @payUrl');
      params.payUrl = { type: sql.NVarChar(500), value: url };
    }
    if (d.formTemplateVersionId !== undefined) {
      // Only a published version may be pinned: a draft has never been shown
      // to anyone, so publishing it is the staff member's explicit act.
      if (d.formTemplateVersionId !== null) {
        const v = await query<{ PublishedAt: Date | null }>(
          `SELECT PublishedAt FROM core.FormTemplateVersion WHERE FormTemplateVersionID = @v`,
          { v: { type: sql.Int, value: d.formTemplateVersionId } },
        );
        const row = v.recordset[0];
        if (!row) {
          res.status(422).json({
            error: 'validation_failed',
            message: 'That form version does not exist.',
            details: [{ path: 'formTemplateVersionId', message: 'Unknown version' }],
          });
          return;
        }
        if (!row.PublishedAt) {
          res.status(422).json({
            error: 'validation_failed',
            message: 'Publish the form before using it on a registration link.',
            details: [{ path: 'formTemplateVersionId', message: 'Version is a draft' }],
          });
          return;
        }
      }
      sets.push('FormTemplateVersionID = @ftv');
      params.ftv = { type: sql.Int, value: d.formTemplateVersionId };
    }

    // A redirect with no destination would send the registrant nowhere, and
    // the database check constraint would reject it anyway. Catch it here so
    // the client gets a usable message instead of a 500.
    const nextRedirect = d.redirectToPayment ?? link.RedirectToPayment;
    const nextUrl =
      d.paymentUrl !== undefined
        ? (d.paymentUrl && d.paymentUrl.trim() !== '' ? d.paymentUrl.trim() : null)
        : link.PaymentUrl;

    if (nextRedirect && !nextUrl) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Add a payment link before turning on the redirect.',
        details: [{ path: 'paymentUrl', message: 'A payment link is required' }],
      });
      return;
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
