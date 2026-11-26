import { Router } from 'express';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

export const lookupsRouter = Router();

/**
 * One editable column on a lookup table. `max` mirrors the column width in
 * db/schema.sql; the API checks it before SQL Server would, so a long value
 * comes back as a field error rather than a truncation error.
 */
interface LookupField {
  column: string;
  label: string;
  max: number;
  required?: boolean;
  /** Rendered as a checkbox rather than a text input. */
  type?: 'text' | 'boolean';
}

interface LookupDef {
  table: string;
  idColumn: string;
  labelColumn: string;
  orderBy?: string;
  /** Extra columns appended to the id/label pair, aliased to these names. */
  extraColumns?: Record<string, string>;
  /**
   * Set when Settings > Dropdown lists may maintain this table. The fields are
   * exactly what the drawer edits; everything else on the row is left alone.
   */
  fields?: LookupField[];
  /** Shown under the drawer's title, e.g. to explain a non-obvious column. */
  note?: string;
}

/**
 * Whitelist of lookup tables exposed by the generic endpoint. Adding a
 * lookup means adding one entry here — no new route, no new SQL.
 * `key` is the URL segment; `table` is the real object.
 */
const LOOKUPS: Record<string, LookupDef> = {
  'agency-types': {
    table: 'ref.AgencyType',
    idColumn: 'AgencyTypeID',
    labelColumn: 'TypeName',
    fields: [{ column: 'TypeName', label: 'Agency type', max: 50, required: true }],
  },
  ages: {
    table: 'ref.Age',
    idColumn: 'AgesID',
    labelColumn: 'Ages',
    fields: [{ column: 'Ages', label: 'Age group', max: 100, required: true }],
  },
  'backup-times': {
    table: 'ref.BackupTime',
    idColumn: 'BackupTimeID',
    labelColumn: 'BackupTime',
    fields: [{ column: 'BackupTime', label: 'Backup time', max: 15, required: true }],
  },
  categories: {
    table: 'ref.Category',
    idColumn: 'CategoryID',
    labelColumn: 'CategoryCode',
    fields: [
      { column: 'CategoryCode', label: 'Category code', max: 50, required: true },
      { column: 'CategoryType', label: 'Type', max: 10 },
      { column: 'IsInUse', label: 'In use', max: 0, type: 'boolean' },
    ],
  },
  cities: {
    table: 'ref.City',
    idColumn: 'CityID',
    labelColumn: 'City',
    fields: [{ column: 'City', label: 'City', max: 30, required: true }],
  },
  components: {
    table: 'ref.Component',
    idColumn: 'ComponentID',
    labelColumn: 'PrEComponent',
    fields: [
      { column: 'PrEComponent', label: 'Component', max: 30, required: true },
      { column: 'PrECompAbbrev', label: 'Abbreviation', max: 10 },
    ],
  },
  'contact-types': {
    table: 'ref.ContactType',
    idColumn: 'ContactTypeID',
    labelColumn: 'ContactType',
    fields: [{ column: 'ContactType', label: 'Contact type', max: 50, required: true }],
  },
  counties: {
    table: 'ref.County',
    idColumn: 'CountyID',
    labelColumn: 'County',
    fields: [{ column: 'County', label: 'County', max: 20, required: true }],
  },
  'credit-slip-categories': {
    table: 'ref.CreditSlipCategory',
    idColumn: 'CreditSlipsCategoryID',
    labelColumn: 'CreditSlipsCategory',
    fields: [
      { column: 'CreditSlipsCategory', label: 'Category', max: 30, required: true },
    ],
  },
  'credit-types': {
    table: 'ref.CreditType',
    idColumn: 'CreditTypeID',
    labelColumn: 'CreditCode',
    fields: [
      { column: 'CreditCode', label: 'Credit code', max: 50, required: true },
      { column: 'CreditDescription', label: 'Description', max: 50 },
    ],
  },
  'desired-topic-categories': {
    table: 'ref.DesiredTopicCategory',
    idColumn: 'DesiredTopicCategoryID',
    labelColumn: 'DesiredTopicCategory',
    fields: [
      { column: 'DesiredTopicCategory', label: 'Category', max: 255, required: true },
    ],
  },
  equipment: {
    table: 'ref.Equipment',
    idColumn: 'EquipmentID',
    labelColumn: 'Equipment',
    fields: [{ column: 'Equipment', label: 'Equipment', max: 255, required: true }],
  },
  'eval-question-types': {
    table: 'ref.EvalQuestionType',
    idColumn: 'EvalQuestTypeID',
    labelColumn: 'EvalQuestType',
    fields: [{ column: 'EvalQuestType', label: 'Question type', max: 15, required: true }],
  },
  'eval-types': {
    table: 'ref.EvalType',
    idColumn: 'EvalTypeID',
    labelColumn: 'WorkshopType',
    fields: [{ column: 'WorkshopType', label: 'Evaluation type', max: 255, required: true }],
  },
  'event-types': {
    table: 'ref.EventType',
    idColumn: 'EventTypeID',
    labelColumn: 'EventType',
    fields: [{ column: 'EventType', label: 'Event type', max: 100, required: true }],
  },
  'facility-types': {
    table: 'ref.FacilityType',
    idColumn: 'FacilityTypeID',
    labelColumn: 'FacilityType',
    fields: [{ column: 'FacilityType', label: 'Facility type', max: 255, required: true }],
  },
  'mailing-lists': {
    table: 'ref.MailingList',
    idColumn: 'MailingListID',
    labelColumn: 'MailingList',
    fields: [{ column: 'MailingList', label: 'Mailing list', max: 25, required: true }],
  },
  others: {
    table: 'ref.Other',
    idColumn: 'OtherID',
    labelColumn: 'OtherNickname',
    fields: [
      { column: 'OtherNickname', label: 'Nickname', max: 50, required: true },
      { column: 'Description', label: 'Description', max: 50 },
    ],
  },
  'payment-methods': {
    table: 'ref.PaymentMethod',
    idColumn: 'PaymentMethodID',
    labelColumn: 'PaymentMethod',
    fields: [{ column: 'PaymentMethod', label: 'Payment method', max: 50, required: true }],
  },
  'preferred-times': {
    table: 'ref.PreferredTime',
    idColumn: 'PreferredTimesID',
    labelColumn: 'PreferredTimes',
    fields: [
      { column: 'PreferredTimes', label: 'Preferred time', max: 25, required: true },
      { column: 'PreferredTimesNotes', label: 'Notes', max: 255 },
    ],
  },
  'referral-types': {
    table: 'ref.ReferralType',
    idColumn: 'ReferralTypeID',
    labelColumn: 'ReferralType',
    fields: [
      { column: 'ReferralType', label: 'Referral type', max: 35, required: true },
      { column: 'ReferralAbrev', label: 'Abbreviation', max: 10 },
    ],
  },
  regions: {
    table: 'ref.Region',
    idColumn: 'RegionID',
    labelColumn: 'Region',
    fields: [{ column: 'Region', label: 'Region', max: 50, required: true }],
  },
  salutations: {
    table: 'ref.Salutation',
    idColumn: 'SalutationID',
    labelColumn: 'Salutation',
    fields: [{ column: 'Salutation', label: 'Salutation', max: 50, required: true }],
  },
  'school-years': {
    table: 'ref.SchoolYear',
    idColumn: 'SchoolYearID',
    labelColumn: 'SchoolYear',
    // Most recent school year first — staff almost always want the current
    // or last year, not 2006-07.
    orderBy: 'SchoolYearID DESC',
    // The calendar needs to know which year is current and where it starts
    // and ends, so it can open on something meaningful.
    extraColumns: {
      isPastYear: 'IsPastYear',
      beginDate: 'BeginDate',
      endDate: 'EndDate',
    },
    fields: [
      { column: 'SchoolYear', label: 'School year', max: 50, required: true },
      { column: 'IsPastYear', label: 'Past year', max: 0, type: 'boolean' },
    ],
    note: 'Start and end dates are set when the year is created; the calendar uses them to open on the right month.',
  },
  states: {
    table: 'ref.State',
    idColumn: 'StateID',
    labelColumn: 'State',
    fields: [{ column: 'State', label: 'State', max: 2, required: true }],
  },
  'street-types': {
    table: 'ref.StreetType',
    idColumn: 'StreetTypeID',
    labelColumn: 'StreetTypeName',
    fields: [
      { column: 'StreetTypeName', label: 'Street type', max: 15, required: true },
      { column: 'StreetTypeAbbrev', label: 'Abbreviation', max: 8 },
    ],
  },
  'summary-count-types': {
    table: 'ref.SummaryCountType',
    idColumn: 'SummaryCountTypeID',
    labelColumn: 'CountType',
    fields: [{ column: 'CountType', label: 'Count type', max: 25, required: true }],
  },
};

/**
 * @openapi
 * /api/lookups:
 *   get:
 *     tags: [Lookups]
 *     summary: List available lookup tables
 *     description: >
 *       Keys for GET /api/lookups/{name}. `editable` marks the tables that
 *       Settings > Dropdown lists can maintain.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Lookup keys
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       key: { type: string }
 *                       editable: { type: boolean }
 */
lookupsRouter.get('/', requireAuth, (_req, res) => {
  res.json({
    data: Object.keys(LOOKUPS)
      .sort()
      .map((key) => ({ key, editable: !!LOOKUPS[key]!.fields })),
  });
});

/**
 * @openapi
 * /api/lookups/{name}:
 *   get:
 *     tags: [Lookups]
 *     summary: Get a lookup table
 *     description: One endpoint serves all 27 reference tables.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *         description: Lookup key, e.g. payment-methods
 *     responses:
 *       200:
 *         description: Lookup rows
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { type: object } }
 *       404: { description: Unknown lookup }
 */
lookupsRouter.get('/:name', requireAuth, async (req, res, next) => {
  try {
    const key = String(req.params.name);
    const def = LOOKUPS[key];

    if (!def) {
      res.status(404).json({
        error: 'not_found',
        message: `Unknown lookup '${key}'. See GET /api/lookups for the list.`,
      });
      return;
    }

    // Table and column names come from the whitelist above, never from input.
    const orderBy = def.orderBy ?? def.labelColumn;
    const extras = Object.entries(def.extraColumns ?? {})
      .map(([alias, col]) => `, ${col} AS ${alias}`)
      .join('');
    const result = await query<{ id: number; label: string | null }>(
      `SELECT ${def.idColumn} AS id, ${def.labelColumn} AS label${extras}
         FROM ${def.table}
        ORDER BY ${orderBy}`,
    );

    // How many records point at each entry, so the maintenance screen can
    // say what is in use instead of letting a delete fail.
    const counts = def.fields ? await referenceCounts(def) : new Map<number, number>();
    const data = result.recordset.map((row) => ({
      ...row,
      usageCount: counts.get(row.id) ?? 0,
    }));

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/** Exposed so other routers can validate lookup keys. */
export function isKnownLookup(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOOKUPS, name);
}

export { LOOKUPS };

/* ------------------------------------------------------------------ */
/*  Maintenance                                                       */
/*                                                                    */
/*  Settings > Dropdown lists edits the `fields` of a whitelisted      */
/*  table. Tables without `fields` are reference data the app reads    */
/*  but never maintains (states, counties, ZIP codes, ...).            */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/lookups/{name}/settings:
 *   get:
 *     tags: [Lookups]
 *     summary: Describe a maintainable lookup table
 *     description: >
 *       Field definitions for Settings > Dropdown lists, plus how many rows
 *       depend on each entry, so the drawer can warn before a delete.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: name, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Field definitions }
 *       404: { description: Unknown lookup }
 *       409: { description: Lookup is not maintainable }
 */
lookupsRouter.get('/:name/settings', requireAuth, async (req, res, next) => {
  try {
    const def = LOOKUPS[String(req.params.name)];
    if (!def) {
      res.status(404).json({ error: 'not_found', message: 'Unknown lookup' });
      return;
    }
    if (!def.fields) {
      res.status(409).json({
        error: 'not_maintainable',
        message: 'This list is reference data and is not maintained from Settings.',
      });
      return;
    }

    res.json({
      data: {
        key: String(req.params.name),
        title: def.fields[0]!.label,
        note: def.note ?? null,
        fields: def.fields.map((f) => ({
          key: f.column,
          label: f.label,
          max: f.max,
          required: !!f.required,
          type: f.type ?? 'text',
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/lookups/{name}:
 *   post:
 *     tags: [Lookups]
 *     summary: Add a lookup entry
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: name, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       201: { description: Created }
 *       409: { description: Another entry already has that value }
 *       422: { description: Validation failed }
 */
lookupsRouter.post(
  '/:name',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const def = LOOKUPS[String(req.params.name)];
      if (!def) {
        res.status(404).json({ error: 'not_found', message: 'Unknown lookup' });
        return;
      }
      if (!def.fields) {
        res.status(409).json({
          error: 'not_maintainable',
          message: 'This list is reference data and is not maintained from Settings.',
        });
        return;
      }

      const parsed = parseValues(def, req.body);
      if (!parsed.ok) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid entry',
          details: parsed.details,
        });
        return;
      }

      const labelValue = parsed.values[def.labelColumn];
      const dupe = await query<{ id: number }>(
        `SELECT TOP 1 ${def.idColumn} AS id FROM ${def.table}
          WHERE LOWER(${def.labelColumn}) = LOWER(@label)`,
        { label: { type: sql.NVarChar(255), value: String(labelValue ?? '') } },
      );
      if (dupe.recordset[0]) {
        res.status(409).json({
          error: 'conflict',
          message: 'That value is already in the list.',
          details: [{ path: def.labelColumn, message: 'Already in use' }],
        });
        return;
      }

      // None of the ref tables is IDENTITY — the legacy Access keys were
      // loaded verbatim. The id is allocated in the same statement as the
      // insert, so two concurrent adds cannot both read the same maximum.
      const cols = Object.keys(parsed.values);
      const params: Record<string, SqlParam> = {};
      for (const [col, value] of Object.entries(parsed.values)) {
        params[`v_${col}`] = { type: paramType(col, def), value };
      }

      const created = await query<{ id: number }>(
        `INSERT INTO ${def.table} (${def.idColumn}${cols.length ? ', ' + cols.join(', ') : ''})
         OUTPUT INSERTED.${def.idColumn} AS id
         SELECT ISNULL(MAX(${def.idColumn}), 0) + 1${cols.length ? ', ' + cols.map((c) => `@v_${c}`).join(', ') : ''}
           FROM ${def.table} WITH (UPDLOCK, HOLDLOCK)`,
        params,
      );

      res.status(201).json({ id: created.recordset[0]!.id });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/lookups/{name}/{id}:
 *   patch:
 *     tags: [Lookups]
 *     summary: Update a lookup entry
 *     description: >
 *       Edits the entry's own row. Rows elsewhere that point at it are left
 *       alone — they reference it by id, so they follow the new value.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: name, required: true, schema: { type: string } }
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       204: { description: Updated }
 *       404: { description: Not found }
 *       409: { description: Another entry already has that value }
 *       422: { description: Validation failed }
 */
lookupsRouter.patch(
  '/:name/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const def = LOOKUPS[String(req.params.name)];
      const id = Number(req.params.id);
      if (!def) {
        res.status(404).json({ error: 'not_found', message: 'Unknown lookup' });
        return;
      }
      if (!def.fields) {
        res.status(409).json({
          error: 'not_maintainable',
          message: 'This list is reference data and is not maintained from Settings.',
        });
        return;
      }
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const parsed = parseValues(def, req.body);
      if (!parsed.ok) {
        res.status(422).json({
          error: 'validation_failed',
          message: 'Invalid entry',
          details: parsed.details,
        });
        return;
      }

      const labelValue = parsed.values[def.labelColumn];
      if (labelValue !== undefined) {
        const clash = await query<{ id: number }>(
          `SELECT TOP 1 ${def.idColumn} AS id FROM ${def.table}
            WHERE LOWER(${def.labelColumn}) = LOWER(@label) AND ${def.idColumn} <> @id`,
          {
            label: { type: sql.NVarChar(255), value: String(labelValue) },
            id: { type: sql.Int, value: id },
          },
        );
        if (clash.recordset[0]) {
          res.status(409).json({
            error: 'conflict',
            message: 'Another entry already uses that value.',
            details: [{ path: def.labelColumn, message: 'Already in use' }],
          });
          return;
        }
      }

      const cols = Object.keys(parsed.values);
      if (cols.length === 0) {
        res.status(422).json({ error: 'validation_failed', message: 'No fields to update' });
        return;
      }

      const params: Record<string, SqlParam> = { id: { type: sql.Int, value: id } };
      for (const [col, value] of Object.entries(parsed.values)) {
        params[`v_${col}`] = { type: paramType(col, def), value };
      }

      const updated = await query<{ id: number }>(
        `UPDATE ${def.table} SET ${cols.map((c) => `${c} = @v_${c}`).join(', ')}
         OUTPUT INSERTED.${def.idColumn} AS id
          WHERE ${def.idColumn} = @id`,
        params,
      );

      if (updated.recordset.length === 0) {
        res.status(404).json({ error: 'not_found', message: 'Entry not found' });
        return;
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /api/lookups/{name}/{id}:
 *   delete:
 *     tags: [Lookups]
 *     summary: Delete a lookup entry
 *     description: >
 *       Refused while any row still points at the entry, because the
 *       foreign keys would reject the delete anyway and a bare 500 would
 *       not tell staff which records to fix.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: name, required: true, schema: { type: string } }
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Not found }
 *       409: { description: Referenced by other records }
 */
lookupsRouter.delete(
  '/:name/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'ADMIN'),
  async (req, res, next) => {
    try {
      const def = LOOKUPS[String(req.params.name)];
      const id = Number(req.params.id);
      if (!def) {
        res.status(404).json({ error: 'not_found', message: 'Unknown lookup' });
        return;
      }
      if (!def.fields) {
        res.status(409).json({
          error: 'not_maintainable',
          message: 'This list is reference data and is not maintained from Settings.',
        });
        return;
      }
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'bad_request', message: 'Invalid id' });
        return;
      }

      const refs = await referencesTo(def, id);
      if (refs.total > 0) {
        res.status(409).json({
          error: 'conflict',
          message:
            `Still used by ${refs.total.toLocaleString()} record(s) ` +
            `(${refs.parts.map((p) => `${p.count.toLocaleString()} ${p.label}`).join(', ')}). ` +
            'Point those records at another entry first, or keep this one.',
          details: refs.parts.map((p) => ({ path: p.label, message: String(p.count) })),
        });
        return;
      }

      const removed = await query<{ id: number }>(
        `DELETE FROM ${def.table} OUTPUT DELETED.${def.idColumn} AS id
          WHERE ${def.idColumn} = @id`,
        { id: { type: sql.Int, value: id } },
      );

      if (removed.recordset.length === 0) {
        res.status(404).json({ error: 'not_found', message: 'Entry not found' });
        return;
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Columns across the schema that reference this lookup, as `table.column`.
 * Read from sys.foreign_key_columns rather than hard-coded, so a new FK in a
 * migration is picked up without touching this file.
 */
async function referenceColumns(def: LookupDef): Promise<{ table: string; column: string }[]> {
  const r = await query<{ tableName: string; columnName: string }>(
    `SELECT OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS tableName,
            COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS columnName
       FROM sys.foreign_key_columns fkc
       JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
      WHERE fkc.referenced_object_id = OBJECT_ID(@table)`,
    { table: { type: sql.NVarChar(255), value: def.table } },
  );
  return r.recordset.map((row) => ({ table: row.tableName, column: row.columnName }));
}

/**
 * How many rows point at each entry, keyed by id. Empty when nothing
 * references the table, which also keeps the list endpoint to one query.
 */
async function referenceCounts(def: LookupDef): Promise<Map<number, number>> {
  const columns = await referenceColumns(def);
  const counts = new Map<number, number>();
  if (columns.length === 0) return counts;

  const unions = columns
    .map((c) => `SELECT ${c.column} AS id FROM ${c.table} WHERE ${c.column} IS NOT NULL`)
    .join(' UNION ALL ');
  const r = await query<{ id: number; n: number }>(
    `SELECT id, COUNT(*) AS n FROM (${unions}) AS refs GROUP BY id`,
  );
  for (const row of r.recordset) counts.set(row.id, row.n);
  return counts;
}

/** Totals for the delete guard, broken down so the message can name them. */
async function referencesTo(
  def: LookupDef,
  id: number,
): Promise<{ total: number; parts: { label: string; count: number }[] }> {
  const columns = await referenceColumns(def);
  const parts: { label: string; count: number }[] = [];
  let total = 0;

  for (const c of columns) {
    const r = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${c.table} WHERE ${c.column} = @id`,
      { id: { type: sql.Int, value: id } },
    );
    const n = r.recordset[0]?.n ?? 0;
    if (n > 0) {
      total += n;
      parts.push({ label: c.table.replace(/^core\./, ''), count: n });
    }
  }

  return { total, parts };
}

/** SQL type for an editable column, from the column name and its width. */
function paramType(column: string, def: LookupDef): SqlParam['type'] {
  const field = def.fields?.find((f) => f.column === column);
  if (field?.type === 'boolean') return sql.Bit;
  return sql.NVarChar(field?.max ?? 255);
}

/**
 * Validates a create/update body against the table's `fields`.
 *
 * Only whitelisted columns are read, so a stray key cannot reach the SQL.
 * A missing key is left out of the result rather than set to NULL, so a
 * PATCH that only changes one field leaves the others alone.
 */
function parseValues(
  def: LookupDef,
  body: unknown,
):
  | { ok: true; values: Record<string, string | boolean> }
  | { ok: false; details: { path: string; message: string }[] } {
  const input = (body ?? {}) as Record<string, unknown>;
  const values: Record<string, string | boolean> = {};
  const details: { path: string; message: string }[] = [];

  for (const field of def.fields ?? []) {
    const raw = input[field.column];
    if (raw === undefined) continue;

    if (field.type === 'boolean') {
      if (typeof raw !== 'boolean') {
        details.push({ path: field.column, message: 'Must be true or false' });
        continue;
      }
      values[field.column] = raw;
      continue;
    }

    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
      if (field.required) {
        details.push({ path: field.column, message: `${field.label} is required` });
      } else {
        values[field.column] = null as unknown as string;
      }
      continue;
    }
    if (text.length > field.max) {
      details.push({
        path: field.column,
        message: `${field.label} must be ${field.max} characters or fewer`,
      });
      continue;
    }
    values[field.column] = text;
  }

  const required = (def.fields ?? []).filter((f) => f.required);
  for (const field of required) {
    if (values[field.column] === undefined) {
      details.push({ path: field.column, message: `${field.label} is required` });
    }
  }

  return details.length ? { ok: false, details } : { ok: true, values };
}
