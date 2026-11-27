import { Router } from 'express';
import { getPool } from '../db.js';
import { env } from '../env.js';
import { getLoginTheme } from '../services/login-theme.js';

export const healthRouter = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Liveness probe
 *     description: >
 *       Returns 200 whenever the process is running. Does not touch the
 *       database, so a slow or unavailable SQL Server does not cause the
 *       container to be restarted.
 *     security: []
 *     responses:
 *       200:
 *         description: Process is alive
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ok }
 *                 uptime: { type: number, description: Seconds since process start }
 *                 version: { type: string }
 *                 timestamp: { type: string, format: date-time }
 */
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime() * 100) / 100,
    version: process.env.npm_package_version ?? '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /health/config:
 *   get:
 *     tags: [Health]
 *     summary: Public UI configuration
 *     description: >
 *       Non-sensitive settings the browser needs before anyone logs in, such
 *       as the deployment badge. Deliberately unauthenticated — it must not
 *       ever expose secrets.
 *     security: []
 *     responses:
 *       200:
 *         description: Public configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 mode:
 *                   type: string
 *                   nullable: true
 *                   description: >
 *                     Deployment label such as "TEST SITE". Null when the
 *                     MODE environment variable is blank or unset.
 *                   example: TEST SITE
 */
healthRouter.get('/config', async (_req, res, next) => {
  try {
    const mode = env.MODE && env.MODE.length > 0 ? env.MODE : null;
    // The login screen's look, so it is right before anyone signs in. Not
    // cached: an admin's change should show on the next page load.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ mode, loginTheme: await getLoginTheme() });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     tags: [Health]
 *     summary: Readiness probe
 *     description: >
 *       Verifies the database is reachable by opening the connection pool.
 *       Returns 503 when SQL Server is unavailable, so a load balancer stops
 *       sending traffic.
 *     security: []
 *     responses:
 *       200:
 *         description: Ready to serve traffic
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ready }
 *                 database: { type: string, example: connected }
 *                 latencyMs: { type: number }
 *                 timestamp: { type: string, format: date-time }
 *       503:
 *         description: Database unavailable
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: not_ready }
 *                 database: { type: string, example: unavailable }
 *                 message: { type: string }
 */
healthRouter.get('/ready', async (_req, res) => {
  const started = Date.now();

  try {
    await getPool();
    res.json({
      status: 'ready',
      database: 'connected',
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'not_ready',
      database: 'unavailable',
      message: err instanceof Error ? err.message : 'Database connection failed',
      timestamp: new Date().toISOString(),
    });
  }
});
