/**
 * School Cash Online CSV parsing and matching.
 *
 * Pure functions only — no database, no Express. The matching rules are the
 * part of this feature most likely to be wrong in a way nobody notices until
 * a payment lands on the wrong registration, so they are isolated here and
 * unit-tested against the real Item Order Report.
 *
 * See docs/plans/school-cash-matching.md §3.2 and §11.2.
 */

/** The columns the matcher needs. Anything else in the file is ignored. */
export const REQUIRED_COLUMNS = [
  'Purchaser Email',
  'Item Name',
  'Item Id',
  'Paid Item Balance',
  'Paid Transaction Fee',
  'Purchased',
] as const;

export interface ScoCsvRow {
  rowNumber: number;
  purchaserEmail: string | null;
  purchaserName: string | null;
  recipientName: string | null;
  itemId: string | null;
  itemName: string | null;
  paidAmount: string | null;
  itemBalance: string | null;
  transactionFee: string | null;
  purchasedDate: string | null;
  owing: string | null;
  refunded: string | null;
  /** The whole line as an object, for the audit record. */
  raw: Record<string, string>;
}

export interface ParseResult {
  ok: boolean;
  /** Present when `ok` is false. */
  error?: string;
  /** Columns that were required but missing. */
  missing?: string[];
  rows: ScoCsvRow[];
}

/**
 * Splits one CSV line, honouring quoted fields and doubled quotes.
 *
 * Written by hand rather than pulled from a dependency: the file is a fixed
 * vendor export, and a 30-line parser is easier to reason about than a
 * library's edge-case behaviour.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }

  out.push(cur);
  return out;
}

/** Strips a UTF-8 BOM, which the vendor file carries on the first header. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Parses the Item Order Report.
 *
 * Returns `ok: false` with the missing column names when the header is not
 * the report we expect — better than importing 98 empty rows and leaving
 * someone to work out why nothing matched.
 */
export function parseScoCsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { ok: false, error: 'The file is empty.', rows: [] };

  const header = splitCsvLine(lines[0]!).map((h) => stripBom(h).trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));

  if (missing.length > 0) {
    return {
      ok: false,
      error: `This is not an Item Order Report — missing ${missing.join(', ')}.`,
      missing,
      rows: [],
    };
  }

  const col = (name: string) => header.indexOf(name);
  const get = (cells: string[], name: string): string | null => {
    const i = col(name);
    if (i < 0) return null;
    const v = cells[i]?.trim();
    return v === undefined || v === '' ? null : v;
  };

  const rows: ScoCsvRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]!);
    // A line with fewer cells than the header is a truncated row; skipping is
    // safer than importing a row whose columns have shifted.
    if (cells.length < header.length) continue;

    const raw: Record<string, string> = {};
    header.forEach((h, idx) => {
      raw[h] = cells[idx] ?? '';
    });

    rows.push({
      rowNumber: i,
      purchaserEmail: get(cells, 'Purchaser Email')?.toLowerCase() ?? null,
      purchaserName: get(cells, 'Purchaser Name'),
      recipientName: get(cells, 'Recipient Name'),
      itemId: get(cells, 'Item Id'),
      itemName: get(cells, 'Item Name'),
      paidAmount: get(cells, 'Paid Amount'),
      itemBalance: get(cells, 'Paid Item Balance'),
      transactionFee: get(cells, 'Paid Transaction Fee'),
      purchasedDate: get(cells, 'Purchased'),
      owing: get(cells, 'Owing'),
      refunded: get(cells, 'Refunded'),
      raw,
    });
  }

  return { ok: true, rows };
}

/** "$1,234.50" -> 1234.5. Returns null when the text is not a number. */
export function parseMoney(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalises a School Cash item name so it can be compared with a workshop
 * name.
 *
 * The vendor appends the session date to the item: "Early Childhood
 * Directors' Forum- 11/10/26, 2/23/27, 4/27/27", "(DPS) 10/1",
 * "Handwriting: The Building Blocks- 9/15/26". The workshop in this app is
 * named without it, so a straight comparison misses about a quarter of the
 * items.
 *
 * Only a trailing date is stripped — never words — so a name that genuinely
 * ends in a number is left alone.
 */
export function normaliseItemName(name: string | null): string {
  if (!name) return '';
  return name
    .replace(
      /[\s\-–—]*\d{1,2}\/\d{1,2}(\/\d{2,4})?(\s*,\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?)*\s*$/,
      '',
    )
    .replace(/[\s\-–—:,]+$/, '')
    .trim();
}

/** A stable identity for a vendor row, used to recognise a row that has
 * already been applied.
 *
 * The Item Order Report has no receipt number, payment id, or transaction id
 * — `ExternalId1` exists but is blank on every row. So identity has to be
 * derived from the row's own content: who bought it, which item, when, and
 * for how much.
 *
 * This matters because the exports are cumulative rather than incremental.
 * The 24 Nov file contained all 98 rows of the 15 Nov file plus 8 new ones,
 * so a cumulative re-upload must not pay the first 98 twice.
 *
 * `payments` is included because it carries the card type and date, which
 * distinguishes two genuinely separate purchases of the same item by the same
 * person on the same day.
 *
 * `occurrence` handles the remaining case: two rows can be identical in every
 * column, because someone really did buy the same item twice in one order.
 * Both files contain such pairs. Numbering the repeats keeps them distinct
 * without inventing data — the first occurrence is 0, the second 1, and so on.
 */
export function rowIdentity(f: {
  purchaserEmail: string | null;
  itemId: string | null;
  purchasedDate: string | null;
  itemBalance: string | null;
  paidAmount: string | null;
  payments: string | null;
  occurrence?: number;
}): string {
  return [
    (f.purchaserEmail ?? '').toLowerCase(),
    f.itemId ?? '',
    f.purchasedDate ?? '',
    f.itemBalance ?? '',
    f.paidAmount ?? '',
    f.payments ?? '',
    String(f.occurrence ?? 0),
  ].join('|');
}

/**
 * Assigns each row its identity, numbering exact repeats within a file.
 *
 * Numbering is per file and depends on row order, so it is only meaningful
 * for rows produced by the same export. That is sufficient: the question it
 * answers is "did this file's row already become a payment?", and the vendor
 * emits rows in a stable order.
 */
export function identitiesFor(rows: ScoCsvRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = rowIdentity({
      purchaserEmail: row.purchaserEmail,
      itemId: row.itemId,
      purchasedDate: row.purchasedDate,
      itemBalance: row.itemBalance,
      paidAmount: row.paidAmount,
      payments: row.raw['Payments'] ?? null,
    });
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}|${n}`;
  });
}

/** Identity for a parsed CSV row. */
export function identityOf(row: ScoCsvRow): string {
  return rowIdentity({
    purchaserEmail: row.purchaserEmail,
    itemId: row.itemId,
    purchasedDate: row.purchasedDate,
    itemBalance: row.itemBalance,
    paidAmount: row.paidAmount,
    payments: row.raw['Payments'] ?? null,
  });
}

/* ------------------------------------------------------------------ */
/*  Matching                                                           */
/* ------------------------------------------------------------------ */

export type MatchConfidence = 'High' | 'Low' | 'None' | 'Duplicate' | 'Ignored';
export type MatchMethod =
  | 'email'
  | 'email+amount'
  | 'email+workshop'
  | 'manual'
  | 'duplicate'
  | 'none';

/** A candidate registration the matcher may choose between. */
export interface MatchCandidate {
  registrationId: number;
  /** The amount still owed on this registration, for the amount rule. */
  owed: number | null;
  /**
   * When the registration was made, ISO `YYYY-MM-DD`. Used to break a tie
   * between candidates for the same workshop.
   */
  registeredOn?: string | null;
  /**
   * The name of the workshop this registration is for.
   *
   * This is what ties a payment to the right registration: a purchaser can
   * have several unpaid registrations, and the most recent one is often for a
   * different workshop entirely.
   */
  workshopName?: string | null;
}

export interface MatchInput {
  purchaserEmail: string | null;
  /** The item price — NOT the gross charge. See §11.2. */
  itemBalance: number | null;
  /**
   * The workshop the purchase is for, taken from the item name with the
   * vendor's date suffix stripped. Used to tie the payment to the right
   * registration.
   */
  itemName?: string | null;
  /** True when this vendor row has already been applied. */
  alreadyApplied: boolean;
  /**
   * When the School Cash purchase was made, ISO `YYYY-MM-DD`.
   *
   * Only registrations made on or before this date are considered: a payment
   * cannot be for a registration that did not exist yet. This is what keeps a
   * re-registration from stealing an older purchase's match.
   */
  purchasedOn?: string | null;
}

export interface MatchOutcome {
  confidence: MatchConfidence;
  method: MatchMethod;
  registrationId: number | null;
  note: string | null;
}

/** Drops candidates that did not exist when the purchase was made. */
function eligible(candidates: MatchCandidate[], purchasedOn?: string | null): MatchCandidate[] {
  if (!purchasedOn) return candidates;
  return candidates.filter((c) => !c.registeredOn || c.registeredOn <= purchasedOn);
}

/** Most recent first; undated registrations sort last. */
function byMostRecent(a: MatchCandidate, b: MatchCandidate): number {
  const da = a.registeredOn ?? '';
  const db = b.registeredOn ?? '';
  if (da === db) return b.registrationId - a.registrationId;
  return db.localeCompare(da);
}

/**
 * How closely two workshop names agree, 0 to 1.
 *
 * Deliberately crude and explainable rather than clever. The two sides come
 * from different systems — the vendor's item name and this app's workshop
 * name — so they differ in punctuation and wording ("Positive Solutions for
 * Families- The Power of Routines" against "Positive Solutions for
 * Families - The Power of Routines"). Comparing the sets of *distinctive*
 * words tolerates that without letting unrelated workshops match.
 *
 * Returns the Jaccard overlap of the distinctive words: shared words divided
 * by the union. "Sensory Processing Self Regulation" against itself is 1;
 * against "Early Childhood Directors Forum" is 0.
 *
 * Generic words are excluded first, so "Guided Observation of the Blended
 * Classroom" and "Guided Observation of the Demonstration Preschool" do not
 * look alike merely for sharing the words they have in common with a dozen
 * other workshops.
 */
export function nameSimilarity(a: string | null, b: string | null): number {
  const wa = distinctiveWords(a);
  const wb = distinctiveWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;

  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / (wa.size + wb.size - shared);
}

/**
 * A candidate counts as the same workshop when the names overlap this much.
 *
 * Chosen against the real export rather than guessed. Scoring every item name
 * against the workshop names in the database gives a clean separation: genuine
 * pairings score 1.00, and everything unrelated scores 0.40 or below. 0.6 sits
 * in that gap.
 *
 * 0.5 was tried first and was too loose — it paired "A Guided Observation of
 * the Blended Classroom (BC)" with "A Guided Observation of the Demonstration
 * Preschool Classroom (DPS)", two genuinely different workshops that share
 * most of their words.
 */
export const NAME_MATCH_THRESHOLD = 0.6;

/**
 * Words that appear in many workshop names and so cannot distinguish them.
 *
 * Without this, two different "Guided Observation" workshops look alike. The
 * similarity score is not enough on its own: it counts shared words, and
 * generic words are shared by unrelated workshops.
 */
const GENERIC_WORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'in', 'to', 'with', 'your',
  'guided', 'observation', 'full', 'center', 'classroom', 'classrooms',
  'workshop', 'session', 'sessions', 'series', 'part',
]);

/** The words that actually identify a workshop. */
function distinctiveWords(s: string | null): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !GENERIC_WORDS.has(w)),
  );
}

/**
 * Applies the matching rules in order. The first rule that produces exactly
 * one candidate wins.
 *
 * `candidates` is every unpaid registration belonging to the participant who
 * owns `purchaserEmail` — the caller resolves the email, because that needs a
 * database and this function must stay pure.
 *
 * The rules, in order:
 *
 *  1. Only one eligible candidate — match it.
 *  2. Several, but the item price matches exactly one — match that.
 *  3. Several, but exactly one is for the same workshop — match that.
 *  4. Several for the same workshop — take the most recent of those.
 *  5. Otherwise a human decides.
 *
 * Rule 3 is the important one. A purchaser often has several unpaid
 * registrations, and the newest is frequently for a different workshop
 * entirely, so recency alone would pay the wrong one. The workshop name is
 * what actually ties a payment to a registration; recency only breaks a tie
 * between candidates for the same workshop.
 */
export function matchRow(input: MatchInput, candidates: MatchCandidate[]): MatchOutcome {
  if (input.alreadyApplied) {
    return { confidence: 'Duplicate', method: 'duplicate', registrationId: null, note: 'Already applied in an earlier upload.' };
  }

  if (!input.purchaserEmail) {
    return { confidence: 'None', method: 'none', registrationId: null, note: 'No purchaser email on this row.' };
  }

  if (candidates.length === 0) {
    return { confidence: 'None', method: 'none', registrationId: null, note: 'No unpaid registration for this purchaser.' };
  }

  const pool = eligible(candidates, input.purchasedOn);

  if (pool.length === 0) {
    return {
      confidence: 'None',
      method: 'none',
      registrationId: null,
      note: 'Every unpaid registration was made after this purchase.',
    };
  }

  // Rule 1: exactly one eligible candidate — nothing to choose between.
  if (pool.length === 1) {
    return { confidence: 'High', method: 'email', registrationId: pool[0]!.registrationId, note: null };
  }

  // Rule 2: several candidates, but the item price matches exactly one.
  // Compared against the item balance, not the gross charge — a $312 charge
  // against a $300 registration would match nothing.
  if (input.itemBalance !== null) {
    const byAmount = pool.filter(
      (c) => c.owed !== null && Math.abs(c.owed - input.itemBalance!) < 0.005,
    );
    if (byAmount.length === 1) {
      return {
        confidence: 'High',
        method: 'email+amount',
        registrationId: byAmount[0]!.registrationId,
        note: `${pool.length} unpaid registrations; the amount picked this one.`,
      };
    }
  }

  // Rule 3: narrow to the same workshop before considering recency.
  //
  // Scored rather than merely filtered: an item can clear the threshold
  // against more than one workshop ("A Guided Observation of the Demonstration
  // Preschool Classroom (DPS)" scores 1.00 against its own name and 0.67
  // against "A Full Center Guided Observation in the Demonstration
  // Preschool"). Only the best-scoring workshop is considered, so the exact
  // match cannot be beaten by a near one.
  const scored = pool
    .map((c) => ({ c, score: nameSimilarity(input.itemName ?? null, c.workshopName ?? null) }))
    .filter((x) => x.score >= NAME_MATCH_THRESHOLD);

  if (scored.length > 0) {
    const best = Math.max(...scored.map((x) => x.score));
    const sameWorkshop = scored.filter((x) => x.score === best).map((x) => x.c);

    if (sameWorkshop.length === 1) {
      return {
        confidence: 'High',
        method: 'email+workshop',
        registrationId: sameWorkshop[0]!.registrationId,
        note: `${pool.length} unpaid registrations; only one is for this workshop.`,
      };
    }

    // Rule 4: several for the same workshop — the most recent of those wins.
    const sorted = [...sameWorkshop].sort(byMostRecent);
    return {
      confidence: 'High',
      method: 'email+workshop',
      registrationId: sorted[0]!.registrationId,
      note: `${sameWorkshop.length} registrations for this workshop; the most recent was picked.`,
    };
  }

  // Rule 5: a human decides.
  return {
    confidence: 'Low',
    method: 'email',
    registrationId: null,
    note: `${pool.length} unpaid registrations, none for this workshop.`,
  };
}
