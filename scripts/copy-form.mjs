/**
 * Copy a form (template, every version, its pages and questions, and its
 * header image) from the test database to production.
 *
 * A form is not just a row: its versions, pages and questions live in four
 * tables with per-database identities, so "move the form" means recreating
 * the whole tree. The header image is copied too, reusing an identical
 * production asset when the bytes match.
 *
 * Run from the repo root:
 *
 *   npx tsx scripts/copy-form.mjs --form 4            # dry run: report only
 *   npx tsx scripts/copy-form.mjs --form 4 --apply    # write to production
 *
 * Nothing is written to test. If a form with the same name already exists in
 * production, the script stops rather than creating a duplicate.
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
const formTemplateId = argForm > -1 ? Number(process.argv[argForm + 1]) : NaN;
const apply = process.argv.includes('--apply');

if (!Number.isInteger(formTemplateId)) {
  console.error('Usage: npx tsx scripts/copy-form.mjs --form <FormTemplateID> [--apply]');
  process.exit(1);
}

const connect = (suffix) =>
  new sql.ConnectionPool({
    server: cfg[`AZURE_SQL_SERVER${suffix}`],
    database: cfg[`AZURE_SQL_DATABASE${suffix}`],
    user: cfg[`AZURE_SQL_USER${suffix}`],
    password: cfg[`AZURE_SQL_PASSWORD${suffix}`],
    options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true },
    requestTimeout: 120_000,
    connectionTimeout: 60_000,
  }).connect();

/** Next free id for a non-IDENTITY table, allocated inside the transaction. */
async function nextId(tx, table, column, seed) {
  const req = new sql.Request(tx);
  const names = Object.keys(seed);
  const placeholders = names.map((k) => `@${k}`);
  for (const [k, v] of Object.entries(seed)) req.input(k, v.type, v.value);

  const r = await req.query(
    `DECLARE @id INT;
     SELECT @id = ISNULL(MAX(${column}), 0) + 1 FROM ${table} WITH (UPDLOCK, HOLDLOCK);
     INSERT INTO ${table} (${column}${names.length ? ', ' + names.join(', ') : ''})
     OUTPUT INSERTED.${column} AS id
     VALUES (@id${placeholders.length ? ', ' + placeholders.join(', ') : ''});`,
  );
  return r.recordset[0].id;
}

const test = await connect('');
const prod = await connect('_PROD');

try {
  /* ---------------- read the whole form from test ---------------- */

  const tplRes = await test
    .request()
    .input('id', sql.Int, formTemplateId)
    .query(
      `SELECT t.FormTemplateID, t.Name, t.Description, t.IsActive, t.Kind,
              t.HeaderAssetID, t.HeaderAltText, t.CreatedBy,
              a.FileName, a.ContentType, a.ByteSize, a.Sha256, a.Content
         FROM core.FormTemplate t
         LEFT JOIN core.CertificateAsset a ON a.CertificateAssetID = t.HeaderAssetID
        WHERE t.FormTemplateID = @id`,
    );
  const tpl = tplRes.recordset[0];
  if (!tpl) {
    console.error(`Form ${formTemplateId} not found in test.`);
    process.exit(1);
  }

  const versions = (
    await test
      .request()
      .input('id', sql.Int, formTemplateId)
      .query(
        `SELECT FormTemplateVersionID, VersionNumber, PublishedAt, PublishedBy, CreatedBy, CreatedAt
           FROM core.FormTemplateVersion WHERE FormTemplateID = @id
          ORDER BY VersionNumber`,
      )
  ).recordset;

  const pages = (
    await test.request().input('id', sql.Int, formTemplateId).query(
      `SELECT p.FormPageID, p.FormTemplateVersionID, p.SortOrder, p.Title, p.Subtitle
         FROM core.FormPage p
         JOIN core.FormTemplateVersion v ON v.FormTemplateVersionID = p.FormTemplateVersionID
        WHERE v.FormTemplateID = @id ORDER BY p.SortOrder`,
    )
  ).recordset;

  const questions = (
    await test.request().input('id', sql.Int, formTemplateId).query(
      `SELECT q.FormQuestionID, q.FormTemplateVersionID, q.SortOrder, q.QuestionKey, q.Label,
              q.HelpText, q.Placeholder, q.FieldType, q.IsRequired, q.OptionsJson, q.MaxLength,
              q.MapsToColumn, q.IsBuiltIn, q.IsActive, q.BranchOnQuestionID, q.BranchOptionValue,
              q.FormPageID
         FROM core.FormQuestion q
         JOIN core.FormTemplateVersion v ON v.FormTemplateVersionID = q.FormTemplateVersionID
        WHERE v.FormTemplateID = @id
        ORDER BY q.FormTemplateVersionID, q.SortOrder`,
    )
  ).recordset;

  console.log(
    `Source: "${tpl.Name}" (id ${tpl.FormTemplateID}, kind ${tpl.Kind}) — ` +
      `${versions.length} version(s), ${pages.length} page(s), ${questions.length} question(s), ` +
      `${tpl.HeaderAssetID ? 'with' : 'without'} a header image.`,
  );

  /* ---------------- check production is clear ---------------- */

  const clash = await prod
    .request()
    .input('name', sql.NVarChar(100), tpl.Name)
    .query(
      `SELECT FormTemplateID, Name, ArchivedAt FROM core.FormTemplate WHERE Name = @name`,
    );
  if (clash.recordset.length > 0) {
    const c = clash.recordset[0];
    console.error(
      `Production already has a form named "${c.Name}" (id ${c.FormTemplateID}` +
        `${c.ArchivedAt ? ', archived' : ''}). Refusing to create a duplicate.`,
    );
    process.exit(1);
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to copy it to production.');
    process.exit(0);
  }

  /* ---------------- write to production ---------------- */

  const tx = new sql.Transaction(prod);
  await tx.begin();

  try {
    const actor = 'copy-form';

    const newTemplateId = await nextId(tx, 'core.FormTemplate', 'FormTemplateID', {
      Name: { type: sql.NVarChar(100), value: tpl.Name },
      CreatedBy: { type: sql.NVarChar(200), value: actor },
    });

    await new sql.Request(tx)
      .input('id', sql.Int, newTemplateId)
      .input('desc', sql.NVarChar(500), tpl.Description)
      .input('active', sql.Bit, tpl.IsActive ? 1 : 0)
      .input('kind', sql.NVarChar(30), tpl.Kind)
      .input('by', sql.NVarChar(200), actor)
      .query(
        `UPDATE core.FormTemplate
            SET Description = @desc, IsActive = @active, Kind = @kind,
                UpdatedBy = @by, UpdatedAt = SYSUTCDATETIME()
          WHERE FormTemplateID = @id`,
      );

    // Header image: reuse identical bytes when production already has them.
    if (tpl.HeaderAssetID) {
      const existing = await prod
        .request()
        .input('sha', sql.VarBinary(32), tpl.Sha256)
        .query(
          `SELECT TOP 1 CertificateAssetID FROM core.CertificateAsset
            WHERE Sha256 = @sha AND AssetKind = 'form-header'`,
        );
      let assetId = existing.recordset[0]?.CertificateAssetID;

      if (!assetId) {
        const inserted = await new sql.Request(tx)
          .input('name', sql.NVarChar(260), tpl.FileName)
          .input('type', sql.NVarChar(100), tpl.ContentType)
          .input('size', sql.Int, tpl.ByteSize)
          .input('sha', sql.VarBinary(32), tpl.Sha256)
          .input('content', sql.VarBinary(sql.MAX), tpl.Content)
          .input('by', sql.NVarChar(200), actor)
          .query(
            `INSERT INTO core.CertificateAsset
               (AssetKind, FileName, ContentType, ByteSize, Sha256, Content, UploadedBy)
             OUTPUT INSERTED.CertificateAssetID AS id
             VALUES ('form-header', @name, @type, @size, @sha, @content, @by)`,
          );
        assetId = inserted.recordset[0].id;
      }

      await new sql.Request(tx)
        .input('id', sql.Int, newTemplateId)
        .input('asset', sql.Int, assetId)
        .input('alt', sql.NVarChar(200), tpl.HeaderAltText)
        .query(
          `UPDATE core.FormTemplate SET HeaderAssetID = @asset, HeaderAltText = @alt
            WHERE FormTemplateID = @id`,
        );
      console.log(`Header image copied (asset ${assetId}).`);
    }

    // Versions, then pages, then questions — each child needs its parent's id.
    const versionMap = new Map();
    for (const v of versions) {
      const newId = await nextId(tx, 'core.FormTemplateVersion', 'FormTemplateVersionID', {
        FormTemplateID: { type: sql.Int, value: newTemplateId },
        VersionNumber: { type: sql.Int, value: v.VersionNumber },
        CreatedBy: { type: sql.NVarChar(200), value: actor },
      });
      await new sql.Request(tx)
        .input('id', sql.Int, newId)
        .input('pub', sql.DateTime2, v.PublishedAt)
        .input('pubBy', sql.NVarChar(200), v.PublishedBy)
        .query(
          `UPDATE core.FormTemplateVersion SET PublishedAt = @pub, PublishedBy = @pubBy
            WHERE FormTemplateVersionID = @id`,
        );
      versionMap.set(v.FormTemplateVersionID, newId);
    }

    const pageMap = new Map();
    for (const p of pages) {
      const newId = await nextId(tx, 'core.FormPage', 'FormPageID', {
        FormTemplateVersionID: { type: sql.Int, value: versionMap.get(p.FormTemplateVersionID) },
        SortOrder: { type: sql.Int, value: p.SortOrder },
        Title: { type: sql.NVarChar(100), value: p.Title },
      });
      await new sql.Request(tx)
        .input('id', sql.Int, newId)
        .input('sub', sql.NVarChar(300), p.Subtitle)
        .query(`UPDATE core.FormPage SET Subtitle = @sub WHERE FormPageID = @id`);
      pageMap.set(p.FormPageID, newId);
    }

    // Questions reference each other (branching), so allocate every id first
    // and resolve the references afterwards.
    const questionMap = new Map();
    for (const q of questions) {
      questionMap.set(q.FormQuestionID, await nextId(tx, 'core.FormQuestion', 'FormQuestionID', {
        FormTemplateVersionID: { type: sql.Int, value: versionMap.get(q.FormTemplateVersionID) },
        SortOrder: { type: sql.Int, value: q.SortOrder },
        QuestionKey: { type: sql.NVarChar(50), value: q.QuestionKey },
        Label: { type: sql.NVarChar(200), value: q.Label },
        FieldType: { type: sql.NVarChar(20), value: q.FieldType },
      }));
    }

    for (const q of questions) {
      await new sql.Request(tx)
        .input('id', sql.Int, questionMap.get(q.FormQuestionID))
        .input('help', sql.NVarChar(300), q.HelpText)
        .input('ph', sql.NVarChar(100), q.Placeholder)
        .input('req', sql.Bit, q.IsRequired ? 1 : 0)
        .input('opts', sql.NVarChar(sql.MAX), q.OptionsJson)
        .input('maxLen', sql.Int, q.MaxLength)
        .input('maps', sql.NVarChar(50), q.MapsToColumn)
        .input('builtIn', sql.Bit, q.IsBuiltIn ? 1 : 0)
        .input('active', sql.Bit, q.IsActive ? 1 : 0)
        .input('branchOn', sql.Int, q.BranchOnQuestionID ? questionMap.get(q.BranchOnQuestionID) : null)
        .input('branchVal', sql.NVarChar(100), q.BranchOptionValue)
        .input('page', sql.Int, q.FormPageID ? pageMap.get(q.FormPageID) : null)
        .query(
          `UPDATE core.FormQuestion
              SET HelpText = @help, Placeholder = @ph, IsRequired = @req, OptionsJson = @opts,
                  MaxLength = @maxLen, MapsToColumn = @maps, IsBuiltIn = @builtIn,
                  IsActive = @active, BranchOnQuestionID = @branchOn,
                  BranchOptionValue = @branchVal, FormPageID = @page
            WHERE FormQuestionID = @id`,
        );
    }

    await tx.commit();

    console.log(
      `\nCopied to production as form ${newTemplateId}: ` +
        `${versions.length} version(s), ${pages.length} page(s), ${questions.length} question(s).`,
    );
  } catch (err) {
    await tx.rollback();
    throw err;
  }
} finally {
  await test.close();
  await prod.close();
}
