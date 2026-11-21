import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

export const webhooksRouter = Router();

/**
 * Staff-managed outbound webhooks.
 *
 * Each row is one endpoint. The JSON Schema describes the payload the app
 * will POST, so the schema and the sender cannot drift apart silently: it is
 * validated on save and used to build the test payload.
 */

const webhookWrite = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  url: z
    .string()
    .trim()
    .min(1, 'URL is required')
    .max(2000)
    .refine((v) => /^https?:\/\//i.test(v), 'URL must start with http:// or https://'),
  jsonSchema: z.string().nullable().optional(),
  payloadFormat: z.enum(['json', 'slack']).optional(),
  isActive: z.boolean().optional(),
  secret: z.string().max(200).nullable().optional(),
});

/**
 * Checks that the stored schema is valid JSON and looks like a JSON Schema.
 *
 * Deliberately shallow: a full schema validator is a large dependency for a
 * field staff edit by hand. Catching malformed JSON and a missing `type` or
 * `properties` covers the realistic mistakes.
 */
function validateSchema(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'JSON Schema is not valid JSON';
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'JSON Schema must be a JSON object';
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj.type && !obj.properties && !obj.$ref) {
    return 'JSON Schema needs a "type", "properties" or "$ref" key';
  }

  return null;
}

/** Builds a sample payload from the schema, for the test send. */
function sampleFromSchema(schemaText: string | null): Record<string, unknown> {
  if (!schemaText) {
    return { message: 'Test payload from the Project Enlightenment training database' };
  }

  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(schemaText) as Record<string, unknown>;
  } catch {
    return { message: 'Test payload from the Project Enlightenment training database' };
  }

  const build = (node: Record<string, unknown>): unknown => {
    const type = node.type as string | undefined;
    if (node.example !== undefined) return node.example;
    if (node.default !== undefined) return node.default;

    switch (type) {
      case 'object': {
        const props = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(props)) out[key] = build(child);
        return out;
      }
      case 'array': {
        const items = node.items as Record<string, unknown> | undefined;
        return items ? [build(items)] : [];
      }
      case 'integer':
      case 'number':
        return 0;
      case 'boolean':
        return true;
      case 'string':
        return 'sample';
      default:
        return null;
    }
  };

  const result = build(schema);
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { payload: result };
}

/**
 * Shapes the body actually POSTed.
 *
 * `json` sends the schema-shaped object as-is. `slack` wraps it, because
 * Slack's incoming webhooks reject arbitrary JSON — they require a top-level
 * `text` or `blocks` field, so a schema cannot describe them.
 */
function buildPayload(
  format: 'json' | 'slack',
  eventKind: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (format === 'slack') {
    // A short human-readable line, plus the data as a code block so nothing
    // is lost. Slack renders `mrkdwn`.
    const summary =
      typeof data.message === 'string'
        ? data.message
        : typeof data.title === 'string'
          ? data.title
          : `Project Enlightenment — ${eventKind}`;

    return {
      text: summary,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${summary}*` } },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '```' + JSON.stringify(data, null, 2) + '```' },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `${eventKind} · ${new Date().toISOString()}` },
          ],
        },
      ],
    };
  }

  return { event: eventKind, sentAt: new Date().toISOString(), data };
}

/** Records an attempt so a failing endpoint is visible rather than silent. */
async function recordDelivery(input: {
  webhookId: number;
  eventKind: string;
  payload: string;
  statusCode: number | null;
  succeeded: boolean;
  error: string | null;
  durationMs: number;
}): Promise<void> {
  await query(
    `INSERT INTO core.WebhookDelivery
       (WebhookID, EventKind, Payload, StatusCode, Succeeded, Error, DurationMs)
     VALUES (@wid, @kind, @payload, @status, @ok, @err, @ms)`,
    {
      wid: { type: sql.Int, value: input.webhookId },
      kind: { type: sql.NVarChar(40), value: input.eventKind },
      payload: { type: sql.NVarChar(sql.MAX), value: input.payload },
      status: { type: sql.Int, value: input.statusCode },
      ok: { type: sql.Bit, value: input.succeeded ? 1 : 0 },
      err: { type: sql.NVarChar(1000), value: input.error },
      ms: { type: sql.Int, value: input.durationMs },
    },
  );
}

/** POSTs a payload and never throws — the caller records the outcome. */
async function postWebhook(
  url: string,
  payload: unknown,
  secret: string | null,
): Promise<{ statusCode: number | null; ok: boolean; error: string | null; durationMs: number }> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Webhook-Secret': secret } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return {
      statusCode: res.status,
      ok: res.ok,
      error: res.ok ? null : `Endpoint returned ${res.status}`,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      statusCode: null,
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 1000) : 'Request failed',
      durationMs: Date.now() - started,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  CRUD                                                               */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/webhooks:
 *   get:
 *     tags: [Webhooks]
 *     summary: List webhooks
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Webhooks }
 */
webhooksRouter.get('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (_req, res, next) => {
  try {
    const r = await query(
      `SELECT w.WebhookID, w.Title, w.Description, w.Url, w.JsonSchema, w.PayloadFormat, w.IsActive,
              w.CreatedBy, w.CreatedAt, w.UpdatedBy, w.UpdatedAt,
              (SELECT COUNT(*) FROM core.WebhookDelivery d WHERE d.WebhookID = w.WebhookID) AS DeliveryCount,
              (SELECT TOP 1 d.Succeeded FROM core.WebhookDelivery d
                WHERE d.WebhookID = w.WebhookID ORDER BY d.AttemptedAt DESC) AS LastSucceeded,
              (SELECT TOP 1 d.AttemptedAt FROM core.WebhookDelivery d
                WHERE d.WebhookID = w.WebhookID ORDER BY d.AttemptedAt DESC) AS LastAttemptAt
         FROM core.Webhook w
        ORDER BY w.Title`,
    );
    res.json({ data: r.recordset });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/webhooks/{id}:
 *   get:
 *     tags: [Webhooks]
 *     summary: Get one webhook
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Webhook }
 *       404: { description: Not found }
 */
webhooksRouter.get('/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const r = await query(
      `SELECT WebhookID, Title, Description, Url, JsonSchema, PayloadFormat, IsActive,
              CreatedBy, CreatedAt, UpdatedBy, UpdatedAt
         FROM core.Webhook WHERE WebhookID = @id`,
      { id: { type: sql.Int, value: id } },
    );

    const row = r.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Webhook not found' });
      return;
    }

    res.json(row);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/webhooks:
 *   post:
 *     tags: [Webhooks]
 *     summary: Create a webhook
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Created }
 *       422: { description: Invalid input or schema }
 */
webhooksRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const parsed = webhookWrite.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid webhook',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const schemaError = validateSchema(parsed.data.jsonSchema);
    if (schemaError) {
      res.status(422).json({
        error: 'validation_failed',
        message: schemaError,
        details: [{ path: 'jsonSchema', message: schemaError }],
      });
      return;
    }

    const d = parsed.data;
    const created = await query<{ id: number }>(
      `INSERT INTO core.Webhook (Title, Description, Url, JsonSchema, PayloadFormat, IsActive, Secret, CreatedBy, UpdatedBy)
       OUTPUT INSERTED.WebhookID AS id
       VALUES (@title, @desc, @url, @schema, @format, @active, @secret, @by, @by)`,
      {
        title: { type: sql.NVarChar(200), value: d.title },
        desc: { type: sql.NVarChar(1000), value: d.description ?? null },
        url: { type: sql.NVarChar(2000), value: d.url },
        schema: { type: sql.NVarChar(sql.MAX), value: d.jsonSchema ?? null },
        format: { type: sql.NVarChar(20), value: d.payloadFormat ?? 'json' },
        active: { type: sql.Bit, value: d.isActive === false ? 0 : 1 },
        secret: { type: sql.NVarChar(200), value: d.secret ?? null },
        by: { type: sql.NVarChar(200), value: req.user?.email ?? null },
      },
    );

    res.status(201).json({ webhookId: created.recordset[0]!.id });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/webhooks/{id}:
 *   patch:
 *     tags: [Webhooks]
 *     summary: Update a webhook
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated }
 */
webhooksRouter.patch(
  '/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const parsed = webhookWrite.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid webhook',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const d = parsed.data;

      if (d.jsonSchema !== undefined) {
        const schemaError = validateSchema(d.jsonSchema);
        if (schemaError) {
          res.status(422).json({
            error: 'validation_failed',
            message: schemaError,
            details: [{ path: 'jsonSchema', message: schemaError }],
          });
          return;
        }
      }

      const sets: string[] = [];
      const params: Record<string, SqlParam> = { id: { type: sql.Int, value: id } };

      const map: [keyof typeof d, string, number][] = [
        ['title', 'Title', 200],
        ['description', 'Description', 1000],
        ['url', 'Url', 2000],
        ['secret', 'Secret', 200],
      ];
      for (const [key, column, len] of map) {
        if (d[key] !== undefined) {
          sets.push(`${column} = @${key}`);
          params[key] = { type: sql.NVarChar(len), value: d[key] as string | null };
        }
      }
      if (d.jsonSchema !== undefined) {
        sets.push('JsonSchema = @schema');
        params.schema = { type: sql.NVarChar(sql.MAX), value: d.jsonSchema };
      }
      if (d.payloadFormat !== undefined) {
        sets.push('PayloadFormat = @format');
        params.format = { type: sql.NVarChar(20), value: d.payloadFormat };
      }
      if (d.isActive !== undefined) {
        sets.push('IsActive = @active');
        params.active = { type: sql.Bit, value: d.isActive ? 1 : 0 };
      }

      if (sets.length === 0) {
        res.status(400).json({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }

      sets.push('UpdatedBy = @by', 'UpdatedAt = SYSUTCDATETIME()');
      params.by = { type: sql.NVarChar(200), value: req.user?.email ?? null };

      const updated = await query<{ id: number }>(
        `UPDATE core.Webhook SET ${sets.join(', ')}
         OUTPUT INSERTED.WebhookID AS id
         WHERE WebhookID = @id`,
        params,
      );

      if (updated.recordset.length === 0) {
        res.status(404).json({ error: 'not_found', message: 'Webhook not found' });
        return;
      }

      res.json({ webhookId: id });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/webhooks/{id}:
 *   delete:
 *     tags: [Webhooks]
 *     summary: Delete a webhook and its delivery history
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Deleted }
 */
webhooksRouter.delete(
  '/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const r = await query(
        'DELETE FROM core.Webhook OUTPUT DELETED.WebhookID WHERE WebhookID = @id',
        { id: { type: sql.Int, value: id } },
      );

      if (r.recordset.length === 0) {
        res.status(404).json({ error: 'not_found', message: 'Webhook not found' });
        return;
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------ */
/*  Test send                                                          */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/webhooks/{id}/test:
 *   post:
 *     tags: [Webhooks]
 *     summary: Send a test payload
 *     description: >
 *       Builds a sample payload from the webhook's JSON Schema and POSTs it,
 *       so staff can confirm the endpoint accepts the shape before relying on
 *       it. The attempt is recorded either way.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Attempt result }
 */
webhooksRouter.post(
  '/:id/test',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const r = await query<{
        WebhookID: number;
        Url: string;
        JsonSchema: string | null;
        PayloadFormat: string;
        Secret: string | null;
      }>(
        'SELECT WebhookID, Url, JsonSchema, PayloadFormat, Secret FROM core.Webhook WHERE WebhookID = @id',
        { id: { type: sql.Int, value: id } },
      );

      const hook = r.recordset[0];
      if (!hook) {
        res.status(404).json({ error: 'not_found', message: 'Webhook not found' });
        return;
      }

      const format = hook.PayloadFormat === 'slack' ? 'slack' : 'json';
      const payload = buildPayload(format, 'test', sampleFromSchema(hook.JsonSchema));

      const result = await postWebhook(hook.Url, payload, hook.Secret);

      await recordDelivery({
        webhookId: id,
        eventKind: 'test',
        payload: JSON.stringify(payload),
        statusCode: result.statusCode,
        succeeded: result.ok,
        error: result.error,
        durationMs: result.durationMs,
      });

      res.json({
        succeeded: result.ok,
        statusCode: result.statusCode,
        error: result.error,
        durationMs: result.durationMs,
        payload,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/webhooks/{id}/deliveries:
 *   get:
 *     tags: [Webhooks]
 *     summary: Recent delivery attempts
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Deliveries }
 */
webhooksRouter.get(
  '/:id/deliveries',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const r = await query(
        `SELECT TOP 25 WebhookDeliveryID, EventKind, StatusCode, Succeeded, Error, DurationMs, AttemptedAt
           FROM core.WebhookDelivery
          WHERE WebhookID = @id
          ORDER BY AttemptedAt DESC`,
        { id: { type: sql.Int, value: id } },
      );

      res.json({ data: r.recordset });
    } catch (err) {
      next(err);
    }
  },
);
