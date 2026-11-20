import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, isProd } from './env.js';
import { getPool, closePool } from './db.js';
import { seedSuperAdmin } from './auth/seed-super-admin.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { healthRouter } from './routes/health.js';
import { usersRouter } from './routes/users.js';
import { workshopsRouter } from './routes/workshops.js';
import { participantsRouter } from './routes/participants.js';
import { agenciesRouter } from './routes/agencies.js';
import { registrationsRouter } from './routes/registrations.js';
import { lookupsRouter } from './routes/lookups.js';
import { registrationLinkRouter } from './routes/registration-link.js';
import { publicRouter } from './routes/public.js';

const app = express();

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false })); // Swagger UI needs inline styles
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ---- OpenAPI / Swagger UI ------------------------------------------------
const openapiSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Project Enlightenment Training API',
      version: '0.1.0',
      description:
        'REST API for the Project Enlightenment training database. ' +
        'JWT bearer authentication; see /api/auth/login.',
    },
    servers: [{ url: '/', description: 'Current host' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        AuthUser: {
          type: 'object',
          properties: {
            userId: { type: 'integer' },
            email: { type: 'string', format: 'email' },
            displayName: { type: 'string' },
            role: {
              type: 'string',
              enum: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR', 'VIEWER'],
            },
            isActive: { type: 'boolean' },
            lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        DashboardSummary: {
          type: 'object',
          properties: {
            schoolYear: {
              type: 'object',
              nullable: true,
              properties: { id: { type: 'integer' }, name: { type: 'string' } },
            },
            counts: {
              type: 'object',
              properties: {
                workshops: { type: 'integer' },
                participants: { type: 'integer' },
                registrations: { type: 'integer' },
                agencies: { type: 'integer' },
              },
            },
            currentYear: {
              type: 'object',
              properties: {
                workshops: { type: 'integer' },
                registrations: { type: 'integer' },
                participants: { type: 'integer' },
                revenue: { type: 'number' },
              },
            },
            upcomingWorkshops: { type: 'array', items: { type: 'object' } },
            unpaidRegistrations: {
              type: 'object',
              properties: { count: { type: 'integer' }, total: { type: 'number' } },
            },
            recentActivity: { type: 'array', items: { type: 'object' } },
          },
        },
        WorkshopSummary: {
          type: 'object',
          properties: {
            workshopId: { type: 'integer' },
            workshopCode: { type: 'string', nullable: true },
            workshopName: { type: 'string', nullable: true },
            startDate: { type: 'string', format: 'date', nullable: true },
            endDate: { type: 'string', format: 'date', nullable: true },
            schoolYear: { type: 'string', nullable: true },
            categoryCode: { type: 'string', nullable: true },
            registered: { type: 'integer' },
            capacity: { type: 'integer', nullable: true },
            isClosed: { type: 'boolean' },
            isCancelled: { type: 'boolean' },
          },
        },
        WorkshopDetail: {
          type: 'object',
          description: 'Full workshop record plus joined names and registration count.',
          additionalProperties: true,
        },
        ParticipantSummary: {
          type: 'object',
          properties: {
            participantId: { type: 'integer' },
            firstName: { type: 'string', nullable: true },
            lastName: { type: 'string', nullable: true },
            email: { type: 'string', nullable: true },
            agencyName: { type: 'string', nullable: true },
            hasCeuCertificate: { type: 'boolean' },
            hasChcCertificate: { type: 'boolean' },
            registrationCount: { type: 'integer' },
          },
        },
        AgencySummary: {
          type: 'object',
          properties: {
            AgencyID: { type: 'integer' },
            AgencyName: { type: 'string', nullable: true },
            AgencyShortName: { type: 'string', nullable: true },
            AgencyPhone: { type: 'string', nullable: true },
            AgencyZip: { type: 'string', nullable: true },
            IsOutOfBusiness: { type: 'boolean' },
            IsWorkshopSite: { type: 'boolean' },
            City: { type: 'string', nullable: true },
            ParticipantCount: { type: 'integer' },
          },
        },
        RegistrationSummary: {
          type: 'object',
          properties: {
            RegistrationID: { type: 'integer' },
            ParticipantID: { type: 'integer' },
            WorkshopID: { type: 'integer', nullable: true },
            ParticipantName: { type: 'string', nullable: true },
            Email: { type: 'string', nullable: true },
            WorkshopName: { type: 'string', nullable: true },
            WorkshopCode: { type: 'string', nullable: true },
            StartDate: { type: 'string', format: 'date-time', nullable: true },
            PaidAmount: { type: 'number', nullable: true },
            RegistrationDate: { type: 'string', format: 'date-time', nullable: true },
            IsCancelled: { type: 'boolean' },
            Attended: { type: 'boolean' },
            Source: { type: 'string', enum: ['Manual', 'Web', 'ESchools'] },
          },
        },
      },
    },
    tags: [
      { name: 'Health', description: 'Liveness and readiness probes' },
      { name: 'Auth', description: 'Sign in and session' },
      { name: 'Dashboard', description: 'Landing-page summary' },
      { name: 'Users', description: 'User administration' },
      { name: 'Workshops', description: 'Workshops, sessions, rosters' },
      { name: 'Participants', description: 'People who attend' },
      { name: 'Agencies', description: 'Schools and organisations' },
      { name: 'Registrations', description: 'Enrolments and payments' },
      { name: 'Public registration', description: 'Shareable links and the public form' },
      { name: 'Lookups', description: 'Reference data' },
    ],
  },
  apis: ['./src/routes/*.ts', './dist/routes/*.js'],
});

app.get('/openapi.json', (_req, res) => res.json(openapiSpec));
app.use('/swagger', swaggerUi.serve, swaggerUi.setup(openapiSpec, { customSiteTitle: 'PE Training API' }));

// ---- Health --------------------------------------------------------------
app.use('/health', healthRouter);

// ---- Routes --------------------------------------------------------------
app.use('/api/auth', authRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/users', usersRouter);
app.use('/api/workshops', workshopsRouter);
app.use('/api/workshops/:id/registration-link', registrationLinkRouter);
app.use('/api/participants', participantsRouter);
app.use('/api/agencies', agenciesRouter);
app.use('/api/registrations', registrationsRouter);
app.use('/api/lookups', lookupsRouter);

// Public surface â€” no auth. Must be mounted before the auth-guarded routes
// would ever apply; it has its own rate limits and audit logging.
app.use('/api/public', publicRouter);

// ---- Static frontend -----------------------------------------------------
// In production the built React app is served from the same origin as the
// API, so staff use one URL and there is no CORS to configure. In
// development Vite serves the app on its own port and this block is skipped.
//
// The package is ESM ("type": "module"), so __dirname does not exist.
// The web build can sit in either of two places depending on how the app is
// packaged, so both are probed rather than assuming one:
//   deployed:   <root>/dist/server.js  +  <root>/web/dist
//   in-repo:    apps/api/dist/server.js +  apps/web/dist
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = [
  path.resolve(here, '../web/dist'),
  path.resolve(here, '../../web/dist'),
].find((p) => fs.existsSync(path.join(p, 'index.html')));

if (isProd && webDist) {
  app.use(
    express.static(webDist, {
      index: false,
      setHeaders(res, filePath) {
        // Hashed assets are immutable; index.html must never be cached or
        // users keep a stale shell after a deploy. Vite hashes are base64url
        // (letters, digits, - and _), not hex, so match that alphabet.
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  // Client-side routing: any non-API GET returns index.html so deep links
  // like /workshops/3023 work on refresh.
  app.get(/^\/(?!api\/|swagger|openapi\.json|health).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });

  console.log(`  Web      serving ${webDist}`);
} else if (isProd) {
  console.warn('  Web      no build found - serving the API only');
}

// ---- Errors --------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Endpoint not found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] unhandled error:', err);
  res.status(500).json({
    error: 'internal_error',
    message: isProd ? 'Something went wrong' : err.message,
  });
});

// ---- Boot ----------------------------------------------------------------
const server = app.listen(env.PORT, async () => {
  console.log(`\n  API      http://localhost:${env.PORT}`);
  console.log(`  Swagger  http://localhost:${env.PORT}/swagger`);
  console.log(`  Spec     http://localhost:${env.PORT}/openapi.json\n`);

  try {
    await getPool();
    console.log('  SQL      connected');
    await seedSuperAdmin();
  } catch (err) {
    console.error('  SQL      connection failed:', (err as Error).message);
  }
});

async function shutdown(signal: string) {
  console.log(`\n[api] ${signal} received, shutting down`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { app };
