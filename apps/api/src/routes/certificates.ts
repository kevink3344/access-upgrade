import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { renderPdf, findBrowser, PdfUnavailableError } from '../services/pdf.js';
import {
  renderCertificateHtml,
  DEFAULT_VISIBLE_FIELDS,
  type CertificateModel,
  type CertificateFieldVisibility,
} from '../services/certificate-template.js';
import crypto from 'node:crypto';

export const certificatesRouter = Router();

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

const certType = z.enum(['CEU', 'CHC']);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Legacy field keys used by the ETL seed, mapped to the canonical names.
 * `["...","school","participantFlags"]` and `{agency, roleFlags}` mean the
 * same thing; accepting both avoids a data migration for a cosmetic rename.
 */
const FIELD_ALIASES: Record<string, keyof CertificateFieldVisibility> = {
  school: 'agency',
  participantFlags: 'roleFlags',
};

/**
 * `VisibleFields` is stored as a JSON **array** of field keys (the ETL seeded
 * it that way, and it is the more compact form). Older rows may also be an
 * object of booleans, so accept both and normalise to the object shape the
 * template renderer expects.
 */
function parseVisibleFields(raw: string | null): CertificateFieldVisibility {
  if (!raw) return { ...DEFAULT_VISIBLE_FIELDS };
  try {
    const parsed: unknown = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      const enabled = new Set(
        parsed.map((k) => FIELD_ALIASES[String(k)] ?? String(k)),
      );
      const out = { ...DEFAULT_VISIBLE_FIELDS };
      for (const key of Object.keys(out) as (keyof CertificateFieldVisibility)[]) {
        out[key] = enabled.has(key);
      }
      return out;
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const out = { ...DEFAULT_VISIBLE_FIELDS };
      for (const [rawKey, value] of Object.entries(obj)) {
        const key = (FIELD_ALIASES[rawKey] ?? rawKey) as keyof CertificateFieldVisibility;
        if (key in out && typeof value === 'boolean') out[key] = value;
      }
      return out;
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_VISIBLE_FIELDS };
}

function toDataUri(content: Buffer, contentType: string): string {
  return `data:${contentType};base64,${content.toString('base64')}`;
}

/**
 * Decodes a `data:` URI or raw base64 body into bytes and validates it.
 * Kept deliberately strict: the only images this endpoint accepts are ones a
 * staff member just picked in the browser.
 */
function decodeImage(body: { data: string; contentType: string; fileName?: string }) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(body.data);
  const contentType = m ? m[1]! : body.contentType;
  const b64 = m ? m[2]! : body.data;

  if (!ALLOWED_TYPES.includes(contentType)) {
    return { error: `Unsupported image type. Use PNG, JPEG, SVG or WebP.` } as const;
  }

  let content: Buffer;
  try {
    content = Buffer.from(b64, 'base64');
  } catch {
    return { error: 'Image data is not valid base64' } as const;
  }

  if (content.length === 0) return { error: 'Image is empty' } as const;
  if (content.length > MAX_UPLOAD_BYTES) {
    return { error: 'Image is larger than 2 MB' } as const;
  }

  return {
    content,
    contentType,
    fileName: body.fileName ?? null,
    sha256: crypto.createHash('sha256').update(content).digest(),
  } as const;
}

async function storeAsset(
  asset: { content: Buffer; contentType: string; fileName: string | null; sha256: Buffer },
  kind: 'template-logo' | 'participant-image',
  uploadedBy: string | null,
): Promise<number> {
  // Reuse an identical image rather than storing the same bytes twice.
  const existing = await query<{ id: number }>(
    `SELECT TOP 1 CertificateAssetID AS id FROM core.CertificateAsset
      WHERE Sha256 = @sha AND AssetKind = @kind`,
    { sha: { type: sql.VarBinary(32), value: asset.sha256 }, kind: { type: sql.NVarChar(30), value: kind } },
  );
  if (existing.recordset[0]) return existing.recordset[0].id;

  const result = await query<{ id: number }>(
    `INSERT INTO core.CertificateAsset
       (AssetKind, FileName, ContentType, ByteSize, Sha256, Content, UploadedBy)
     OUTPUT INSERTED.CertificateAssetID AS id
     VALUES (@kind, @name, @type, @size, @sha, @content, @by)`,
    {
      kind: { type: sql.NVarChar(30), value: kind },
      name: { type: sql.NVarChar(260), value: asset.fileName },
      type: { type: sql.NVarChar(100), value: asset.contentType },
      size: { type: sql.Int, value: asset.content.length },
      sha: { type: sql.VarBinary(32), value: asset.sha256 },
      content: { type: sql.VarBinary(sql.MAX), value: asset.content },
      by: { type: sql.NVarChar(200), value: uploadedBy },
    },
  );
  return result.recordset[0]!.id;
}

async function loadAssetDataUri(assetId: number | null): Promise<string | null> {
  if (!assetId) return null;
  const r = await query<{ Content: Buffer; ContentType: string }>(
    `SELECT Content, ContentType FROM core.CertificateAsset WHERE CertificateAssetID = @id`,
    { id: { type: sql.Int, value: assetId } },
  );
  const row = r.recordset[0];
  return row ? toDataUri(row.Content, row.ContentType) : null;
}

/* ------------------------------------------------------------------ */
/*  Templates                                                          */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/certificates/templates:
 *   get:
 *     tags: [Certificates]
 *     summary: Certificate templates for a school year
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: schoolYearId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Templates }
 */
certificatesRouter.get('/templates', requireAuth, async (req, res, next) => {
  try {
    const parsed = z.object({ schoolYearId: z.coerce.number().int() }).safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'schoolYearId is required' });
      return;
    }

    const r = await query(
      `SELECT t.*, sy.SchoolYear
         FROM core.CertificateTemplate t
         JOIN ref.SchoolYear sy ON sy.SchoolYearID = t.SchoolYearID
        WHERE t.SchoolYearID = @sy
        ORDER BY t.CertificateType`,
      { sy: { type: sql.Int, value: parsed.data.schoolYearId } },
    );

    res.json({
      data: r.recordset.map((row) => {
        const r2 = row as Record<string, unknown>;
        return {
          ...r2,
          VisibleFields: parseVisibleFields(r2.VisibleFields as string | null),
          HasLogo: r2.LogoAssetID !== null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/certificates/templates/{id}:
 *   patch:
 *     tags: [Certificates]
 *     summary: Update a certificate template
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated }
 */
const templatePatch = z.object({
  title: z.string().max(200).nullable().optional(),
  subtitle: z.string().max(500).nullable().optional(),
  programDirectorName: z.string().max(100).nullable().optional(),
  programDirectorTitle: z.string().max(100).nullable().optional(),
  approvingDirectorName: z.string().max(100).nullable().optional(),
  approvingDirectorTitle: z.string().max(100).nullable().optional(),
  creditUnitLabel: z.string().max(100).nullable().optional(),
  footerText: z.string().max(500).nullable().optional(),
  visibleFields: z.record(z.boolean()).optional(),
});

certificatesRouter.patch(
  '/templates/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const parsed = templatePatch.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid template',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }

      const d = parsed.data;
      const sets: string[] = [];
      const params: Record<string, SqlParam> = { id: { type: sql.Int, value: id } };

      const map: [keyof typeof d, string, number][] = [
        ['title', 'Title', 200],
        ['subtitle', 'Subtitle', 500],
        ['programDirectorName', 'ProgramDirectorName', 100],
        ['programDirectorTitle', 'ProgramDirectorTitle', 100],
        ['approvingDirectorName', 'ApprovingDirectorName', 100],
        ['approvingDirectorTitle', 'ApprovingDirectorTitle', 100],
        ['creditUnitLabel', 'CreditUnitLabel', 100],
        ['footerText', 'FooterText', 500],
      ];

      for (const [key, column, len] of map) {
        if (d[key] !== undefined) {
          sets.push(`${column} = @${key}`);
          params[key] = { type: sql.NVarChar(len), value: d[key] as string | null };
        }
      }

      if (d.visibleFields !== undefined) {
        // Store the canonical object form. Reading accepts the legacy array
        // too, but writing one shape keeps future rows consistent.
        const canonical: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(d.visibleFields)) {
          if (typeof v === 'boolean') canonical[k] = v;
        }
        sets.push('VisibleFields = @vf');
        params.vf = { type: sql.NVarChar(sql.MAX), value: JSON.stringify(canonical) };
      }

      if (sets.length === 0) {
        res.status(400).json({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }

      sets.push('UpdatedBy = @by', 'UpdatedAt = SYSUTCDATETIME()');
      params.by = { type: sql.NVarChar(200), value: req.user?.email ?? null };

      const r = await query(
        `UPDATE core.CertificateTemplate SET ${sets.join(', ')}
         OUTPUT INSERTED.CertificateTemplateID
         WHERE CertificateTemplateID = @id`,
        params,
      );

      if (r.recordset.length === 0) {
        res.status(404).json({ error: 'not_found', message: 'Template not found' });
        return;
      }

      res.json({ certificateTemplateId: id });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/certificates/templates/{id}/logo:
 *   post:
 *     tags: [Certificates]
 *     summary: Upload a template logo
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Stored }
 */
certificatesRouter.post(
  '/templates/:id/logo',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const parsed = z
        .object({ data: z.string().min(1), contentType: z.string().min(1), fileName: z.string().optional() })
        .safeParse(req.body);

      if (!parsed.success) {
        res.status(422).json({ error: 'validation_failed', message: 'Image data is required' });
        return;
      }

      const decoded = decodeImage(parsed.data);
      if ('error' in decoded) {
        res.status(422).json({ error: 'validation_failed', message: decoded.error });
        return;
      }

      const assetId = await storeAsset(decoded, 'template-logo', req.user?.email ?? null);

      const r = await query(
        `UPDATE core.CertificateTemplate
            SET LogoAssetID = @asset, UpdatedBy = @by, UpdatedAt = SYSUTCDATETIME()
          OUTPUT INSERTED.CertificateTemplateID
          WHERE CertificateTemplateID = @id`,
        {
          asset: { type: sql.Int, value: assetId },
          by: { type: sql.NVarChar(200), value: req.user?.email ?? null },
          id: { type: sql.Int, value: id },
        },
      );

      if (r.recordset.length === 0) {
        res.status(404).json({ error: 'not_found', message: 'Template not found' });
        return;
      }

      res.json({ certificateTemplateId: id, logoAssetId: assetId });
    } catch (err) {
      next(err);
    }
  },
);

/** Logo bytes, served authenticated so certificate images are never public. */
certificatesRouter.get('/templates/:id/logo', requireAuth, async (req, res, next) => {
  try {
    const r = await query<{ Content: Buffer; ContentType: string }>(
      `SELECT a.Content, a.ContentType
         FROM core.CertificateTemplate t
         JOIN core.CertificateAsset a ON a.CertificateAssetID = t.LogoAssetID
        WHERE t.CertificateTemplateID = @id`,
      { id: { type: sql.Int, value: Number(req.params.id) } },
    );
    const row = r.recordset[0];
    if (!row) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', row.ContentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(row.Content);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Eligibility                                                        */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/certificates/eligible:
 *   get:
 *     tags: [Certificates]
 *     summary: Participants eligible for a certificate
 *     description: >
 *       Ports sqryCEUCertificates — attended, not cancelled, not late, and a
 *       workshop code starting with 't'.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Eligible participants }
 */
certificatesRouter.get('/eligible', requireAuth, async (req, res, next) => {
  try {
    const parsed = z
      .object({
        schoolYearId: z.coerce.number().int(),
        q: z.string().trim().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'schoolYearId is required',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { schoolYearId, q, page, pageSize } = parsed.data;
    const where = ['e.SchoolYearID = @sy'];
    const params: Record<string, SqlParam> = { sy: { type: sql.Int, value: schoolYearId } };

    if (q) {
      where.push('(e.FirstName LIKE @q OR e.LastName LIKE @q OR e.Email LIKE @q)');
      params.q = { type: sql.NVarChar(260), value: `%${q}%` };
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM core.vw_CertificateEligible e ${whereSql}`,
      params,
    );

    const rows = await query(
      `SELECT e.*,
              CASE WHEN i.CertificateIssueID IS NULL THEN 0 ELSE 1 END AS HasIssued
         FROM core.vw_CertificateEligible e
         OUTER APPLY (
           SELECT TOP 1 CertificateIssueID FROM core.CertificateIssue ci
            WHERE ci.ParticipantID = e.ParticipantID
              AND ci.SchoolYearID = e.SchoolYearID
              AND ci.SupersededAt IS NULL
         ) i
         ${whereSql}
        ORDER BY e.LastName, e.FirstName
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        ...params,
        offset: { type: sql.Int, value: (page - 1) * pageSize },
        limit: { type: sql.Int, value: pageSize },
      },
    );

    res.json({ data: rows.recordset, page, pageSize, total: total.recordset[0]?.n ?? 0 });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Per-participant overrides                                          */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/certificates/overrides/{participantId}:
 *   get:
 *     tags: [Certificates]
 *     summary: Per-participant certificate text and image
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Override or null }
 */
certificatesRouter.get('/overrides/:participantId', requireAuth, async (req, res, next) => {
  try {
    const parsed = z
      .object({ schoolYearId: z.coerce.number().int(), certificateType: certType })
      .safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'schoolYearId and certificateType are required' });
      return;
    }

    const r = await query(
      `SELECT o.CertificateOverrideID, o.CustomText, o.CustomTextLabel,
              o.ImageAssetID, o.ImageAltText, o.ImagePlacement, o.UpdatedAt,
              a.ContentType AS ImageContentType
         FROM core.CertificateOverride o
         LEFT JOIN core.CertificateAsset a ON a.CertificateAssetID = o.ImageAssetID
        WHERE o.ParticipantID = @pid AND o.SchoolYearID = @sy AND o.CertificateType = @type`,
      {
        pid: { type: sql.Int, value: Number(req.params.participantId) },
        sy: { type: sql.Int, value: parsed.data.schoolYearId },
        type: { type: sql.NVarChar(10), value: parsed.data.certificateType },
      },
    );

    res.json({ data: r.recordset[0] ?? null });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/certificates/overrides/{participantId}:
 *   put:
 *     tags: [Certificates]
 *     summary: Save per-participant certificate text and image
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Saved }
 */
certificatesRouter.put('/overrides/:participantId', requireAuth, async (req, res, next) => {
  try {
    const participantId = Number(req.params.participantId);
    if (!Number.isInteger(participantId)) {
      res.status(400).json({ error: 'bad_request', message: 'Invalid participant id' });
      return;
    }

    const parsed = z
      .object({
        schoolYearId: z.number().int(),
        certificateType: certType,
        customText: z.string().max(500).nullable().optional(),
        customTextLabel: z.string().max(100).nullable().optional(),
        imageAltText: z.string().max(200).nullable().optional(),
        imagePlacement: z.enum(['header', 'body', 'footer']).nullable().optional(),
        /** Full data URI, or null to remove the image. */
        imageData: z.string().nullable().optional(),
        imageContentType: z.string().optional(),
        imageFileName: z.string().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Invalid override',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const d = parsed.data;

    // An image without alt text is an accessibility defect. Refuse it here
    // with a clear message rather than letting the CHECK constraint fire.
    if (d.imageData && !(d.imageAltText && d.imageAltText.trim())) {
      res.status(422).json({
        error: 'validation_failed',
        message: 'Alt text is required when an image is attached',
        details: [{ path: 'imageAltText', message: 'Describe the image for screen readers' }],
      });
      return;
    }

    let imageAssetId: number | null = null;

    if (d.imageData) {
      const decoded = decodeImage({
        data: d.imageData,
        contentType: d.imageContentType ?? 'image/png',
        fileName: d.imageFileName,
      });
      if ('error' in decoded) {
        res.status(422).json({ error: 'validation_failed', message: decoded.error });
        return;
      }
      imageAssetId = await storeAsset(decoded, 'participant-image', req.user?.email ?? null);
    }

    await query(
      `MERGE core.CertificateOverride AS target
       USING (SELECT @pid AS ParticipantID, @sy AS SchoolYearID, @type AS CertificateType) AS src
          ON target.ParticipantID = src.ParticipantID
         AND target.SchoolYearID = src.SchoolYearID
         AND target.CertificateType = src.CertificateType
       WHEN MATCHED THEN UPDATE SET
            CustomText      = @text,
            CustomTextLabel = @label,
            ImageAssetID    = @asset,
            ImageAltText    = @alt,
            ImagePlacement  = @placement,
            UpdatedBy       = @by,
            UpdatedAt       = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT
            (ParticipantID, SchoolYearID, CertificateType, CustomText, CustomTextLabel,
             ImageAssetID, ImageAltText, ImagePlacement, UpdatedBy)
            VALUES (@pid, @sy, @type, @text, @label, @asset, @alt, @placement, @by);`,
      {
        pid: { type: sql.Int, value: participantId },
        sy: { type: sql.Int, value: d.schoolYearId },
        type: { type: sql.NVarChar(10), value: d.certificateType },
        text: { type: sql.NVarChar(500), value: d.customText ?? null },
        label: { type: sql.NVarChar(100), value: d.customTextLabel ?? null },
        asset: { type: sql.Int, value: imageAssetId },
        alt: { type: sql.NVarChar(200), value: d.imageAltText ?? null },
        placement: { type: sql.NVarChar(20), value: d.imagePlacement ?? 'body' },
        by: { type: sql.NVarChar(200), value: req.user?.email ?? null },
      },
    );

    res.json({ participantId, saved: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/*  Rendering                                                          */
/* ------------------------------------------------------------------ */

async function buildModel(
  participantId: number,
  schoolYearId: number,
  type: 'CEU' | 'CHC',
): Promise<CertificateModel | null> {
  const elig = await query<Record<string, unknown>>(
    `SELECT e.*, sy.SchoolYear
       FROM core.vw_CertificateEligible e
       JOIN ref.SchoolYear sy ON sy.SchoolYearID = e.SchoolYearID
      WHERE e.ParticipantID = @pid AND e.SchoolYearID = @sy`,
    { pid: { type: sql.Int, value: participantId }, sy: { type: sql.Int, value: schoolYearId } },
  );
  const e = elig.recordset[0];
  if (!e) return null;

  const tpl = await query<Record<string, unknown>>(
    `SELECT * FROM core.CertificateTemplate WHERE SchoolYearID = @sy AND CertificateType = @type`,
    { sy: { type: sql.Int, value: schoolYearId }, type: { type: sql.NVarChar(10), value: type } },
  );
  const t = tpl.recordset[0];
  if (!t) return null;

  const ovr = await query<Record<string, unknown>>(
    `SELECT * FROM core.CertificateOverride
      WHERE ParticipantID = @pid AND SchoolYearID = @sy AND CertificateType = @type`,
    {
      pid: { type: sql.Int, value: participantId },
      sy: { type: sql.Int, value: schoolYearId },
      type: { type: sql.NVarChar(10), value: type },
    },
  );
  const o = ovr.recordset[0];

  const workshops = await query<{ title: string | null; date: string | null; hours: number | null }>(
    `SELECT n.WorkshopName AS title,
            CONVERT(varchar(10), w.StartDate, 23) AS date,
            w.SessionHours AS hours
       FROM core.Registration r
       JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
      WHERE r.ParticipantID = @pid
        AND w.SchoolYearID = @sy
        AND r.Attended = 1 AND r.IsCancelled = 0 AND r.IsLate = 0
        AND w.WorkshopCode LIKE 't%'
      ORDER BY w.StartDate`,
    { pid: { type: sql.Int, value: participantId }, sy: { type: sql.Int, value: schoolYearId } },
  );

  const name = [e.FirstName, e.MiddleName, e.LastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  return {
    template: {
      title: (t.Title as string) ?? 'Certificate of Credit',
      subtitle: (t.Subtitle as string) ?? '',
      programDirectorName: (t.ProgramDirectorName as string) ?? null,
      programDirectorTitle: (t.ProgramDirectorTitle as string) ?? null,
      approvingDirectorName: (t.ApprovingDirectorName as string) ?? null,
      approvingDirectorTitle: (t.ApprovingDirectorTitle as string) ?? null,
      creditUnitLabel: (t.CreditUnitLabel as string) ?? 'Unit(s) of Renewal Credit',
      footerText: (t.FooterText as string) ?? null,
      visibleFields: parseVisibleFields(t.VisibleFields as string | null),
      logoDataUri: await loadAssetDataUri(t.LogoAssetID as number | null),
      secondaryLogoDataUri: await loadAssetDataUri(t.SecondaryLogoAssetID as number | null),
    },
    participant: {
      fullName: name,
      certificateType: 'Continuing',
      agencyName: (e.AgencyName as string) ?? null,
      schoolYear: (e.SchoolYear as string) ?? '',
      totalHours: Number(e.TotalHours ?? 0),
      totalCeus: Number(e.TotalCeus ?? 0),
      firstDate: e.FirstDate ? (e.FirstDate as Date).toISOString().slice(0, 10) : null,
      lastDate: e.LastDate ? (e.LastDate as Date).toISOString().slice(0, 10) : null,
      workshops: workshops.recordset.map((w) => ({
        title: w.title ?? 'Workshop',
        date: w.date,
        hours: w.hours === null ? null : Number(w.hours),
      })),
    },
    override: o
      ? {
          customText: (o.CustomText as string) ?? null,
          customTextLabel: (o.CustomTextLabel as string) ?? null,
          imageDataUri: await loadAssetDataUri(o.ImageAssetID as number | null),
          imageAltText: (o.ImageAltText as string) ?? null,
          imagePlacement: (o.ImagePlacement as 'header' | 'body' | 'footer' | null) ?? null,
        }
      : null,
    generatedOn: new Date().toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }),
  };
}

/**
 * @openapi
 * /api/certificates/preview/{participantId}:
 *   get:
 *     tags: [Certificates]
 *     summary: HTML preview of a participant's certificate
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: HTML }
 */
certificatesRouter.get('/preview/:participantId', requireAuth, async (req, res, next) => {
  try {
    const parsed = z
      .object({ schoolYearId: z.coerce.number().int(), certificateType: certType })
      .safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'schoolYearId and certificateType are required' });
      return;
    }

    const model = await buildModel(
      Number(req.params.participantId),
      parsed.data.schoolYearId,
      parsed.data.certificateType,
    );

    if (!model) {
      res.status(404).json({ error: 'not_found', message: 'Participant is not eligible for this certificate' });
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderCertificateHtml(model));
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/certificates/pdf/{participantId}:
 *   get:
 *     tags: [Certificates]
 *     summary: Download a participant's certificate as PDF
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: PDF }
 */
certificatesRouter.get('/pdf/:participantId', requireAuth, async (req, res, next) => {
  try {
    const parsed = z
      .object({ schoolYearId: z.coerce.number().int(), certificateType: certType })
      .safeParse(req.query);

    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', message: 'schoolYearId and certificateType are required' });
      return;
    }

    const participantId = Number(req.params.participantId);
    const model = await buildModel(participantId, parsed.data.schoolYearId, parsed.data.certificateType);

    if (!model) {
      res.status(404).json({ error: 'not_found', message: 'Participant is not eligible for this certificate' });
      return;
    }

    const html = renderCertificateHtml(model);
    const pdf = await renderPdf(html);

    const safeName = model.participant.fullName.replace(/[^A-Za-z0-9]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${parsed.data.certificateType}-${safeName}-${model.participant.schoolYear}.pdf"`,
    );
    res.send(pdf);
  } catch (err) {
    if (err instanceof PdfUnavailableError) {
      res.status(503).json({ error: 'pdf_unavailable', message: err.message });
      return;
    }
    next(err);
  }
});

/** Reports whether PDF rendering is available, for the UI to warn early. */
certificatesRouter.get('/capabilities', requireAuth, async (_req, res, next) => {
  try {
    const browser = await findBrowser();
    res.json({ pdfRendering: browser !== null });
  } catch (err) {
    next(err);
  }
});
