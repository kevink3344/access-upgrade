import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../env.js';
import { query, sql } from '../db.js';
import type { AuthUser, UserRole } from '@pe/shared';

const BCRYPT_COST = 12;

export interface UserRow {
  UserID: number;
  Email: string;
  DisplayName: string;
  PasswordHash: string;
  Role: UserRole;
  IsActive: boolean;
  /** Opt out of notification emails; the in-app bell is unaffected. */
  ReceivesAdminEmail: boolean;
  IsSeeded: boolean;
  LastLoginAt: Date | null;
  PasswordChangedAt: Date | null;
  CreatedAt: Date;
  UpdatedAt: Date;
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    userId: row.UserID,
    email: row.Email,
    displayName: row.DisplayName,
    role: row.Role,
    isActive: row.IsActive,
    receivesAdminEmail: row.ReceivesAdminEmail,
    lastLoginAt: row.LastLoginAt ? row.LastLoginAt.toISOString() : null,
  };
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signAccessToken(
  user: AuthUser,
  rememberMe = false,
): { token: string; expiresAt: string } {
  const token = jwt.sign(
    {
      sub: String(user.userId),
      email: user.email,
      name: user.displayName,
      role: user.role,
    },
    env.JWT_SECRET,
    {
      expiresIn: (rememberMe
        ? `${env.REFRESH_TOKEN_DAYS}d`
        : env.JWT_EXPIRES_IN) as jwt.SignOptions['expiresIn'],
    },
  );

  const decoded = jwt.decode(token) as { exp: number };
  return { token, expiresAt: new Date(decoded.exp * 1000).toISOString() };
}

export function verifyAccessToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
}

/** Opaque refresh token — stored only as a SHA-256 hash. */
export function createRefreshToken(): { token: string; hash: Buffer } {
  const token = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest();
  return { token, hash };
}

export function hashToken(token: string): Buffer {
  return crypto.createHash('sha256').update(token).digest();
}

/** Salted IP hash — enough to rate-limit, without retaining personal data. */
export function hashIp(ip: string): Buffer {
  return crypto.createHash('sha256').update(`${env.JWT_SECRET}:${ip}`).digest();
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT TOP 1 * FROM core.AppUser WHERE Email = @email`,
    { email: { type: sql.NVarChar(255), value: email.trim().toLowerCase() } },
  );
  return result.recordset[0] ?? null;
}

export async function findUserById(userId: number): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT TOP 1 * FROM core.AppUser WHERE UserID = @id`,
    { id: { type: sql.Int, value: userId } },
  );
  return result.recordset[0] ?? null;
}

export async function recordLoginAttempt(
  email: string | null,
  succeeded: boolean,
  reason: string | null,
  ip: string | null,
): Promise<void> {
  await query(
    `INSERT INTO audit.LoginAttempt (Email, Succeeded, Reason, IpHash)
     VALUES (@email, @ok, @reason, @ip)`,
    {
      email: { type: sql.NVarChar(255), value: email },
      ok: { type: sql.Bit, value: succeeded ? 1 : 0 },
      reason: { type: sql.NVarChar(100), value: reason },
      ip: { type: sql.VarBinary(32), value: ip ? hashIp(ip) : null },
    },
  );
}

/** Failed attempts for an email in the last 15 minutes. */
export async function recentFailedAttempts(email: string): Promise<number> {
  const result = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit.LoginAttempt
     WHERE Email = @email AND Succeeded = 0
       AND AttemptedAt > DATEADD(MINUTE, -15, SYSUTCDATETIME())`,
    { email: { type: sql.NVarChar(255), value: email.trim().toLowerCase() } },
  );
  return result.recordset[0]?.n ?? 0;
}

export async function touchLastLogin(userId: number): Promise<void> {
  await query(
    `UPDATE core.AppUser SET LastLoginAt = SYSUTCDATETIME() WHERE UserID = @id`,
    { id: { type: sql.Int, value: userId } },
  );
}

export async function storeRefreshToken(
  userId: number,
  hash: Buffer,
  userAgent: string | null,
  ip: string | null,
  days: number = env.REFRESH_TOKEN_DAYS,
): Promise<void> {
  await query(
    `INSERT INTO core.RefreshToken (UserID, TokenHash, ExpiresAt, UserAgent, IpHash)
     VALUES (@uid, @hash, DATEADD(DAY, @days, SYSUTCDATETIME()), @ua, @ip)`,
    {
      uid: { type: sql.Int, value: userId },
      hash: { type: sql.VarBinary(32), value: hash },
      days: { type: sql.Int, value: days },
      ua: { type: sql.NVarChar(400), value: userAgent },
      ip: { type: sql.VarBinary(32), value: ip ? hashIp(ip) : null },
    },
  );
}
