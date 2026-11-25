import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { renderPdf, PdfUnavailableError } from '../services/pdf.js';
import {
  DEFAULT_PRINT_SETUP,
  SECTION_ORDER,
  buildSections,
  formatPacketDate,
  isPacketSectionKind,
  renderPacketHtml,
  tidyTime,
  type PacketRenderInput,
} from '../services/folder-packet.js';
import type {
  PacketDetail,
  PacketPrintSetup,
  PacketRosterRow,
  PacketSectionKind,
  PacketWorkshop,
  PacketWorkshopOption,
} from '@pe/shared';

/**
 * Folder builder.
 *
 * Staff assemble one folder per workshop: a roster, a blank roster for
 * walk-ins, an attendance slip, evaluations, a contact list, a banner and a
 * codification sheet. This router serves the picker, the packet contents and
 * the rendered pages.
 *
 * The packet is a *view* of data that already exists. Nothing here writes to
 * the database — a folder is printed, not saved — so the whole feature is
 * read-only and safe for any signed-in role.
 */

export const foldersRouter = Router();

/**
 * Lets a token arrive as `?token=` for the preview route.
 *
 * The preview is loaded into an iframe, and an iframe cannot set an
 * Authorization header. The token is the same one the app already holds; it
 * is promoted to the header form here so `requireAuth` stays the single
 * place that validates it. Scoped to this router, and only these read-only
 * routes are mounted on it.
 */
foldersRouter.use((req, _res, next) => {
  if (!req.headers.authorization && typeof req.query.token === 'string' && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

/** The sections a brand-new folder gets, matching how staff build one by hand. */
const DEFAULT_SECTIONS: PacketSectionKind[] = [...SECTION_ORDER];

const sectionParam = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined || value.trim() === ''
      ? DEFAULT_SECTIONS
      : value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
  )
  .pipe(
    z
      .array(z.string())
      .transform((list) => list.filter(isPacketSectionKind))
      .pipe(z.array(z.enum(SECTION_ORDER as [PacketSectionKind, ...PacketSectionKind[]]))),
  );

const setupSchema = z.object({
  paper: z.enum(['Letter', 'Legal']).default(DEFAULT_PRINT_SETUP.paper),
  orientation: z.enum(['Portrait', 'Landscape']).default(DEFAULT_PRINT_SETUP.orientation),
  margin: z.coerce.number().min(0.25).max(1.5).default(DEFAULT_PRINT_SETUP.margin),
  copies: z.coerce.number().int().min(1).max(20).default(DEFAULT_PRINT_SETUP.copies),
});

function parseSetup(raw: Record<string, unknown>): PacketPrintSetup {
  const parsed = setupSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_PRINT_SETUP };
}

/* ------------------------------------------------------------------ */
/*  Picker                                                             */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/folders/workshops:
 *   get:
 *     tags: [Folders]
 *     summary: Workshops available to build a folder for
 *     description: >
 *       Newest first. `q` matches the workshop code or name, which is how
 *       staff find a folder — they know the code on the printed sheet.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, default: 50 } }
 *     responses:
 *       200: { description: Workshop options }
 */
foldersRouter.get('/workshops', requireAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limitParsed = z.coerce.number().int().min(1).max(200).safeParse(req.query.limit);
    const limit = limitParsed.success ? limitParsed.data : 50;

    const params: Record<string, SqlParam> = {
      take: { type: sql.Int, value: limit },
    };
    let where = '';
    if (q !== '') {
      where = `AND (w.WorkshopCode LIKE @q OR n.WorkshopName LIKE @q)`;
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }

    const rows = await query<PacketWorkshopOption>(
      `SELECT TOP (@take) w.WorkshopID AS workshopId,
              w.WorkshopCode AS workshopCode,
              ISNULL(n.WorkshopName, 'Untitled workshop') AS workshopName,
              CONVERT(NVARCHAR(10), w.StartDate, 23) AS startDate,
              sy.SchoolYear AS schoolYear,
              (SELECT COUNT(*) FROM core.Registration r
                WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS participantCount,
              w.IsFolder AS isFolder,
              w.IsBrochure AS isBrochure,
              w.IsLabel AS isLabel
         FROM core.Workshop w
         LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
         LEFT JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
        WHERE n.WorkshopName IS NOT NULL ${where}
        ORDER BY w.StartDate DESC, w.WorkshopID DESC`,
      params,
    );

    res.json({ rows: rows.recordset });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Packet data                                                        */
/* ------------------------------------------------------------------ */

interface WorkshopRow {
  WorkshopID: number;
  WorkshopCode: string | null;
  WorkshopName: string | null;
  StartDate: string | null;
  DatesText: string | null;
  TimesText: string | null;
  Room: number | null;
  SchoolYear: string | null;
  Notes: string | null;
}

async function loadWorkshop(workshopId: number): Promise<WorkshopRow | null> {
  const r = await query<WorkshopRow>(
    `SELECT w.WorkshopID, w.WorkshopCode, n.WorkshopName,
            CONVERT(NVARCHAR(10), w.StartDate, 23) AS StartDate,
            w.DatesText, w.TimesText, w.Room,
            sy.SchoolYear, w.Notes
       FROM core.Workshop w
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
       LEFT JOIN ref.SchoolYear sy ON sy.SchoolYearID = w.SchoolYearID
      WHERE w.WorkshopID = @id`,
    { id: { type: sql.Int, value: workshopId } },
  );
  return r.recordset[0] ?? null;
}

async function loadRoster(workshopId: number): Promise<PacketRosterRow[]> {
  const r = await query<{
    FirstName: string | null;
    LastName: string | null;
    Email: string | null;
    AgencyName: string | null;
    CreditCode: string | null;
    Attended: boolean | null;
  }>(
    `SELECT p.FirstName, p.LastName, p.Email, a.AgencyName, ct.CreditCode, r.Attended
       FROM core.Registration r
       JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
       LEFT JOIN core.Agency a ON a.AgencyID = p.AgencyID
       LEFT JOIN ref.CreditType ct ON ct.CreditTypeID = r.CreditTypeID
      WHERE r.WorkshopID = @id AND r.IsCancelled = 0
      ORDER BY p.LastName, p.FirstName`,
    { id: { type: sql.Int, value: workshopId } },
  );

  return r.recordset.map((row, i) => ({
    index: i + 1,
    name: `${row.LastName ?? ''}, ${row.FirstName ?? ''}`.replace(/^, |, $/g, '').trim() || 'Unnamed participant',
    agency: row.AgencyName,
    email: row.Email,
    credit: row.CreditCode,
    attended: row.Attended,
  }));
}

async function loadPresenters(workshopId: number): Promise<string[]> {
  const r = await query<{ FirstName: string | null; LastName: string | null }>(
    `SELECT ps.FirstName, ps.LastName
       FROM core.WorkshopPresenter wp
       JOIN core.PresenterStaff ps ON ps.PresenterStaffID = wp.PresenterID
      WHERE wp.WorkshopID = @id
      ORDER BY ps.LastName, ps.FirstName`,
    { id: { type: sql.Int, value: workshopId } },
  );
  return r.recordset
    .map((p) => `${p.FirstName ?? ''} ${p.LastName ?? ''}`.trim())
    .filter((name) => name !== '');
}

/**
 * Assembles everything the packet needs.
 *
 * Shared by the JSON endpoint, the HTML preview and the PDF so the three can
 * never describe different folders.
 */
async function buildPacket(
  workshopId: number,
  sections: PacketSectionKind[],
  setup: PacketPrintSetup,
): Promise<PacketRenderInput | null> {
  const workshop = await loadWorkshop(workshopId);
  if (!workshop) return null;

  const [roster, presenters] = await Promise.all([
    loadRoster(workshopId),
    loadPresenters(workshopId),
  ]);

  const packetWorkshop: PacketWorkshop = {
    workshopId: workshop.WorkshopID,
    workshopCode: workshop.WorkshopCode,
    workshopName: workshop.WorkshopName ?? 'Untitled workshop',
    schoolYear: workshop.SchoolYear,
    dateText: formatPacketDate(workshop.StartDate, workshop.DatesText),
    timeText: tidyTime(workshop.TimesText),
    room: workshop.Room === null ? null : String(workshop.Room),
    presenterNames: presenters,
    participantCount: roster.length,
    rosterEmpty: roster.length === 0,
  };

  const builtSections = buildSections(sections, {
    participantCount: roster.length,
    rosterEmpty: roster.length === 0,
    hasNotes: (workshop.Notes ?? '').trim() !== '',
  });

  const detail: PacketDetail = {
    workshop: packetWorkshop,
    sections: builtSections,
    roster,
    printSetup: setup,
    pageCount: builtSections.reduce((n, s) => n + (s.endPage - s.startPage + 1), 0),
    warnings: builtSections.filter((s) => !s.filled && s.note).map((s) => `${s.label}: ${s.note}`),
  };

  return { detail, sections, notes: workshop.Notes };
}

/**
 * @openapi
 * /api/folders/workshops/{id}/packet:
 *   get:
 *     tags: [Folders]
 *     summary: Packet contents and roster for one workshop
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: query, name: sections, schema: { type: string } }
 *     responses:
 *       200: { description: Packet detail }
 *       404: { description: Not found }
 */
foldersRouter.get('/workshops/:id/packet', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid workshop id.' });
      return;
    }

    const parsedSections = sectionParam.safeParse(req.query.sections);
    const sections = parsedSections.success ? parsedSections.data : DEFAULT_SECTIONS;
    const setup = parseSetup(req.query as Record<string, unknown>);

    const packet = await buildPacket(id, sections, setup);
    if (!packet) {
      res.status(404).json({ error: 'not_found', message: 'No such workshop.' });
      return;
    }

    res.json(packet.detail);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/folders/workshops/{id}/preview:
 *   get:
 *     tags: [Folders]
 *     summary: The packet as printable HTML, for the on-screen preview
 *     description: >
 *       The same document the PDF is made from, so the preview cannot show
 *       something different from what prints.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: HTML }
 *       404: { description: Not found }
 */
foldersRouter.get('/workshops/:id/preview', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid workshop id.' });
      return;
    }

    const parsedSections = sectionParam.safeParse(req.query.sections);
    const sections = parsedSections.success ? parsedSections.data : DEFAULT_SECTIONS;
    const setup = parseSetup(req.query as Record<string, unknown>);

    const packet = await buildPacket(id, sections, setup);
    if (!packet) {
      res.status(404).json({ error: 'not_found', message: 'No such workshop.' });
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPacketHtml(packet, true));
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/folders/workshops/{id}/pdf:
 *   get:
 *     tags: [Folders]
 *     summary: Download the packet as a PDF
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: PDF }
 *       404: { description: Not found }
 *       503: { description: No browser available for PDF rendering }
 */
foldersRouter.get('/workshops/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid workshop id.' });
      return;
    }

    const parsedSections = sectionParam.safeParse(req.query.sections);
    const sections = parsedSections.success ? parsedSections.data : DEFAULT_SECTIONS;
    const setup = parseSetup(req.query as Record<string, unknown>);

    const packet = await buildPacket(id, sections, setup);
    if (!packet) {
      res.status(404).json({ error: 'not_found', message: 'No such workshop.' });
      return;
    }

    const pdf = await renderPdf(renderPacketHtml(packet, false));
    const code = (packet.detail.workshop.workshopCode ?? 'packet').replace(/[^A-Za-z0-9]+/g, '-');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${code}-packet.pdf"`);
    res.send(pdf);
  } catch (err) {
    if (err instanceof PdfUnavailableError) {
      res.status(503).json({ error: 'pdf_unavailable', message: err.message });
      return;
    }
    next(err);
  }
});
