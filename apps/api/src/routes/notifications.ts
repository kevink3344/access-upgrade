import { Router } from 'express';
import { z } from 'zod';
import { query, sql } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { countForUser, listForUser, unreadCount } from '../services/notifications.js';

export const notificationsRouter = Router();

/**
 * Every kind of notification the app can raise.
 *
 * Kept beside the routes rather than in the database: a kind only exists
 * because some piece of code calls `createNotification` with it, so a table
 * would be a second place to forget to update. Adding a kind means adding a
 * row here and the call that produces it.
 */
const NOTIFICATION_KINDS = [
  {
    kind: 'school-cash-applied',
    label: 'School Cash matching completed',
    description:
      'A summary after an upload is applied: how many payments were taken, and anything left needing review.',
    audience: 'Super administrators and administrators',
    active: true,
  },
  {
    kind: 'workshop-capacity',
    label: 'Workshop nearing capacity',
    description:
      'Raised once when a workshop crosses its alert threshold, and again only after it drops below and refills.',
    audience: 'Super administrators and administrators',
    active: true,
  },
];

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
 * /api/notifications/catalogue:
 *   get:
 *     tags: [Notifications]
 *     summary: What the system notifies staff about
 *     description: >
 *       The list of notification kinds, how they are delivered, and recent
 *       volume. Declared in code because each kind is produced by specific
 *       logic — this endpoint reports it, it does not configure it.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Catalogue plus stats }
 */
notificationsRouter.get('/catalogue', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.userId;

    const [stats, unread] = await Promise.all([
      query<{ total: number; last7Days: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN CreatedAt >= DATEADD(day, -7, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS last7Days
           FROM core.Notification`,
      ),
      unreadCount(userId),
    ]);

    res.json({
      kinds: NOTIFICATION_KINDS,
      channels: [
        {
          key: 'in-app',
          label: 'In-app bell',
          description: 'Every notification appears under the bell and on the Notifications page.',
          enabled: true,
        },
        {
          key: 'email',
          label: 'Email to administrators',
          description:
            'Sent through the admin webhook when one is configured. The in-app record is written either way.',
          enabled: true,
        },
      ],
      stats: {
        total: stats.recordset[0]?.total ?? 0,
        last7Days: stats.recordset[0]?.last7Days ?? 0,
        unreadForMe: unread,
      },
    });
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
 * /api/notifications/{id}/unread:
 *   post:
 *     tags: [Notifications]
 *     summary: Mark one notification as unread
 *     description: >
 *       Clears ReadAt so the row shows as unread again and the bell badge
 *       counts it. An archived row is left archived — unread and archived are
 *       independent, and "mark unread" should not silently restore something
 *       the user deliberately hid.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Marked }
 */
notificationsRouter.post('/:id/unread', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    await query(
      `UPDATE core.NotificationRecipient
          SET ReadAt = NULL
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
