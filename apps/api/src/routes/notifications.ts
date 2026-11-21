import { Router } from 'express';
import { z } from 'zod';
import { query, sql } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { countForUser, listForUser, unreadCount } from '../services/notifications.js';

export const notificationsRouter = Router();

/**
 * @openapi
 * /api/notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: Notifications for the signed-in user
 *     description: >
 *       The bell's data source. Each user has independent read state, so one
 *       admin reading a notification does not clear it for the others.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, default: 20 } }
 *       - { in: query, name: offset, schema: { type: integer, default: 0 } }
 *       - { in: query, name: view, schema: { type: string, enum: [all, unread, archived], default: all } }
 *     responses:
 *       200: { description: Notifications plus unread count and total }
 */
notificationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
        view: z.enum(['all', 'unread', 'archived']).default('all'),
      })
      .safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'Invalid query' });
      return;
    }

    const userId = req.user!.userId;
    const { limit, offset, view } = parsed.data;

    const [rows, unread, total, archived] = await Promise.all([
      listForUser(userId, limit, { offset, view }),
      unreadCount(userId),
      countForUser(userId, view),
      countForUser(userId, 'archived'),
    ]);

    res.json({ data: rows, unread, total, archived, limit, offset });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/notifications/read-all:
 *   post:
 *     tags: [Notifications]
 *     summary: Mark every notification as read
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated count }
 */
notificationsRouter.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    const r = await query(
      `UPDATE core.NotificationRecipient
          SET ReadAt = SYSUTCDATETIME()
        WHERE UserID = @uid AND ReadAt IS NULL AND DismissedAt IS NULL`,
      { uid: { type: sql.Int, value: req.user!.userId } },
    );
    res.json({ updated: r.rowsAffected[0] ?? 0 });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/notifications/archive-all:
 *   post:
 *     tags: [Notifications]
 *     summary: Archive every notification currently in the All view
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated count }
 */
notificationsRouter.post('/archive-all', requireAuth, async (req, res, next) => {
  try {
    const r = await query(
      `UPDATE core.NotificationRecipient
          SET DismissedAt = SYSUTCDATETIME(),
              ReadAt = COALESCE(ReadAt, SYSUTCDATETIME())
        WHERE UserID = @uid AND DismissedAt IS NULL`,
      { uid: { type: sql.Int, value: req.user!.userId } },
    );
    res.json({ updated: r.rowsAffected[0] ?? 0 });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/notifications/{id}/read:
 *   post:
 *     tags: [Notifications]
 *     summary: Mark one notification as read
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Marked }
 */
notificationsRouter.post('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    await query(
      `UPDATE core.NotificationRecipient
          SET ReadAt = COALESCE(ReadAt, SYSUTCDATETIME())
        WHERE NotificationID = @nid AND UserID = @uid`,
      {
        nid: { type: sql.Int, value: id },
        uid: { type: sql.Int, value: req.user!.userId },
      },
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/notifications/{id}/archive:
 *   post:
 *     tags: [Notifications]
 *     summary: Archive one notification (hide it, keep it recoverable)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Archived }
 */
notificationsRouter.post('/:id/archive', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    // Archiving implies reading: an archived row must not keep the badge lit.
    await query(
      `UPDATE core.NotificationRecipient
          SET DismissedAt = COALESCE(DismissedAt, SYSUTCDATETIME()),
              ReadAt = COALESCE(ReadAt, SYSUTCDATETIME())
        WHERE NotificationID = @nid AND UserID = @uid`,
      {
        nid: { type: sql.Int, value: id },
        uid: { type: sql.Int, value: req.user!.userId },
      },
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/notifications/{id}/unarchive:
 *   post:
 *     tags: [Notifications]
 *     summary: Restore an archived notification
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Restored }
 */
notificationsRouter.post('/:id/unarchive', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    await query(
      `UPDATE core.NotificationRecipient
          SET DismissedAt = NULL
        WHERE NotificationID = @nid AND UserID = @uid`,
      {
        nid: { type: sql.Int, value: id },
        uid: { type: sql.Int, value: req.user!.userId },
      },
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
