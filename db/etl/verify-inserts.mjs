import 'dotenv/config';
import sql from 'mssql';

/**
 * Runs every create statement against BOTH databases inside a transaction that
 * is always rolled back, and fails if any of them works on one database but
 * not the other.
 *
 * compare-schema.ps1 proves the two SCHEMAS match. This proves the CODE
 * matches the schema, which is the other half. Migration 025 added IDENTITY to
 * Participant and Registration on test only: the code omitted the id, which
 * passed on test and failed in production with "Cannot insert the value NULL".
 * After production was migrated, the same code failed on both with "Cannot
 * insert explicit value for identity column". A schema check alone catches
 * neither.
 *
 * Nothing is written — every statement runs inside a rollback.
 *
 * Usage (from apps/api, so dotenv finds .env):
 *   node ../../db/etl/verify-inserts.mjs
 */
const mk = (s, d, u, p) => ({
  server: s, database: d, user: u, password: p,
  options: { encrypt: true, trustServerCertificate: false }, connectionTimeout: 60000,
});

const targets = [
  ['TEST', mk(process.env.AZURE_SQL_SERVER, process.env.AZURE_SQL_DATABASE, process.env.AZURE_SQL_USER, process.env.AZURE_SQL_PASSWORD)],
  ['PROD', mk(process.env.AZURE_SQL_SERVER_PROD, process.env.AZURE_SQL_DATABASE_PROD, process.env.AZURE_SQL_USER_PROD, process.env.AZURE_SQL_PASSWORD_PROD)],
];

const cases = [
  ['participant (schoolcash/public form)', `INSERT INTO core.Participant (FirstName, LastName, Email, DateOfEntry)
     OUTPUT INSERTED.ParticipantID AS id VALUES ('ZZ','DriftCheck','zz.drift@example.invalid',SYSUTCDATETIME())`],
  ['participant (participants route)', `INSERT INTO core.Participant (FirstName, LastName, Email, DateOfEntry)
     OUTPUT INSERTED.ParticipantID AS id VALUES ('ZZ','DriftCheck2','zz.drift2@example.invalid',SYSUTCDATETIME())`],
  ['registration (schoolcash)', `INSERT INTO core.Registration (ParticipantID, WorkshopID, RegistrationDate, IsCancelled, Attended, EmailConfirmation, Source)
     OUTPUT INSERTED.RegistrationID AS id VALUES (1, NULL, CAST(SYSUTCDATETIME() AS DATE), 0, 0, 0, 'SchoolCash')`],
  ['registration (payments, with workshop)', `INSERT INTO core.Registration (ParticipantID, WorkshopID, RegistrationDate, IsCancelled, IsLate, Attended, EmailConfirmation, Source, PaymentMethodID, PaidAmount, PaidDate)
     OUTPUT INSERTED.RegistrationID AS id VALUES (1, NULL, CAST(SYSUTCDATETIME() AS DATE), 0, 0, 0, 0, 'Manual', 2, 1, CAST(SYSUTCDATETIME() AS DATE))`],
  ['registration (public form)', `INSERT INTO core.Registration (ParticipantID, WorkshopID, RegistrationDate, IsCancelled, Attended, EmailConfirmation, Source, RegistrationLinkID, ConfirmationToken, Notes)
     OUTPUT INSERTED.RegistrationID AS id VALUES (1, NULL, CAST(SYSUTCDATETIME() AS DATE), 0, 0, 0, 'Web', NULL, NULL, NULL)`],
  ['payment + payment method (still plain int)', `INSERT INTO core.Payment (PaymentID, PaymentMethodID, PaymentTotal, PaidDate, Notes, Source, ExternalReceipt, ExternalPaymentId, FeeAmount)
     OUTPUT INSERTED.PaymentID AS id
     SELECT ISNULL(MAX(PaymentID),0)+1, 7, 1, CAST(SYSUTCDATETIME() AS DATE), 'drift check', 'SchoolCash', NULL, 'drift|check|identity', 0
       FROM core.Payment WITH (UPDLOCK, HOLDLOCK)`],
];

let failures = 0;
for (const [label, cfg] of targets) {
  const pool = await new sql.ConnectionPool(cfg).connect();
  console.log(`\n=== ${label} ===`);
  for (const [name, statement] of cases) {
    const tx = pool.transaction();
    await tx.begin();
    try {
      const r = await tx.request().query(statement);
      console.log(`  PASS  ${name} -> id ${r.recordset[0].id}`);
    } catch (e) {
      failures += 1;
      console.log(`  FAIL  ${name}: ${e.message}`);
    } finally {
      try { await tx.rollback(); } catch { /* gone */ }
    }
  }
  await pool.close();
}

console.log(failures === 0 ? '\nAll create statements work on both databases.' : `\n${failures} failure(s).`);
process.exitCode = failures === 0 ? 0 : 1;
