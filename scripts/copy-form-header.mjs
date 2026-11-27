/**
 * Copy a form's header image from the test database to production.
 *
 * The banner lives in core.CertificateAsset and is referenced by
 * core.FormTemplate.HeaderAssetID / HeaderAltText. This reads the image from
 * test and writes the same bytes to production, reusing an identical asset if
 * one already exists there (the same SHA-256 de-duplication the upload path
 * uses), then points the production form at it.
 *
 * Run from apps/api so it picks up .env:
 *
 *   npx tsx ../../scripts/copy-form-header.mjs --form 4
 *
 * Nothing is written to test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../apps/api/.env');

const cfg = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
  if (m) cfg[m[1]] = m[2].trim();
}

const argForm = process.argv.indexOf('--form');
let formTemplateId = argForm > -1 ? Number(process.argv[argForm + 1]) : NaN;
if (!Number.isInteger(formTemplateId)) {
  console.error('Usage: npx tsx ../../scripts/copy-form-header.mjs --form <FormTemplateID>');
  process.exit(1);
}

const connect = (suffix) =>
  new sql.ConnectionPool({
    server: cfg[`AZURE_SQL_SERVER${suffix}`],
    database: cfg[`AZURE_SQL_DATABASE${suffix}`],
    user: cfg[`AZURE_SQL_USER${suffix}`],
    password: cfg[`AZURE_SQL_PASSWORD${suffix}`],
    options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true },
    requestTimeout: 60_000,
    connectionTimeout: 60_000,
  }).connect();

const test = await connect('');
const prod = await connect('_PROD');

try {
  const source = await test
    .request()
    .input('id', sql.Int, formTemplateId)
    .query(
      `SELECT t.FormTemplateID, t.Name, t.HeaderAssetID, t.HeaderAltText,
              a.FileName, a.ContentType, a.ByteSize, a.Sha256, a.Content
         FROM core.FormTemplate t
         LEFT JOIN core.CertificateAsset a ON a.CertificateAssetID = t.HeaderAssetID
        WHERE t.FormTemplateID = @id`,
    );

  const src = source.recordset[0];
  if (!src) {
    console.error(`Form ${formTemplateId} not found in test.`);
    process.exit(1);
  }
  if (!src.HeaderAssetID) {
    console.error(`Form ${formTemplateId} ("${src.Name}") has no header image in test.`);
    process.exit(1);
  }

  const target = await prod
    .request()
    .input('id', sql.Int, formTemplateId)
    .query(`SELECT FormTemplateID, Name, HeaderAssetID FROM core.FormTemplate WHERE FormTemplateID = @id`);

  let dst = target.recordset[0];

  // Form ids are per-database identities, so the same form can have a
  // different id in production. Fall back to the name, which is what staff
  // recognise anyway.
  if (!dst) {
    const byName = await prod
      .request()
      .input('name', sql.NVarChar(100), src.Name)
      .query(
        `SELECT TOP 1 FormTemplateID, Name, HeaderAssetID
           FROM core.FormTemplate
          WHERE Name = @name AND ArchivedAt IS NULL
          ORDER BY FormTemplateID`,
      );
    dst = byName.recordset[0];
    if (dst) {
      console.log(
        `Form ${formTemplateId} is not in production; using "${dst.Name}" (id ${dst.FormTemplateID}) by name.`,
      );
    }
  }

  if (!dst) {
    const names = await prod
      .request()
      .query(
        `SELECT FormTemplateID, Name FROM core.FormTemplate
          WHERE ArchivedAt IS NULL ORDER BY FormTemplateID`,
      );
    console.error(
      `No form named "${src.Name}" in production, so there is nothing to attach the image to.\n` +
        `Production forms:\n` +
        (names.recordset.length
          ? names.recordset.map((r) => `  ${r.FormTemplateID}  ${r.Name}`).join('\n')
          : '  (none — the form has not been created in production yet)') +
        `\nCreate the form in production, then re-run this script.`,
    );
    process.exit(1);
  }

  formTemplateId = dst.FormTemplateID;

  const existing = await prod
    .request()
    .input('sha', sql.VarBinary(32), src.Sha256)
    .query(
      `SELECT TOP 1 CertificateAssetID FROM core.CertificateAsset
        WHERE Sha256 = @sha AND AssetKind = 'form-header'`,
    );

  let assetId = existing.recordset[0]?.CertificateAssetID;

  if (assetId) {
    console.log(`Reusing existing production asset ${assetId} (identical bytes).`);
  } else {
    const inserted = await prod
      .request()
      .input('name', sql.NVarChar(260), src.FileName)
      .input('type', sql.NVarChar(100), src.ContentType)
      .input('size', sql.Int, src.ByteSize)
      .input('sha', sql.VarBinary(32), src.Sha256)
      .input('content', sql.VarBinary(sql.MAX), src.Content)
      .input('by', sql.NVarChar(200), 'copy-form-header')
      .query(
        `INSERT INTO core.CertificateAsset
           (AssetKind, FileName, ContentType, ByteSize, Sha256, Content, UploadedBy)
         OUTPUT INSERTED.CertificateAssetID AS id
         VALUES ('form-header', @name, @type, @size, @sha, @content, @by)`,
      );
    assetId = inserted.recordset[0].id;
    console.log(`Inserted production asset ${assetId} (${src.ByteSize} bytes, ${src.ContentType}).`);
  }

  await prod
    .request()
    .input('id', sql.Int, formTemplateId)
    .input('asset', sql.Int, assetId)
    .input('alt', sql.NVarChar(200), src.HeaderAltText)
    .query(
      `UPDATE core.FormTemplate
          SET HeaderAssetID = @asset, HeaderAltText = @alt,
              UpdatedBy = 'copy-form-header', UpdatedAt = SYSUTCDATETIME()
        WHERE FormTemplateID = @id`,
    );

  console.log(
    `Production form ${formTemplateId} ("${dst.Name}") now uses asset ${assetId}, alt text "${src.HeaderAltText}".`,
  );
} finally {
  await test.close();
  await prod.close();
}
