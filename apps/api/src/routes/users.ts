import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { hashPassword, toAuthUser, type UserRow } from '../auth/service.js';

export const usersRouter = Router();

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR', 'VIEWER'] as const;

const createSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(150),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(ROLES),
  isActive: z.boolean().optional().default(true),
});

const updateSchema = z.object({
  email: z.string().email().optional(),
  displayName: z.string().min(1).max(150).optional(),
  password: z.string().min(6).optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
});

/**
 * @openapi
 * /api/users:
 *   get:
 *     tags: [Users]
 *     summary: List users
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: q, schema: { type: string }, description: Search email or name }
 *       - { in: query, name: role, schema: { type: string } }
 *       - { in: query, name: isActive, schema: { type: boolean } }
 *     responses:
 *       200:
 *         description: Users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/AuthUser' } }
 *                 total: { type: integer }
 */
usersRouter.get('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const role = typeof req.query.role === 'string' ? req.query.role : '';
    const isActive = req.query.isActive;

    const conditions: string[] = [];
    const params: Record<string, SqlParam> = {};

    if (q) {
      conditions.push('(Email LIKE @q OR DisplayName LIKE @q)');
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    if (role && ROLES.includes(role as (typeof ROLES)[number])) {
      conditions.push('Role = @role');
      params.role = { type: sql.NVarChar(20), value: role };
    }
    if (isActive === 'true' || isActive === 'false') {
      conditions.push('IsActive = @active');
      params.active = { type: sql.Bit, value: isActive === 'true' ? 1 : 0 };
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query<UserRow>(
      `SELECT UserID, Email, DisplayName, PasswordHash, Role, IsActive, IsSeeded,
              LastLoginAt, PasswordChangedAt, CreatedAt, UpdatedAt
         FROM core.AppUser ${where}
        ORDER BY DisplayName`,
      params,
    );

    res.json({
      data: result.recordset.map(toAuthUser),
      total: result.recordset.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/users/{id}:
 *   get:
 *     tags: [Users]
 *     summary: Get a user
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: User
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthUser' }
 *       404: { description: Not found }
 */
usersRouter.get('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const result = await query<UserRow>(
      `SELECT * FROM core.AppUser WHERE UserID = @id`,
      { id: { type: sql.Int, value: id } },
    );
    const row = result.recordset[0];

    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'User not found' });
      return;
    }

    res.json(toAuthUser(row));
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/users:
 *   post:
 *     tags: [Users]
 *     summary: Create a user
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, displayName, password, role]
 *             properties:
 *               email: { type: string, format: email }
 *               displayName: { type: string }
 *               password: { type: string, minLength: 6 }
 *               role: { type: string, enum: [SUPER_ADMIN, ADMIN, MANAGER, EDITOR, VIEWER] }
 *               isActive: { type: boolean, default: true }
 *     responses:
 *       201:
 *         description: Created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthUser' }
 *       409: { description: Email already exists }
 *       422: { description: Validation failed }
 */
usersRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid user data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { email, displayName, password, role, isActive } = parsed.data;
    const normalized = email.trim().toLowerCase();

    const existing = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM core.AppUser WHERE Email = @email`,
      { email: { type: sql.NVarChar(255), value: normalized } },
    );

    if ((existing.recordset[0]?.n ?? 0) > 0) {
      res.status(409).json({ error: 'conflict', message: 'A user with that email already exists' });
      return;
    }

    const hash = await hashPassword(password);
    const created = await query<UserRow>(
      `INSERT INTO core.AppUser (Email, DisplayName, PasswordHash, Role, IsActive, IsSeeded, PasswordChangedAt)
       OUTPUT INSERTED.*
       VALUES (@email, @name, @hash, @role, @active, 0, SYSUTCDATETIME())`,
      {
        email: { type: sql.NVarChar(255), value: normalized },
        name: { type: sql.NVarChar(150), value: displayName },
        hash: { type: sql.NVarChar(255), value: hash },
        role: { type: sql.NVarChar(20), value: role },
        active: { type: sql.Bit, value: isActive ? 1 : 0 },
      },
    );

    res.status(201).json(toAuthUser(created.recordset[0]!));
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/users/{id}:
 *   patch:
 *     tags: [Users]
 *     summary: Update a user
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               displayName: { type: string }
 *               password: { type: string, minLength: 6 }
 *               role: { type: string, enum: [SUPER_ADMIN, ADMIN, MANAGER, EDITOR, VIEWER] }
 *               isActive: { type: boolean }
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthUser' }
 *       404: { description: Not found }
 *       422: { description: Validation failed }
 */
usersRouter.patch('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid user data',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    // Guard: an admin must not lock themselves out.
    if (req.user?.userId === id && parsed.data.isActive === false) {
      res.status(409).json({ error: 'conflict', message: 'You cannot deactivate your own account' });
      return;
    }

    const sets: string[] = [];
    const params: Record<string, SqlParam> = {
      id: { type: sql.Int, value: id },
    };

    const d = parsed.data;
    if (d.email !== undefined) {
      sets.push('Email = @email');
      params.email = { type: sql.NVarChar(255), value: d.email.trim().toLowerCase() };
    }
    if (d.displayName !== undefined) {
      sets.push('DisplayName = @name');
      params.name = { type: sql.NVarChar(150), value: d.displayName };
    }
    if (d.role !== undefined) {
      sets.push('Role = @role');
      params.role = { type: sql.NVarChar(20), value: d.role };
    }
    if (d.isActive !== undefined) {
      sets.push('IsActive = @active');
      params.active = { type: sql.Bit, value: d.isActive ? 1 : 0 };
    }
    if (d.password !== undefined) {
      sets.push('PasswordHash = @hash', 'PasswordChangedAt = SYSUTCDATETIME()');
      params.hash = { type: sql.NVarChar(255), value: await hashPassword(d.password) };
    }

    if (sets.length === 0) {
      res.status(422).json({ error: 'validation_failed', message: 'No fields to update' });
      return;
    }

    sets.push('UpdatedAt = SYSUTCDATETIME()');

    const updated = await query<UserRow>(
      `UPDATE core.AppUser SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE UserID = @id`,
      params,
    );

    const row = updated.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'User not found' });
      return;
    }

    res.json(toAuthUser(row));
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/users/{id}:
 *   delete:
 *     tags: [Users]
 *     summary: Deactivate a user (soft delete)
 *     description: Users are deactivated, never deleted, so audit history stays intact.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deactivated }
 *       404: { description: Not found }
 *       409: { description: Cannot deactivate yourself }
 */
usersRouter.delete('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    if (req.user?.userId === id) {
      res.status(409).json({ error: 'conflict', message: 'You cannot deactivate your own account' });
      return;
    }

    const result = await query(
      `UPDATE core.AppUser
          SET IsActive = 0, UpdatedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.UserID
        WHERE UserID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    if (result.recordset.length === 0) {
      res.status(404).json({ error: 'not_found', message: 'User not found' });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
