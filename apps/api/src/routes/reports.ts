import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { query } from '../db.js';
import { renderPdf, PdfUnavailableError } from '../services/pdf.js';
import {
  REPORTS,
  REPORT_BY_KEY,
  FINANCIAL_LINKS,
  type ReportDefinition,
  type ReportParams,
  type ReportRow,
} from '../services/reports.js';
import { CHARTS } from '../services/charts.js';
import {
  DATE_TOKENS,
  create,
  getForUser,
  listForUser,
  remove,
  update,
} from '../services/report-subscriptions.js';
import { sendSubscription, workspaceNow } from '../services/report-scheduler.js';

export const reportsRouter = Router();

/** On-screen rows are capped so a wide date range cannot hang the browser. */
const SCREEN_ROW_LIMIT = 5000;

const paramsSchema = z.object({
  schoolYearId: z.coerce.number().int().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  categoryId: z.coerce.number().int().optional(),
  workshopId: z.coerce.number().int().optional(),
});

function parseParams(query: unknown): { ok: true; params: ReportParams } | { ok: false; message: string } {
  const parsed = paramsSchema.safeParse(query);
  if (!parsed.success) {
    return { ok: false, message: 'Invalid report parameters' };
  }
  return { ok: true, params: parsed.data };
}

/* ------------------------------------------------------------------ */
/*  Catalogue                                                          */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/reports:
 *   get:
 *     tags: [Reports]
 *     summary: Report catalogue
 *     description: >
 *       Every report the hub can run, with its parameters and columns.
 *       Financial reports are returned as links to the Payments screen
 *       rather than definitions, because duplicating them would create a
 *       second source of truth for money.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Catalogue }
 */
reportsRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    // Defaulting to the newest school year is wrong: 2026-27 is the upcoming
    // year with no attendance, and 2025-26 has one attended registration but
    // no evaluations. Each report reports the newest year it can produce rows
    // for, so opening a report lands on data rather than an empty table.
    const defaults = await Promise.all(
      REPORTS.map(async (r) => [r.key, r.latestSchoolYear ? await r.latestSchoolYear() : null] as const),
    );

    res.json({
      data: REPORTS.map((r) => ({
        key: r.key,
        title: r.title,
        description: r.description,
        group: r.group,
        replaces: r.replaces,
        parameters: r.parameters,
        columns: r.columns,
      })),
      links: FINANCIAL_LINKS,
      defaultSchoolYearByReport: Object.fromEntries(defaults),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Running a report                                                   */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/reports/{key}:
 *   get:
 *     tags: [Reports]
 *     summary: Run a report
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *       - { in: query, name: schoolYearId, schema: { type: integer } }
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Rows }
 *       404: { description: Unknown report }
 */
/* ------------------------------------------------------------------ */
/*  Scheduled subscriptions                                            */
/* ------------------------------------------------------------------ */

/*
 * These must be registered ABOVE `/:key`, or a request for
 * `/api/reports/subscriptions` would match the report runner and answer
 * "No such report" — the same trap `/charts/:key` avoids by being declared
 * earlier.
 */

const subscriptionSchema = z.object({
  reportKey: z.string().min(1).max(60),
  params: z
    .object({
      schoolYearId: z.union([z.number().int().positive(), z.literal('current')]).optional(),
      from: z.enum(DATE_TOKENS).optional(),
      to: z.enum(DATE_TOKENS).optional(),
      categoryId: z.number().int().positive().optional(),
      workshopId: z.number().int().positive().optional(),
    })
    .default({}),
  dayOfWeek: z.number().int().min(0).max(6).default(5),
  sendHour: z.number().int().min(0).max(23).default(7),
});

const subscriptionPatch = z.object({
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  sendHour: z.number().int().min(0).max(23).optional(),
  isActive: z.boolean().optional(),
});

/**
 * @openapi
 * /api/reports/subscriptions:
 *   get:
 *     tags: [Reports]
 *     summary: My report subscriptions
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Subscriptions, newest first }
 *   post:
 *     tags: [Reports]
 *     summary: Subscribe to a report
 *     description: >
 *       Subscribing again with the same report and parameters updates the
 *       day rather than creating a second email.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Subscription }
 *       404: { description: Unknown report }
 */
reportsRouter.get('/subscriptions', requireAuth, async (req, res, next) => {
  try {
    res.json({ data: await listForUser(req.user!.userId) });
  } catch (err) {
    next(err);
  }
});

reportsRouter.post('/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const parsed = subscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: parsed.error.issues[0]?.message ?? 'Invalid subscription',
      });
      return;
    }

    const def = REPORT_BY_KEY.get(parsed.data.reportKey);
    if (!def) {
      res.status(404).json({ error: 'not_found', message: 'No such report' });
      return;
    }

    const id = await create({
      userId: req.user!.userId,
      reportKey: parsed.data.reportKey,
      params: parsed.data.params,
      dayOfWeek: parsed.data.dayOfWeek,
      sendHour: parsed.data.sendHour,
      createdBy: req.user!.email,
    });

    res.status(201).json(await getForUser(id, req.user!.userId));
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/reports/subscriptions/{id}:
 *   patch:
 *     tags: [Reports]
 *     summary: Change the day, hour, or active flag
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated }
 *       404: { description: Not found, or not yours }
 *   delete:
 *     tags: [Reports]
 *     summary: Unsubscribe
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Removed }
 */
reportsRouter.patch('/subscriptions/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const parsed = subscriptionPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'Invalid change' });
      return;
    }

    const ok = await update(id, req.user!.userId, parsed.data);
    if (!ok) {
      res.status(404).json({ error: 'not_found', message: 'Subscription not found' });
      return;
    }
    res.json(await getForUser(id, req.user!.userId));
  } catch (err) {
    next(err);
  }
});

reportsRouter.delete('/subscriptions/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }
    const ok = await remove(id, req.user!.userId);
    if (!ok) {
      res.status(404).json({ error: 'not_found', message: 'Subscription not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/reports/subscriptions/{id}/send-now:
 *   post:
 *     tags: [Reports]
 *     summary: Send this subscription once, now
 *     description: >
 *       The test button. Without it a staff member has to wait until Friday
 *       to find out whether they configured it correctly.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: What happened }
 *       404: { description: Not found, or not yours }
 */
reportsRouter.post('/subscriptions/:id/send-now', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
      return;
    }

    const sub = await getForUser(id, req.user!.userId);
    if (!sub) {
      res.status(404).json({ error: 'not_found', message: 'Subscription not found' });
      return;
    }

    const result = await sendSubscription(sub, workspaceNow());
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Visual reports                                                     */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/reports/charts/{key}:
 *   get:
 *     tags: [Reports]
 *     summary: Aggregate behind one Visual Reports chart
 *     description: >
 *       Returns the chart-ready series for one chart, with a note explaining
 *       anything a viewer would otherwise misread (registrations rather than
 *       people, revenue including refunds).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *       - { in: query, name: schoolYearId, schema: { type: integer } }
 *     responses:
 *       200: { description: Chart series }
 *       404: { description: Unknown chart }
 */
reportsRouter.get('/charts/:key', requireAuth, async (req, res, next) => {
  try {
    const chart = CHARTS[String(req.params.key)];
    if (!chart) {
      res.status(404).json({ error: 'not_found', message: 'No such chart' });
      return;
    }

    const parsed = z
      .object({ schoolYearId: z.coerce.number().int().optional() })
      .safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'Invalid schoolYearId' });
      return;
    }

    const series = await chart.run(parsed.data.schoolYearId ?? null);
    res.json(series);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  One report                                                         */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/reports/:key:
 *   get:
 *     tags: [Reports]
 *     summary: Run a report
 *     description: >
 *       Returns the report's rows. Screen output is capped at 5,000 rows;
 *       the PDF path is uncapped.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *       - { in: query, name: schoolYearId, schema: { type: integer } }
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Rows }
 *       404: { description: Unknown report }
 */
reportsRouter.get('/:key', requireAuth, async (req, res, next) => {
  try {
    const def = REPORT_BY_KEY.get(String(req.params.key));
    if (!def) {
      res.status(404).json({ error: 'not_found', message: 'No such report' });
      return;
    }

    const parsed = parseParams(req.query);
    if (!parsed.ok) {
      res.status(422).json({ error: 'validation_failed', message: parsed.message });
      return;
    }

    const rows = await def.run(parsed.params);
    const truncated = rows.length > SCREEN_ROW_LIMIT;

    res.json({
      key: def.key,
      title: def.title,
      columns: def.columns,
      parameters: parsed.params,
      data: truncated ? rows.slice(0, SCREEN_ROW_LIMIT) : rows,
      total: rows.length,
      truncated,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  PDF                                                                */
/* ------------------------------------------------------------------ */

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The PDF is generated from the same rows the screen shows, so the two can
 * never disagree.
 */
function renderReportHtml(
  def: ReportDefinition,
  rows: ReportRow[],
  params: ReportParams,
  parameterLabels: string[],
): string {
  const head = def.columns
    .map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${esc(c.label)}</th>`)
    .join('');

  const body = rows
    .map(
      (row) =>
        `<tr>${def.columns
          .map((c) => `<td class="${c.align === 'right' ? 'num' : ''}">${esc(row[c.key])}</td>`)
          .join('')}</tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(def.title)}</title>
<style>
  @page { size: letter landscape; margin: 0.5in; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Open Sans', 'Segoe UI', Arial, sans-serif;
    color: #212121; margin: 0; font-size: 9pt;
  }
  header { border-bottom: 2px solid #0C5488; padding-bottom: 8px; margin-bottom: 12px; }
  h1 { font-size: 16pt; color: #0C5488; margin: 0 0 2px; }
  .meta { font-size: 8pt; color: #5E8EB0; }
  .params { font-size: 8.5pt; color: #212121; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 7.5pt; letter-spacing: .04em;
    text-transform: uppercase; color: #0C5488;
    border-bottom: 1px solid #0C5488; padding: 5px 6px;
  }
  td { padding: 4px 6px; border-bottom: 1px solid #eef0f2; vertical-align: top; }
  tbody tr:nth-child(even) { background: #fafbfc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { text-align: center; color: #6b7780; padding: 40px; }
  footer {
    margin-top: 14px; padding-top: 6px; border-top: 1px solid #eef0f2;
    font-size: 7.5pt; color: #8a8a8a;
  }
</style>
</head>
<body>
<header>
  <h1>${esc(def.title)}</h1>
  <div class="meta">Project Enlightenment · Wake County Public School System</div>
  <div class="params">${esc(parameterLabels.join(' · '))}</div>
</header>
${
  rows.length === 0
    ? `<div class="empty">No rows matched these parameters.</div>`
    : `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}
<footer>${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} · generated ${new Date().toLocaleString('en-US')}</footer>
</body>
</html>`;
}

/**
 * @openapi
 * /api/reports/{key}/pdf:
 *   get:
 *     tags: [Reports]
 *     summary: Run a report and download it as PDF
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: PDF }
 *       404: { description: Unknown report }
 */
reportsRouter.get('/:key/pdf', requireAuth, async (req, res, next) => {
  try {
    const def = REPORT_BY_KEY.get(String(req.params.key));
    if (!def) {
      res.status(404).json({ error: 'not_found', message: 'No such report' });
      return;
    }

    const parsed = parseParams(req.query);
    if (!parsed.ok) {
      res.status(422).json({ error: 'validation_failed', message: parsed.message });
      return;
    }

    // The PDF is uncapped: a printed report is the point of running it.
    const rows = await def.run(parsed.params);

    const labels: string[] = [];
    if (parsed.params.schoolYearId) labels.push(`School year ID ${parsed.params.schoolYearId}`);
    if (parsed.params.from) labels.push(`From ${parsed.params.from}`);
    if (parsed.params.to) labels.push(`To ${parsed.params.to}`);
    if (labels.length === 0) labels.push('All dates');

    const html = renderReportHtml(def, rows, parsed.params, labels);
    const pdf = await renderPdf(html);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${def.key}.pdf"`);
    res.send(pdf);
  } catch (err) {
    if (err instanceof PdfUnavailableError) {
      res.status(503).json({ error: 'pdf_unavailable', message: err.message });
      return;
    }
    next(err);
  }
});
