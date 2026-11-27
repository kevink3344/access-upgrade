import crypto from 'node:crypto';
import { query, sql } from '../db.js';

/**
 * Per-form header images.
 *
 * The bytes live in core.CertificateAsset, the image store the certificate
 * designer already uses, so the upload path, the 2 MB ceiling and the
 * SHA-256 de-duplication are shared rather than re-implemented. This module
 * holds only the form-specific parts: the content-type rules and the three
 * ways an image is read back (public, staff, and the upload itself).
 */

export const MAX_HEADER_BYTES = 2 * 1024 * 1024;

/**
 * SVG is deliberately absent. The public route serves these bytes from our
 * own origin, and an SVG can carry script — fine for authenticated staff
 * looking at certificate art, not fine on a page a family opens.
 */
export const HEADER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export interface DecodedImage {
  content: Buffer;
  contentType: string;
  fileName: string | null;
  sha256: Buffer;
}

export type DecodeResult = DecodedImage | { error: string };

/**
 * Decodes a `data:` URI or raw base64 body. Kept strict: the only images
 * this accepts are ones a staff member just picked in the browser.
 */
export function decodeHeaderImage(body: {
  data: string;
  contentType: string;
  fileName?: string;
}): DecodeResult {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(body.data);
  const contentType = m ? m[1]! : body.contentType;
  const b64 = m ? m[2]! : body.data;

  if (!HEADER_TYPES.includes(contentType)) {
    return { error: 'Unsupported image type. Use PNG, JPEG or WebP.' };
  }

  let content: Buffer;
  try {
    content = Buffer.from(b64, 'base64');
  } catch {
    return { error: 'Image data is not valid base64' };
  }

  if (content.length === 0) return { error: 'Image is empty' };
  if (content.length > MAX_HEADER_BYTES) return { error: 'Image is larger than 2 MB' };

  return {
    content,
    contentType,
    fileName: body.fileName ?? null,
    sha256: crypto.createHash('sha256').update(content).digest(),
  };
}

/**
 * Stores the bytes, reusing an identical image rather than writing it twice.
 * Two forms sharing a banner therefore share one row.
 */
export async function storeHeaderImage(
  image: DecodedImage,
  uploadedBy: string | null,
): Promise<number> {
  const existing = await query<{ id: number }>(
    `SELECT TOP 1 CertificateAssetID AS id FROM core.CertificateAsset
      WHERE Sha256 = @sha AND AssetKind = 'form-header'`,
    { sha: { type: sql.VarBinary(32), value: image.sha256 } },
  );
  if (existing.recordset[0]) return existing.recordset[0].id;

  const inserted = await query<{ id: number }>(
    `INSERT INTO core.CertificateAsset
       (AssetKind, FileName, ContentType, ByteSize, Sha256, Content, UploadedBy)
     OUTPUT INSERTED.CertificateAssetID AS id
     VALUES ('form-header', @name, @type, @size, @sha, @content, @by)`,
    {
      name: { type: sql.NVarChar(260), value: image.fileName },
      type: { type: sql.NVarChar(100), value: image.contentType },
      size: { type: sql.Int, value: image.content.length },
      sha: { type: sql.VarBinary(32), value: image.sha256 },
      content: { type: sql.VarBinary(sql.MAX), value: image.content },
      by: { type: sql.NVarChar(200), value: uploadedBy },
    },
  );
  return inserted.recordset[0]!.id;
}

export interface HeaderImage {
  content: Buffer;
  contentType: string;
}

/** The template's header bytes, or null when it has none. */
export async function loadHeaderImage(formTemplateId: number): Promise<HeaderImage | null> {
  const r = await query<{ Content: Buffer; ContentType: string }>(
    `SELECT a.Content, a.ContentType
       FROM core.FormTemplate t
       JOIN core.CertificateAsset a ON a.CertificateAssetID = t.HeaderAssetID
      WHERE t.FormTemplateID = @id`,
    { id: { type: sql.Int, value: formTemplateId } },
  );
  const row = r.recordset[0];
  return row ? { content: row.Content, contentType: row.ContentType } : null;
}

/**
 * The template's header bytes, but only while at least one live link uses
 * that form. Without this the public route would be an open image host
 * enumerable by form id.
 */
export async function loadPublicHeaderImage(
  formTemplateId: number,
): Promise<HeaderImage | null> {
  const r = await query<{ Content: Buffer; ContentType: string }>(
    `SELECT a.Content, a.ContentType
       FROM core.FormTemplate t
       JOIN core.CertificateAsset a ON a.CertificateAssetID = t.HeaderAssetID
      WHERE t.FormTemplateID = @id
        AND EXISTS (
              SELECT 1 FROM core.WorkshopRegistrationLink l
               WHERE l.FormTemplateID = t.FormTemplateID
                 AND l.IsActive = 1
                 AND l.RevokedAt IS NULL)`,
    { id: { type: sql.Int, value: formTemplateId } },
  );
  const row = r.recordset[0];
  return row ? { content: row.Content, contentType: row.ContentType } : null;
}
