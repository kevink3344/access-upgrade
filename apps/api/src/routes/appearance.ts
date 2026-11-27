import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  LOGIN_THEMES,
  getLoginTheme,
  setLoginTheme,
} from '../services/login-theme.js';

/**
 * Appearance settings. Mounted at /api/admin/appearance.
 *
 * Admin-only: this changes what every visitor sees on the login screen.
 */
export const appearanceRouter = Router();

/**
 * @openapi
 * /api/admin/appearance:
 *   get:
 *     tags: [Administration]
 *     summary: Current appearance settings
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Theme and the available choices }
 *   patch:
 *     tags: [Administration]
 *     summary: Choose the login screen theme
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated }
 *       422: { description: Unknown theme }
 */
appearanceRouter.get(
  '/',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (_req, res, next) => {
    try {
      res.json({ loginTheme: await getLoginTheme(), themes: LOGIN_THEMES });
    } catch (err) {
      next(err);
    }
  },
);

const patchSchema = z.object({ loginTheme: z.enum(LOGIN_THEMES) });

appearanceRouter.patch(
  '/',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Choose one of the available themes.',
        });
        return;
      }

      await setLoginTheme(parsed.data.loginTheme, req.user!.email);
      res.json({ loginTheme: await getLoginTheme(), themes: LOGIN_THEMES });
    } catch (err) {
      next(err);
    }
  },
);
