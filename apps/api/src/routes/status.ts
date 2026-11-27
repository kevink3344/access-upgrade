import { Router } from 'express';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { statusReport } from '../services/status.js';

/**
 * Developer > Status.
 *
 * Mounted at /api/admin/status. Admin-only: the checks name the database, the
 * browser path and the webhook URL, which is more than a viewer should see.
 */
export const statusRouter = Router();

/**
 * @openapi
 * /api/admin/status:
 *   get:
 *     tags: [Administration]
 *     summary: Health and configuration checks for the Developer status page
 *     description: >
 *       Runs each check live: database, core data, PDF rendering, outbound
 *       email, the report scheduler and the deployment label. Never returns a
 *       secret. `overall` is the worst of the individual results.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Status report }
 *       403: { description: Admin only }
 */
statusRouter.get('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await statusReport());
  } catch (err) {
    next(err);
  }
});
