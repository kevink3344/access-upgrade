import { Router } from 'express';
import { z } from 'zod';
import {
  findUserByEmail,
  findUserById,
  verifyPassword,
  signAccessToken,
  toAuthUser,
  createRefreshToken,
  storeRefreshToken,
  recordLoginAttempt,
  recentFailedAttempts,
  touchLastLogin,
  hashToken,
  findRefreshToken,
  rotateRefreshToken,
  revokeRefreshFamily,
  revokeRefreshToken,
} from '../auth/service.js';
import { requireAuth } from '../auth/middleware.js';
import { env, isProd } from '../env.js';
import type { LoginResponse } from '@pe/shared';

export const authRouter = Router();

const MAX_FAILED_ATTEMPTS = 10;

/** The refresh cookie. Scoped to /api/auth so it is never sent to other routes. */
const REFRESH_COOKIE = 'pe_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';

function refreshCookieOptions(maxAgeMs?: number) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict' as const,
    path: REFRESH_COOKIE_PATH,
    // Omitting maxAge makes this a session cookie: it dies with the browser.
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

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

    res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(
      rememberMe ? refreshDays * 24 * 60 * 60 * 1000 : undefined,
    ));

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
 * /api/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Exchange the refresh cookie for a new access token
 *     description: >
 *       Rotates the refresh token: the presented token is revoked and a new
 *       one is set on the response. Presenting a token that was already
 *       rotated is treated as theft and revokes every live token for the
 *       user, so a stolen cookie cannot outlive the session it was taken from.
 *     security: []
 *     responses:
 *       200:
 *         description: A new access token and rotated refresh cookie
 *       401: { description: No cookie, expired token, or reused token }
 */
authRouter.post('/refresh', async (req, res, next) => {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;

    if (!presented) {
      res.status(401).json({ error: 'no_refresh_token', message: 'Not signed in' });
      return;
    }

    const hash = hashToken(presented);
    const row = await findRefreshToken(hash);

    // Unknown or expired: nothing to rotate. Clear the cookie so the browser
    // stops presenting a value that can never work.
    if (!row || row.ExpiresAt.getTime() <= Date.now()) {
      res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
      res.status(401).json({ error: 'invalid_refresh_token', message: 'Session expired' });
      return;
    }

    // A revoked token being presented again is the reuse signal. Revoke the
    // whole family and refuse: whoever holds the other copy is now locked out
    // too, and the legitimate user is asked to sign in again.
    if (row.RevokedAt !== null) {
      await revokeRefreshFamily(row.UserID, hash);
      res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
      res.status(401).json({
        error: 'refresh_token_reused',
        message: 'Session ended for security. Please sign in again.',
      });
      return;
    }

    const user = await findUserById(row.UserID);

    if (!user || !user.IsActive) {
      await revokeRefreshFamily(row.UserID, hash);
      res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
      res.status(401).json({ error: 'account_inactive', message: 'Account is inactive' });
      return;
    }

    const replacement = createRefreshToken();
    const rotated = await rotateRefreshToken(row.RefreshTokenID, replacement.hash);

    // Lost the compare-and-swap: another request rotated this token first, so
    // this one is presenting a value that is now revoked. Same response as
    // reuse, which is what it is.
    if (!rotated) {
      await revokeRefreshFamily(row.UserID, hash);
      res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
      res.status(401).json({
        error: 'refresh_token_reused',
        message: 'Session ended for security. Please sign in again.',
      });
      return;
    }

    const authUser = toAuthUser(user);
    // The access token keeps its short life; only the refresh token is long.
    const { token, expiresAt } = signAccessToken(authUser, false);

    // Preserve the original lifetime: a rotated token inherits the remaining
    // window rather than silently extending a session forever.
    const remainingMs = row.ExpiresAt.getTime() - Date.now();
    const days = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
    await storeRefreshToken(
      user.UserID,
      replacement.hash,
      req.get('user-agent') ?? null,
      req.ip ?? null,
      days,
    );

    res.cookie(REFRESH_COOKIE, replacement.token, refreshCookieOptions(
      remainingMs > 24 * 60 * 60 * 1000 ? remainingMs : undefined,
    ));

    const body: LoginResponse = { token, expiresAt, user: authUser, rememberMe: true };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Revoke the refresh token and clear the cookie
 *     security: []
 *     responses:
 *       204: { description: Signed out }
 */
authRouter.post('/logout', async (req, res, next) => {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;

    // Revoke server-side, not just in the browser: clearing a cookie does not
    // stop a copy of its value from being replayed.
    if (presented) await revokeRefreshToken(hashToken(presented));

    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
