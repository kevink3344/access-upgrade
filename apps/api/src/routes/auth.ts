import { Router } from 'express';
import { z } from 'zod';
import {
  findUserByEmail,
  verifyPassword,
  signAccessToken,
  toAuthUser,
  createRefreshToken,
  storeRefreshToken,
  recordLoginAttempt,
  recentFailedAttempts,
  touchLastLogin,
} from '../auth/service.js';
import { requireAuth } from '../auth/middleware.js';
import { env } from '../env.js';
import type { LoginResponse } from '@pe/shared';

export const authRouter = Router();

const MAX_FAILED_ATTEMPTS = 10;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in and receive a JWT
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:    { type: string, format: email }
 *               password: { type: string, format: password }
 *               rememberMe:
 *                 type: boolean
 *                 default: false
 *                 description: >
 *                   Keep the session alive across browser restarts. Issues a
 *                   long-lived access token and a persistent refresh cookie
 *                   instead of a session cookie.
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:     { type: string }
 *                 expiresAt: { type: string, format: date-time }
 *                 user:      { $ref: '#/components/schemas/AuthUser' }
 *       401: { description: Invalid credentials }
 *       423: { description: Too many failed attempts }
 *       429: { description: Rate limited }
 */
authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Email and password are required',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const email = parsed.data.email.trim().toLowerCase();
    const ip = req.ip ?? null;

    // Lockout after repeated failures — protects against credential stuffing
    // without revealing whether the account exists.
    const failures = await recentFailedAttempts(email);
    if (failures >= MAX_FAILED_ATTEMPTS) {
      await recordLoginAttempt(email, false, 'locked_out', ip);
      res.status(423).json({
        error: 'account_locked',
        message: 'Too many failed attempts. Try again in 15 minutes.',
      });
      return;
    }

    const user = await findUserByEmail(email);

    // Constant-ish response regardless of which check failed.
    const invalid = () =>
      res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect' });

    if (!user) {
      await recordLoginAttempt(email, false, 'no_such_user', ip);
      invalid();
      return;
    }

    if (!user.IsActive) {
      await recordLoginAttempt(email, false, 'inactive', ip);
      res.status(403).json({ error: 'account_inactive', message: 'This account has been deactivated' });
      return;
    }

    const ok = await verifyPassword(parsed.data.password, user.PasswordHash);

    if (!ok) {
      await recordLoginAttempt(email, false, 'bad_password', ip);
      invalid();
      return;
    }

    const authUser = toAuthUser(user);
    const rememberMe = parsed.data.rememberMe === true;

    // "Remember me" trades a long-lived access token for convenience. Without
    // it the access token keeps its short default life and the refresh cookie
    // is a session cookie, so closing the browser ends the session.
    const { token, expiresAt } = signAccessToken(authUser, rememberMe);

    // Refresh token in an httpOnly cookie — the access token stays in memory.
    const refresh = createRefreshToken();
    const refreshDays = rememberMe ? env.REFRESH_TOKEN_DAYS : 1;
    await storeRefreshToken(user.UserID, refresh.hash, req.get('user-agent') ?? null, ip, refreshDays);

    res.cookie('pe_refresh', refresh.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      // Omitting maxAge makes this a session cookie: it dies with the browser.
      ...(rememberMe ? { maxAge: refreshDays * 24 * 60 * 60 * 1000 } : {}),
    });

    await touchLastLogin(user.UserID);
    await recordLoginAttempt(email, true, null, ip);

    const body: LoginResponse = { token, expiresAt, user: authUser, rememberMe };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: The authenticated user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthUser' }
 *       401: { description: Not authenticated }
 */
authRouter.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

/**
 * @openapi
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Clear the refresh cookie
 *     responses:
 *       204: { description: Signed out }
 */
authRouter.post('/logout', (_req, res) => {
  res.clearCookie('pe_refresh', { path: '/api/auth' });
  res.status(204).end();
});
