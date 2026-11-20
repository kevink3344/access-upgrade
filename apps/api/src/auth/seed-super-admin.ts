import { env, superAdminEmail } from '../env.js';
import { query, sql } from '../db.js';
import { hashPassword } from './service.js';

/**
 * Seeds the SUPER_ADMIN row from environment variables on first boot.
 *
 * Behaviour:
 *  - No seeded super admin exists -> create it.
 *  - A seeded super admin exists  -> reconcile it: update email, password,
 *    display name and role to match the environment.
 *  - A matching email exists but is NOT env-seeded -> leave it alone. A
 *    password changed in the UI must never be reset by a restart.
 *
 * Matching is by IsSeeded, not by email, so changing SUPER_ADMIN_USERNAME
 * updates the existing account instead of creating a second super admin.
 */
export async function seedSuperAdmin(): Promise<void> {
  const email = superAdminEmail?.trim().toLowerCase();
  const password = env.SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    console.warn('[auth] SUPER_ADMIN_EMAIL / SUPER_ADMIN_USERNAME or SUPER_ADMIN_PASSWORD not set — skipping seed');
    return;
  }

  // Prefer the seeded row; fall back to an exact email match.
  const existing = await query<{ UserID: number; IsSeeded: boolean; Email: string }>(
    `SELECT TOP 1 UserID, IsSeeded, Email
       FROM core.AppUser
      WHERE IsSeeded = 1 OR Email = @email
      ORDER BY CASE WHEN IsSeeded = 1 THEN 0 ELSE 1 END, UserID`,
    { email: { type: sql.NVarChar(255), value: email } },
  );

  const row = existing.recordset[0];

  if (row) {
    if (!row.IsSeeded) {
      console.log(`[auth] ${email} exists and is not env-seeded — not modified`);
      return;
    }

    const hash = await hashPassword(password);
    await query(
      `UPDATE core.AppUser
          SET Email        = @email,
              PasswordHash = @hash,
              DisplayName  = @name,
              Role         = 'SUPER_ADMIN',
              IsActive     = 1,
              PasswordChangedAt = SYSUTCDATETIME(),
              UpdatedAt    = SYSUTCDATETIME()
        WHERE UserID = @id`,
      {
        email: { type: sql.NVarChar(255), value: email },
        hash: { type: sql.NVarChar(255), value: hash },
        name: { type: sql.NVarChar(150), value: env.SUPER_ADMIN_NAME },
        id: { type: sql.Int, value: row.UserID },
      },
    );
    console.log(
      row.Email === email
        ? `[auth] synced seeded SUPER_ADMIN ${email} from environment`
        : `[auth] renamed seeded SUPER_ADMIN ${row.Email} -> ${email} and synced password`,
    );
    return;
  }

  const hash = await hashPassword(password);

  await query(
    `INSERT INTO core.AppUser (Email, DisplayName, PasswordHash, Role, IsActive, IsSeeded, PasswordChangedAt)
     VALUES (@email, @name, @hash, 'SUPER_ADMIN', 1, 1, SYSUTCDATETIME())`,
    {
      email: { type: sql.NVarChar(255), value: email },
      name: { type: sql.NVarChar(150), value: env.SUPER_ADMIN_NAME },
      hash: { type: sql.NVarChar(255), value: hash },
    },
  );

  console.log(`[auth] seeded SUPER_ADMIN ${email}`);
}

// Allow running standalone: npm run seed
if (process.argv[1]?.endsWith('seed-super-admin.ts') || process.argv[1]?.endsWith('seed-super-admin.js')) {
  seedSuperAdmin()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
