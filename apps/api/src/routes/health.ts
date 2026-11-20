import { Router } from 'express';
import { getPool } from '../db.js';

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

// TEMPORARY diagnostic - remove once the static-file layout is confirmed.
healthRouter.get('/diag', async (_req, res) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const list = (p: string) => {
    try {
      return fs.readdirSync(p);
    } catch (e) {
      return `ERR: ${(e as Error).message}`;
    }
  };

  res.json({
    nodeEnv: process.env.NODE_ENV ?? '(unset)',
    cwd: process.cwd(),
    here,
    hereParent: list(path.resolve(here, '..')),
    hereGrandparent: list(path.resolve(here, '../..')),
    candidates: [
      path.resolve(here, '../web/dist'),
      path.resolve(here, '../../web/dist'),
    ].map((p) => ({ path: p, exists: fs.existsSync(p), index: fs.existsSync(path.join(p, 'index.html')) })),
  });
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
