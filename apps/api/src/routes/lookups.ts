import { Router } from 'express';
import { query, sql } from '../db.js';
import { requireAuth } from '../auth/middleware.js';

export const lookupsRouter = Router();

/**
 * Whitelist of lookup tables exposed by the generic endpoint. Adding a
 * lookup means adding one entry here — no new route, no new SQL.
 * `key` is the URL segment; `table` is the real object.
 */
const LOOKUPS: Record<
  string,
  {
    table: string;
    idColumn: string;
    labelColumn: string;
    orderBy?: string;
    /** Extra columns appended to the id/label pair, aliased to these names. */
    extraColumns?: Record<string, string>;
  }
> = {
  'agency-types': { table: 'ref.AgencyType', idColumn: 'AgencyTypeID', labelColumn: 'TypeName' },
  ages: { table: 'ref.Age', idColumn: 'AgesID', labelColumn: 'Ages' },
  'backup-times': { table: 'ref.BackupTime', idColumn: 'BackupTimeID', labelColumn: 'BackupTime' },
  categories: { table: 'ref.Category', idColumn: 'CategoryID', labelColumn: 'CategoryCode' },
  cities: { table: 'ref.City', idColumn: 'CityID', labelColumn: 'City' },
  components: { table: 'ref.Component', idColumn: 'ComponentID', labelColumn: 'PrEComponent' },
  'contact-types': { table: 'ref.ContactType', idColumn: 'ContactTypeID', labelColumn: 'ContactType' },
  counties: { table: 'ref.County', idColumn: 'CountyID', labelColumn: 'County' },
  'credit-slip-categories': {
    table: 'ref.CreditSlipCategory',
    idColumn: 'CreditSlipsCategoryID',
    labelColumn: 'CreditSlipsCategory',
  },
  'credit-types': { table: 'ref.CreditType', idColumn: 'CreditTypeID', labelColumn: 'CreditCode' },
  'desired-topic-categories': {
    table: 'ref.DesiredTopicCategory',
    idColumn: 'DesiredTopicCategoryID',
    labelColumn: 'DesiredTopicCategory',
  },
  equipment: { table: 'ref.Equipment', idColumn: 'EquipmentID', labelColumn: 'Equipment' },
  'eval-question-types': {
    table: 'ref.EvalQuestionType',
    idColumn: 'EvalQuestTypeID',
    labelColumn: 'EvalQuestType',
  },
  'eval-types': { table: 'ref.EvalType', idColumn: 'EvalTypeID', labelColumn: 'WorkshopType' },
  'event-types': { table: 'ref.EventType', idColumn: 'EventTypeID', labelColumn: 'EventType' },
  'facility-types': {
    table: 'ref.FacilityType',
    idColumn: 'FacilityTypeID',
    labelColumn: 'FacilityType',
  },
  'mailing-lists': { table: 'ref.MailingList', idColumn: 'MailingListID', labelColumn: 'MailingList' },
  others: { table: 'ref.Other', idColumn: 'OtherID', labelColumn: 'OtherNickname' },
  'payment-methods': {
    table: 'ref.PaymentMethod',
    idColumn: 'PaymentMethodID',
    labelColumn: 'PaymentMethod',
  },
  'preferred-times': {
    table: 'ref.PreferredTime',
    idColumn: 'PreferredTimesID',
    labelColumn: 'PreferredTimes',
  },
  'referral-types': {
    table: 'ref.ReferralType',
    idColumn: 'ReferralTypeID',
    labelColumn: 'ReferralType',
  },
  regions: { table: 'ref.Region', idColumn: 'RegionID', labelColumn: 'Region' },
  salutations: { table: 'ref.Salutation', idColumn: 'SalutationID', labelColumn: 'Salutation' },
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
  },
  states: { table: 'ref.State', idColumn: 'StateID', labelColumn: 'State' },
  'street-types': {
    table: 'ref.StreetType',
    idColumn: 'StreetTypeID',
    labelColumn: 'StreetTypeName',
  },
  'summary-count-types': {
    table: 'ref.SummaryCountType',
    idColumn: 'SummaryCountTypeID',
    labelColumn: 'CountType',
  },
};

/**
 * @openapi
 * /api/lookups:
 *   get:
 *     tags: [Lookups]
 *     summary: List available lookup tables
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Lookup keys
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { type: string } }
 */
lookupsRouter.get('/', requireAuth, (_req, res) => {
  res.json({ data: Object.keys(LOOKUPS).sort() });
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
    const result = await query(
      `SELECT ${def.idColumn} AS id, ${def.labelColumn} AS label${extras}
         FROM ${def.table}
        ORDER BY ${orderBy}`,
    );

    res.json({ data: result.recordset });
  } catch (err) {
    next(err);
  }
});

/** Exposed so other routers can validate lookup keys. */
export function isKnownLookup(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOOKUPS, name);
}

export { LOOKUPS };
