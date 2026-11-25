import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment validation. Fails fast at boot rather than surfacing
 * a confusing runtime error later.
 */
const schema = z.object({
  /**
   * Only three values are meaningful, but a typo here must not stop the app.
   *
   * `NODE_ENV=staging` is a natural mistake on an App Service slot, and
   * rejecting it made the process exit before it could listen - the site then
   * answered 503, which reads as a missing-configuration problem rather than a
   * bad value. Anything unrecognised is treated as production, the safe
   * default: secure cookies and no error details in responses.
   */
  NODE_ENV: z
    .string()
    .optional()
    .transform((v) => (v === 'development' || v === 'test' ? v : 'production')),
  PORT: z.coerce.number().int().positive().default(3001),

  /**
   * Deployment label shown as a badge in the UI, e.g. "TEST SITE".
   * Blank or absent means no badge, so production needs no configuration.
   */
  MODE: z.string().trim().optional(),

  AZURE_SQL_SERVER: z.string().min(1),
  AZURE_SQL_DATABASE: z.string().min(1),
  AZURE_SQL_USER: z.string().min(1),
  AZURE_SQL_PASSWORD: z.string().min(1),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(7),

  WEB_ORIGIN: z.string().default('http://localhost:5173'),

  /** Seeded on first boot, then a normal row. */
  SUPER_ADMIN_EMAIL: z.string().email().optional(),
  /** Alias used by database/.env.example. */
  SUPER_ADMIN_USERNAME: z.string().email().optional(),
  SUPER_ADMIN_PASSWORD: z.string().min(6).optional(),
  SUPER_ADMIN_NAME: z.string().default('Super Administrator'),
});

const parsed = schema.safeParse(process.env);

/**
 * Under test, a missing environment is not fatal.
 *
 * The suite is run by CI, which has no database credentials and no JWT secret.
 * Exiting here would kill the whole run before a single test could report —
 * including the pure tests that need no database at all. Tests that do need
 * one check `env` themselves and skip.
 */
if (!parsed.success) {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    // Deliberately quiet: the DB-backed suites report their own skip reason.
  } else {
    console.error('\n❌ Invalid environment configuration:\n');
    for (const issue of parsed.error.issues) {
      const name = issue.path.join('.');
      // Name the offending value, not just the missing ones. A wrong value is
      // indistinguishable from a missing one in a 503, and that costs real
      // time to diagnose from the outside.
      const given = process.env[name];
      const detail = given === undefined ? '(not set)' : `got "${given}"`;
      console.error(`   ${name}: ${issue.message} ${detail}`);
    }
    console.error('\n   Copy database/.env.example to apps/api/.env and fill in the values.\n');
    process.exit(1);
  }
}

/** True when the app has everything it needs to start. */
export const envConfigured = parsed.success;

export const env = parsed.success ? parsed.data : ({} as z.infer<typeof schema>);

/** Super-admin email, accepting either variable name. */
export const superAdminEmail = env.SUPER_ADMIN_EMAIL ?? env.SUPER_ADMIN_USERNAME;

export const isProd = env.NODE_ENV === 'production';
