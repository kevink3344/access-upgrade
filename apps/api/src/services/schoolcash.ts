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
export type MatchMethod = 'email' | 'email+amount' | 'manual' | 'duplicate' | 'none';

/** A candidate registration the matcher may choose between. */
export interface MatchCandidate {
  registrationId: number;
  /** The amount still owed on this registration, for the amount rule. */
  owed: number | null;
  /** When the registration was made, ISO `YYYY-MM-DD`. */
  registeredOn?: string | null;
  /** How much has already been paid against this registration. */
  paidAmount?: number | null;
  /** The registration's own paid date, ISO `YYYY-MM-DD`. */
  paidOn?: string | null;
}

export interface MatchInput {
  purchaserEmail: string | null;
  /** The item price — NOT the gross charge. See §11.2. */
  itemBalance: number | null;
  /** True when this vendor row has already been applied. */
  alreadyApplied: boolean;
  /**
   * When the School Cash purchase was made, ISO `YYYY-MM-DD`.
   *
   * Only registrations made on or before this date are considered: a payment
   * cannot be for a registration that did not exist yet.
   */
  purchasedOn?: string | null;
  /**
   * Whether the purchaser is enrolled in the resolved workshop at all —
   * paid or not. Counted by the caller, which can see every registration.
   *
   * This is what separates "we cannot find this person" from "this person is
   * enrolled and their place is already paid for". Without it a fully paid
   * workshop looked identical to one nobody had signed up for, and the two
   * were reported as the same thing.
   */
  enrolledInWorkshop?: boolean;
}

export interface MatchOutcome {
  confidence: MatchConfidence;
  method: MatchMethod;
  registrationId: number | null;
  note: string | null;
  /**
   * The match is real but the place is already paid for, so applying must not
   * write a payment. Only set on the already-enrolled case above.
   */
  alreadyPaid?: boolean;
}

/** Drops candidates that did not exist when the purchase was made. */
function eligible(candidates: MatchCandidate[], purchasedOn?: string | null): MatchCandidate[] {
  if (!purchasedOn) return candidates;
  return candidates.filter((c) => !c.registeredOn || c.registeredOn <= purchasedOn);
}

/**
 * A workshop an item could resolve to, with a score for how well it fits.
 *
 * Resolution happens once per distinct item, before any payment is matched.
 * That ordering matters: the vendor's item name and this app's workshop name
 * are different vocabularies, so deciding the workshop first — with a human
 * confirming — is the only way to keep payments off the wrong workshop.
 */
export interface WorkshopOption {
  workshopId: number;
  workshopName: string;
  workshopCode: string | null;
  startDate: string | null;
  price: number | null;
  score: number;
}

/**
 * What kind of thing an item name refers to.
 *
 * School Cash sells more than workshops. A site books a whole day as
 * "<Site> - Group Registration", and a workshop offers "<Workshop> -
 * Classroom Discount" to a second teacher from the same school. Neither is a
 * workshop, so neither can ever resolve to one — but they arrive in the same
 * file and, without a label, sit in the review queue looking like items
 * nobody has got round to yet.
 *
 * The label is advisory. It does not stop an admin resolving the item by
 * hand; it tells them what they are looking at, and lets the screen separate
 * "needs a workshop chosen" from "this is a booking, not a workshop".
 */
export type ItemKind = 'Workshop' | 'SiteBooking' | 'Discount';

const SITE_BOOKING = /\bgroup\s+registration\b/i;
const DISCOUNT = /\bdiscount\b/i;

export function classifyItem(name: string | null): ItemKind {
  if (!name) return 'Workshop';
  if (SITE_BOOKING.test(name)) return 'SiteBooking';
  if (DISCOUNT.test(name)) return 'Discount';
  return 'Workshop';
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

  // Two site bookings are "<Site> - Group Registration". Once "group" and
  // "registration" are generic, the only word left is the site name, and two
  // different sites still share "preschool" — enough to clear the 0.25
  // suggestion threshold and offer one school's booking as a match for
  // another's. A booking only ever matches its own site, so require the site
  // names to be equal.
  if (classifyItem(a) === 'SiteBooking' && classifyItem(b) === 'SiteBooking') {
    const siteOf = (s: string) =>
      s.replace(SITE_BOOKING, '').replace(/[\s\-–—:,()]+$/g, '').trim().toLowerCase();
    return siteOf(a!) === siteOf(b!) ? 1 : 0;
  }

  return shared / (wa.size + wb.size - shared);
}

/**
 * The score at which an item is considered to *be* a workshop, rather than
 * merely similar to one.
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
 * The score at which a workshop is worth *suggesting* to an admin.
 *
 * Lower than the auto-match threshold on purpose: a suggestion costs nothing
 * because a human confirms it, and a near miss shown as the default saves
 * them finding it by hand.
 */
export const SUGGESTION_THRESHOLD = 0.25;

/** Picks the workshop an item most likely refers to, if any is close enough. */
export function bestWorkshop(
  itemName: string | null,
  options: Omit<WorkshopOption, 'score'>[],
): WorkshopOption | null {
  // A site booking is a school buying a day, not a workshop. Offering the
  // closest workshop name as a "suggestion" invites someone to confirm a
  // match that does not exist, so nothing is suggested for one.
  if (classifyItem(itemName) === 'SiteBooking') return null;

  let best: WorkshopOption | null = null;
  for (const o of options) {
    const score = nameSimilarity(itemName, o.workshopName);
    if (score >= SUGGESTION_THRESHOLD && (!best || score > best.score)) {
      best = { ...o, score };
    }
  }
  return best;
}

/**
 * Words that appear in many workshop names and so cannot distinguish them.
 *
 * Without this, two different "Guided Observation" workshops look alike. The
 * similarity score is not enough on its own: it counts shared words, and
 * generic words are shared by unrelated workshops.
 *
 * `group` and `registration` belong here for the same reason. School Cash
 * sells site bookings as "<Site> - Group Registration" and discounts as
 * "<Workshop> - Classroom Discount", so an item name is often a *site* plus
 * one of these words. No workshop is named that way — the only one in the
 * database is "Soapstone Preschool- Group Registration" — yet the word
 * "group" alone is shared with 34 unrelated workshops ("PAT Group Meeting",
 * "TLC Study Group", "Triple P Group"). Leaving it distinctive paired
 * "Arts Together- Group Registration" with "A Guided Observation Group
 * Follow Up" at 0.50. With it generic, a site booking has no workshop to
 * match and correctly waits for a human.
 */
const GENERIC_WORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'in', 'to', 'with', 'your',
  'guided', 'observation', 'full', 'center', 'classroom', 'classrooms',
  'workshop', 'session', 'sessions', 'series', 'part',
  'group', 'registration', 'discount',
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
 * Applies the matching rules in order, within the resolved workshop.
 *
 * `candidates` is every unpaid registration belonging to the participant who
 * owns `purchaserEmail` — the caller resolves the email, because that needs a
 * database and this function must stay pure.
 *
 * The workshop is no longer a tiebreaker. An earlier version matched on "one
 * candidate" or "the amount matches", then fell back to recency, and produced
 * payments against workshops from 2011 because nothing tied the payment to the
 * right workshop. Now the caller passes only candidates for the workshop the
 * upload resolved, and:
 *
 *  1. No candidates for that workshop — a human decides.
 *  2. Exactly one — match it.
 *  3. Several, but the amount picks one — match that.
 *  4. Several and the amount does not settle it — a human decides.
 *
 * Recency is deliberately not used. Two unpaid registrations for the same
 * workshop are rare, and picking the newer one silently would hide a real
 * ambiguity rather than surface it.
 *
 * One case outranks all of these: the purchaser is enrolled in the workshop
 * and their place is already paid for. That is a match, not a miss — the
 * person is accounted for, and the payment simply arrived another way. It is
 * reported as High so the record reflects reality, but with `alreadyPaid` set
 * so the caller never writes a second payment for it.
 */
export function matchRow(input: MatchInput, candidates: MatchCandidate[]): MatchOutcome {
  if (input.alreadyApplied) {
    return { confidence: 'Duplicate', method: 'duplicate', registrationId: null, note: 'Already applied in an earlier upload.' };
  }

  if (!input.purchaserEmail) {
    return { confidence: 'None', method: 'none', registrationId: null, note: 'No purchaser email on this row.' };
  }

  // The purchaser already holds a paid place on this workshop. The registration
  // is theirs; the money is already on it. Matched, nothing to collect.
  if (input.enrolledInWorkshop) {
    const paid = candidates.find((c) => (c.paidAmount ?? 0) > 0);
    if (paid) {
      return {
        confidence: 'High',
        method: 'email',
        registrationId: paid.registrationId,
        // No note: the file lists people who have paid, so saying so on every
        // row is noise. `alreadyPaid` is what keeps it out of the apply run.
        note: null,
        alreadyPaid: true,
      };
    }
  }

  if (candidates.length === 0) {
    return {
      confidence: 'None',
      method: 'none',
      registrationId: null,
      note: 'No unpaid registration for this workshop.',
    };
  }

  const pool = eligible(candidates, input.purchasedOn);

  if (pool.length === 0) {
    return {
      confidence: 'None',
      method: 'none',
      registrationId: null,
      note: 'Every unpaid registration for this workshop was made after this purchase.',
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

  // Rule 3: several and the amount does not settle it — a human decides.
  return {
    confidence: 'Low',
    method: 'email',
    registrationId: null,
    note: `${pool.length} unpaid registrations for this workshop, none matching the amount.`,
  };
}
