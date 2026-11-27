import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
import { presentersRouter } from './routes/presenters.js';
import { workshopNamesRouter } from './routes/workshop-names.js';
import { paymentsRouter } from './routes/payments.js';
import { registrationsRouter } from './routes/registrations.js';
import { lookupsRouter } from './routes/lookups.js';
import { registrationLinkRouter } from './routes/registration-link.js';
import { publicRouter } from './routes/public.js';
import { certificatesRouter } from './routes/certificates.js';
import { reportsRouter } from './routes/reports.js';
import { notificationsRouter } from './routes/notifications.js';
import { webhooksRouter } from './routes/webhooks.js';
import { formsRouter } from './routes/forms.js';
import { formLinkRouter } from './routes/form-link.js';
import { trainingRequestsRouter } from './routes/training-requests.js';
import { creditSlipsRouter } from './routes/credit-slips.js';
import { schoolCashRouter } from './routes/schoolcash.js';
import { foldersRouter } from './routes/folders.js';
import { utilitiesRouter } from './routes/utilities.js';
import { calendarFeedRouter } from './routes/calendar-feed.js';
import { startReportScheduler } from './services/report-scheduler.js';
import { statusRouter } from './routes/status.js';
import { appearanceRouter } from './routes/appearance.js';

const app = express();

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false })); // Swagger UI needs inline styles
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
// Certificate images travel as base64 data URIs, which inflate by ~4/3, so a
// 2 MB image needs ~2.7 MB of body. 4 MB leaves headroom without inviting
// genuinely large uploads.
app.use(express.json({ limit: '4mb' }));
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
  { name: 'Presenters', description: 'Presenters and staff' },
  { name: 'Workshop catalog', description: 'Reusable workshop definitions' },
  { name: 'Payments', description: 'Payments and receipts' },
      { name: 'Registrations', description: 'Enrolments and payments' },
      { name: 'Public registration', description: 'Shareable links and the public form' },
      { name: 'Lookups', description: 'Reference data' },
      { name: 'Training requests', description: 'On-site training requests, quotes and invoicing' },
      { name: 'Credit slips', description: 'Vouchers issued for cancellations and overpayments' },
      { name: 'Calendar feed', description: 'The workshop calendar as a subscribable iCalendar feed' },
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
app.use('/api/presenters', presentersRouter);
app.use('/api/workshop-names', workshopNamesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/registrations', registrationsRouter);
app.use('/api/lookups', lookupsRouter);
app.use('/api/certificates', certificatesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/forms', formsRouter);
app.use('/api/forms/:id/link', formLinkRouter);
app.use('/api/training-requests', trainingRequestsRouter);
app.use('/api/credit-slips', creditSlipsRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/admin/utilities', utilitiesRouter);
app.use('/api/admin/status', statusRouter);
app.use('/api/admin/appearance', appearanceRouter);
app.use('/api/calendar', calendarFeedRouter);
// The School Cash upload is the raw CSV as text/plain, not multipart, so it
// needs its own body parser. Mounted before the router so only this path is
// affected.
app.use(
  '/api/school-cash',
  express.text({ type: ['text/plain', 'text/csv', 'application/csv'], limit: '8mb' }),
  schoolCashRouter,
);

// Public surface — no auth. Must be mounted before the auth-guarded routes
// would ever apply; it has its own rate limits and audit logging.
app.use('/api/public', publicRouter);

// ---- Static frontend -----------------------------------------------------
// The built React app is served from the same origin as the API, so staff
// use one URL and there is no CORS to configure. Vite serves it in
// development, so this only activates when a build is actually present -
// which is a more reliable signal than NODE_ENV. An App Service can be left
// on the default NODE_ENV and the frontend would otherwise silently not load.
//
// The package is ESM ("type": "module"), so __dirname does not exist.
// This file lives in dist/routes/, so the app root is two levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = [
  path.resolve(here, '../../web/dist'), // dist/routes -> app root
  path.resolve(here, '../web/dist'),
  path.resolve(here, '../../../web/dist'), // in-repo: apps/api/dist/routes
].find((p) => fs.existsSync(path.join(p, 'index.html')));

if (webDist) {
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
} else {
  console.log('  Web      no build found - serving the API only (expected in dev)');
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
// Only listen when this file is the process entry point. Tests import `app`
// and drive it with supertest, which must not bind a port.
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const server = isEntryPoint
  ? app.listen(env.PORT, async () => {
      console.log(`\n  API      http://localhost:${env.PORT}`);
      console.log(`  Swagger  http://localhost:${env.PORT}/swagger`);
      console.log(`  Spec     http://localhost:${env.PORT}/openapi.json\n`);

      try {
        await getPool();
        console.log('  SQL      connected');
        await seedSuperAdmin();
        // Started only in the real process: tests import `app` and must not
        // run a background job.
        startReportScheduler();
        console.log('  Reports  subscription scheduler started');
      } catch (err) {
        console.error('  SQL      connection failed:', (err as Error).message);
      }
    })
  : null;

async function shutdown(signal: string) {
  console.log(`\n[api] ${signal} received, shutting down`);
  if (!server) {
    await closePool();
    process.exit(0);
  }
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { app };
