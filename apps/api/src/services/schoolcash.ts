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
}

export interface MatchInput {
  purchaserEmail: string | null;
  /** The item price — NOT the gross charge. See §11.2. */
  itemBalance: number | null;
  /** True when this vendor row has already been applied. */
  alreadyApplied: boolean;
}

export interface MatchOutcome {
  confidence: MatchConfidence;
  method: MatchMethod;
  registrationId: number | null;
  note: string | null;
}

/**
 * Applies the five rules from §3.2, in order. The first rule that produces
 * exactly one candidate wins.
 *
 * `candidates` is every unpaid registration belonging to the participant who
 * owns `purchaserEmail` — the caller resolves the email, because that needs a
 * database and this function must stay pure.
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

  // Rule 1: exactly one candidate — nothing to choose between.
  if (candidates.length === 1) {
    return { confidence: 'High', method: 'email', registrationId: candidates[0]!.registrationId, note: null };
  }

  // Rule 2: several candidates, but the item price matches exactly one.
  // Compared against the item balance, not the gross charge — a $312 charge
  // against a $300 registration would match nothing.
  if (input.itemBalance !== null) {
    const byAmount = candidates.filter(
      (c) => c.owed !== null && Math.abs(c.owed - input.itemBalance!) < 0.005,
    );
    if (byAmount.length === 1) {
      return {
        confidence: 'High',
        method: 'email+amount',
        registrationId: byAmount[0]!.registrationId,
        note: `${candidates.length} unpaid registrations; the amount picked this one.`,
      };
    }
  }

  // Rule 3: several candidates and the amount does not settle it.
  return {
    confidence: 'Low',
    method: 'email',
    registrationId: null,
    note: `${candidates.length} unpaid registrations, none matching the amount.`,
  };
}
