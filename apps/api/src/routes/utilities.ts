import { Router } from 'express';
import { z } from 'zod';
import type { UtilityDefinition } from '@pe/shared';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  UtilityError,
  duplicateGroups,
  listParticipants,
  negativePayments,
  orphanRegistrations,
  overview,
  previewMerge,
  recordRun,
  runMerge,
  runs,
  schoolYears,
} from '../services/utilities.js';

/**
 * Utilities — the maintenance tools that replace the Access macros and action
 * queries.
 *
 * Two shapes live here. `review` utilities are read-only lists of rows that
 * need a human decision (negative payments, registrations with no workshop).
 * `action` utilities change data, so they are preview-then-run: the preview
 * returns the exact counts and a token, and the run refuses unless the token
 * still matches. Nothing runs on a bare click.
 *
 * See docs/features/utilities.md for the rules these implement.
 */
export const utilitiesRouter = Router();

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

/**
 * The catalogue. Declared here rather than stored, for the same reason the
 * notification kinds are: a utility only exists because code implements it,
 * so a table would be a second place to forget to update.
 */
const UTILITIES: UtilityDefinition[] = [
  {
    key: 'duplicate-participants',
    title: 'Duplicate participants',
    description:
      'Participants who share an email address. Review each group, then merge the ones that are the same person.',
    mode: 'review',
    risk: 'HIGH',
    replaces: 'The duplicate-email problem found during the Access migration',
  },
  {
    key: 'negative-payments',
    title: 'Negative payments',
    description:
      'Registrations whose paid amount is below zero. The sign convention was never documented, so these need a decision rather than a fix.',
    mode: 'review',
    risk: 'MEDIUM',
    replaces: 'Unknown — Access stored these without a rule',
  },
  {
    key: 'registrations-no-workshop',
    title: 'Registrations with no workshop',
    description:
      'Registrations whose workshop is missing. They cannot appear on a roster or a report until they are resolved.',
    mode: 'review',
    risk: 'MEDIUM',
    replaces: 'The orphan rows quarantined during the Access migration',
  },
  {
    key: 'merge-participants',
    title: 'Merge two participants',
    description:
      'Reassign registrations, attendance, credit slips and certificates from one participant to another, then remove the duplicate.',
    mode: 'action',
    risk: 'HIGH',
    replaces: 'mcrRemoveDupParticipants, updRemoveDup1/2/3, delRemoveDup',
  },
];

function fail(res: import('express').Response, err: unknown): boolean {
  if (err instanceof UtilityError) {
    res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Catalogue and overview                                             */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/admin/utilities:
 *   get:
 *     tags: [Utilities]
 *     summary: Utility catalogue
 *     description: >
 *       Every maintenance tool, its risk, and the counts the cards show.
 *       Administrators only.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Catalogue plus overview counts }
 */
utilitiesRouter.get('/', requireAuth, requireRole(...ADMIN_ROLES), async (_req, res, next) => {
  try {
    const counts = await overview();
    res.json({ data: UTILITIES, overview: counts });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Participant picker                                                 */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/admin/utilities/participants:
 *   get:
 *     tags: [Utilities]
 *     summary: Participants for the merge picker
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: q, schema: { type: string }, description: Name or email }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 20, maximum: 50 } }
 *     responses:
 *       200: { description: Participants with their linked-record counts }
 */
utilitiesRouter.get('/participants', requireAuth, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const parsed = z
      .object({
        q: z.string().trim().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
      })
      .safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'Invalid query parameters' });
      return;
    }

    res.json(await listParticipants(parsed.data));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Review lists                                                       */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/admin/utilities/duplicate-participants:
 *   get:
 *     tags: [Utilities]
 *     summary: Participants grouped by shared email
 *     description: >
 *       Scoped to one school year by default — participants who registered
 *       for a workshop in that year. Omit `schoolYearId` for every year.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: schoolYearId, schema: { type: integer }, description: Only participants registered in this year; omit for all years }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 20, maximum: 50 } }
 *     responses:
 *       200: { description: One page of duplicate groups }
 */
utilitiesRouter.get(
  '/duplicate-participants',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const parsed = z
        .object({
          schoolYearId: z.coerce.number().int().positive().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(50).default(20),
        })
        .safeParse(req.query);

      if (!parsed.success) {
        res.status(422).json({ error: 'validation_failed', message: 'Invalid query parameters' });
        return;
      }

      res.json(await duplicateGroups(parsed.data));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/admin/utilities/school-years:
 *   get:
 *     tags: [Utilities]
 *     summary: School years for the Participants-by-year dropdown
 *     description: >
 *       Newest first, each with the number of duplicate groups that have a
 *       participant registered in it.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: School years with duplicate-group counts }
 */
utilitiesRouter.get('/school-years', requireAuth, requireRole(...ADMIN_ROLES), async (_req, res, next) => {
  try {
    res.json({ data: await schoolYears() });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/admin/utilities/negative-payments:
 *   get:
 *     tags: [Utilities]
 *     summary: Registrations with a negative paid amount
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Rows plus a summary split by cancellation state }
 */
utilitiesRouter.get('/negative-payments', requireAuth, requireRole(...ADMIN_ROLES), async (_req, res, next) => {
  try {
    res.json(await negativePayments());
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/admin/utilities/registrations-no-workshop:
 *   get:
 *     tags: [Utilities]
 *     summary: Registrations with no workshop
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Rows plus a summary }
 */
utilitiesRouter.get(
  '/registrations-no-workshop',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res, next) => {
    try {
      res.json(await orphanRegistrations());
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------ */
/*  Merge                                                              */
/* ------------------------------------------------------------------ */

const mergeBody = z.object({
  sourceParticipantId: z.coerce.number().int().positive(),
  targetParticipantId: z.coerce.number().int().positive(),
});

/**
 * @openapi
 * /api/admin/utilities/merge-participants/preview:
 *   post:
 *     tags: [Utilities]
 *     summary: Preview a participant merge
 *     description: >
 *       Returns what would move, whether the source would be deleted, any
 *       blocker (both registered for the same workshop), and a token that the
 *       run must echo back.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Preview and confirmation token }
 *       404: { description: A participant was not found }
 *       422: { description: Validation failed }
 */
utilitiesRouter.post(
  '/merge-participants/preview',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const parsed = mergeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Choose a source and a target participant',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const { sourceParticipantId, targetParticipantId } = parsed.data;
      res.json(await previewMerge(sourceParticipantId, targetParticipantId));
    } catch (err) {
      if (!fail(res, err)) next(err);
    }
  },
);

const runBody = mergeBody.extend({ token: z.string().min(10) });

/**
 * @openapi
 * /api/admin/utilities/merge-participants/run:
 *   post:
 *     tags: [Utilities]
 *     summary: Merge two participants
 *     description: >
 *       Requires the token from the preview. Refuses with 409 when the data
 *       changed since the preview, or when both participants are registered
 *       for the same workshop.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Merge result }
 *       409: { description: Stale preview or a shared workshop }
 */
utilitiesRouter.post(
  '/merge-participants/run',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    const parsed = runBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'A confirmation token is required',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { sourceParticipantId, targetParticipantId, token } = parsed.data;
    const runBy = req.user!.email;

    try {
      const result = await runMerge(sourceParticipantId, targetParticipantId, token, runBy);
      await recordRun({
        key: 'merge-participants',
        parameters: { sourceParticipantId, targetParticipantId, ...result.moves },
        affectedRows: result.affectedRows,
        runBy,
        succeeded: true,
        error: null,
      });
      res.json(result);
    } catch (err) {
      // A refusal is recorded too: "we tried and it was blocked" is the
      // question asked later, and the audit row is the only answer.
      const message = err instanceof Error ? err.message : 'Merge failed';
      await recordRun({
        key: 'merge-participants',
        parameters: { sourceParticipantId, targetParticipantId },
        affectedRows: 0,
        runBy,
        succeeded: false,
        error: message.slice(0, 1000),
      });

      if (!fail(res, err)) next(err);
    }
  },
);

/* ------------------------------------------------------------------ */
/*  Audit history                                                      */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/admin/utilities/runs:
 *   get:
 *     tags: [Utilities]
 *     summary: Utility run history
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: key, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, default: 50, maximum: 200 } }
 *     responses:
 *       200: { description: Runs, newest first }
 */
utilitiesRouter.get('/runs', requireAuth, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const parsed = z
      .object({
        key: z.string().trim().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'Invalid query parameters' });
      return;
    }

    res.json({ data: await runs(parsed.data.key, parsed.data.limit) });
  } catch (err) {
    next(err);
  }
});
