import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseScoCsv,
  parseMoney,
  splitCsvLine,
  matchRow,
  rowIdentity,
  identitiesFor,
  REQUIRED_COLUMNS,
  type MatchCandidate,
} from '../src/services/schoolcash.js';

/**
 * School Cash parsing and matching. Pure, so these run without a database —
 * which matters because the matching rules are the part most likely to be
 * wrong in a way nobody notices until a payment lands on the wrong
 * registration.
 */

const FIXTURE = path.resolve(__dirname, '../../../database/ItemOrderReport_1793719554413.csv');
const OLD_FIXTURE = FIXTURE;
const NEW_FIXTURE = path.resolve(__dirname, '../../../database/ItemOrderReport_1795535397115.csv');

describe('splitCsvLine', () => {
  it('splits plain fields', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps commas inside quotes', () => {
    expect(splitCsvLine('"Barber, Bria",x')).toEqual(['Barber, Bria', 'x']);
  });

  it('handles doubled quotes', () => {
    expect(splitCsvLine('"say ""hi""",b')).toEqual(['say "hi"', 'b']);
  });

  it('keeps empty fields, which carry meaning in this file', () => {
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('parseMoney', () => {
  it('parses the vendor format', () => {
    expect(parseMoney('$312.00')).toBe(312);
    expect(parseMoney('$1,234.50')).toBe(1234.5);
    expect(parseMoney('$0.00')).toBe(0);
    expect(parseMoney('-12.00')).toBe(-12);
  });

  it('returns null for blanks and non-numbers', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney('n/a')).toBeNull();
  });
});

describe('parseScoCsv', () => {
  it('parses the real Item Order Report', () => {
    const text = fs.readFileSync(FIXTURE, 'utf8');
    const result = parseScoCsv(text);

    expect(result.ok).toBe(true);
    expect(result.rows.length).toBeGreaterThan(90);

    const first = result.rows[0]!;
    expect(first.purchaserEmail).toBe('bria@appleseedspreschool.org');
    expect(first.itemName).toContain('Appleseeds');
    expect(parseMoney(first.itemBalance)).toBe(300);
    expect(parseMoney(first.transactionFee)).toBe(12);
    expect(parseMoney(first.paidAmount)).toBe(312);
  });

  it('strips the BOM from the first header so the first column still matches', () => {
    const text = fs.readFileSync(FIXTURE, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const result = parseScoCsv(text);
    expect(result.ok).toBe(true);
    // The first column is "School Year"; a stale BOM would make it "\uFEFFSchool Year".
    expect(Object.keys(result.rows[0]!.raw)).toContain('School Year');
  });

  it('normalises the purchaser email to lower case', () => {
    const csv = [
      REQUIRED_COLUMNS.join(','),
      'Bria@Example.ORG,Item,1,$300.00,$12.00,09/15/2026',
    ].join('\n');
    const result = parseScoCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.rows[0]!.purchaserEmail).toBe('bria@example.org');
  });

  it('rejects a file that is not an Item Order Report, naming what is missing', () => {
    const result = parseScoCsv('foo,bar\n1,2');
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('Purchaser Email');
    expect(result.missing).toContain('Item Name');
    expect(result.rows).toEqual([]);
  });

  it('rejects an empty file', () => {
    expect(parseScoCsv('').ok).toBe(false);
  });

  it('accepts a file with extra columns present', () => {
    const csv = [
      `${REQUIRED_COLUMNS.join(',')},Student Number,Grade`,
      'a@b.org,Item,1,$10.00,$0.40,09/15/2026,,',
    ].join('\n');
    const result = parseScoCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
  });
});

describe('matchRow', () => {
  const one: MatchCandidate[] = [{ registrationId: 11, owed: 300 }];
  const two: MatchCandidate[] = [
    { registrationId: 21, owed: 300 },
    { registrationId: 22, owed: 100 },
  ];
  const twoSame: MatchCandidate[] = [
    { registrationId: 31, owed: 300 },
    { registrationId: 32, owed: 300 },
  ];

  it('rule 1: one candidate is high confidence by email', () => {
    const r = matchRow({ purchaserEmail: 'a@b.org', itemBalance: 300, alreadyApplied: false }, one);
    expect(r).toMatchObject({ confidence: 'High', method: 'email', registrationId: 11 });
  });

  it('rule 2: several candidates resolved by the item balance', () => {
    const r = matchRow({ purchaserEmail: 'a@b.org', itemBalance: 300, alreadyApplied: false }, two);
    expect(r).toMatchObject({ confidence: 'High', method: 'email+amount', registrationId: 21 });
  });

  it('rule 2 uses the item balance, not the gross charge', () => {
    // The real row is $312 charged for a $300 item. Matching on 312 would
    // find nothing; matching on the balance finds the $300 registration.
    const r = matchRow({ purchaserEmail: 'a@b.org', itemBalance: 300, alreadyApplied: false }, two);
    expect(r.registrationId).toBe(21);

    const gross = matchRow({ purchaserEmail: 'a@b.org', itemBalance: 312, alreadyApplied: false }, two);
    expect(gross.confidence).toBe('Low');
    expect(gross.registrationId).toBeNull();
  });

  it('rule 3: several candidates and the amount does not settle it', () => {
    const r = matchRow({ purchaserEmail: 'a@b.org', itemBalance: 450, alreadyApplied: false }, two);
    expect(r).toMatchObject({ confidence: 'Low', registrationId: null });
  });

  it('rule 3: two candidates at the same amount are ambiguous, not a coin flip', () => {
    const r = matchRow({ purchaserEmail: 'a@b.org', itemBalance: 300, alreadyApplied: false }, twoSame);
    expect(r).toMatchObject({ confidence: 'Low', registrationId: null });
  });

  it('rule 4: an email with no participant matches nothing', () => {
    const r = matchRow({ purchaserEmail: 'nobody@example.org', itemBalance: 300, alreadyApplied: false }, []);
    expect(r).toMatchObject({ confidence: 'None', registrationId: null });
  });

  it('a participant with no unpaid registration is "None", not a failure', () => {
    const r = matchRow({ purchaserEmail: 'a@b.org', itemBalance: 300, alreadyApplied: false }, []);
    expect(r.confidence).toBe('None');
    expect(r.note).toContain('No unpaid registration');
  });

  it('rule 5: an already-applied row is a duplicate regardless of candidates', () => {
    const r = matchRow({ purchaserEmail: 'a@b.org', itemBalance: 300, alreadyApplied: true }, one);
    expect(r).toMatchObject({ confidence: 'Duplicate', registrationId: null });
  });

  it('a row with no purchaser email cannot match', () => {
    const r = matchRow({ purchaserEmail: null, itemBalance: 300, alreadyApplied: false }, one);
    expect(r).toMatchObject({ confidence: 'None', registrationId: null });
  });

  it('tolerates a candidate with no known owed amount', () => {
    const r = matchRow(
      { purchaserEmail: 'a@b.org', itemBalance: 300, alreadyApplied: false },
      [{ registrationId: 41, owed: null }, { registrationId: 42, owed: 100 }],
    );
    expect(r.confidence).toBe('Low');
  });
});

/**
 * Row identity is what stops a cumulative re-upload paying the same purchase
 * twice. The vendor export carries no receipt or payment id — `ExternalId1`
 * is blank on every row — so identity has to come from the row's content.
 */
describe('rowIdentity', () => {
  const base = {
    purchaserEmail: 'bria@example.org',
    itemId: '48692',
    purchasedDate: '09/15/2026',
    itemBalance: '$300.00',
    paidAmount: '$312.00',
    payments: '$312.00 - CreditCard (Online) - 09/15/26',
  };

  it('is stable for the same purchase', () => {
    expect(rowIdentity(base)).toBe(rowIdentity({ ...base }));
  });

  it('ignores email case, which varies between exports', () => {
    expect(rowIdentity({ ...base, purchaserEmail: 'BRIA@Example.ORG' })).toBe(rowIdentity(base));
  });

  it('separates different items', () => {
    expect(rowIdentity({ ...base, itemId: '99999' })).not.toBe(rowIdentity(base));
  });

  it('separates different purchase dates', () => {
    expect(rowIdentity({ ...base, purchasedDate: '09/16/2026' })).not.toBe(rowIdentity(base));
  });

  it('separates two purchases of the same item on the same day by the payment line', () => {
    const second = { ...base, payments: '$312.00 - CreditCard (Online) - 09/15/26 (2)' };
    expect(rowIdentity(second)).not.toBe(rowIdentity(base));
  });

  it('tolerates nulls without collapsing distinct rows', () => {
    const a = rowIdentity({ ...base, purchaserEmail: null });
    const b = rowIdentity({ ...base, purchaserEmail: '' });
    expect(a).toBe(b);
    expect(a).not.toBe(rowIdentity(base));
  });

  it('produces the same identity from both real exports for shared rows', () => {
    // The 24 Nov file is the 15 Nov file plus 8 rows. Every row they share
    // must hash identically, or a re-upload would pay those rows again.
    const oldRows = parseScoCsv(fs.readFileSync(OLD_FIXTURE, 'utf8')).rows;
    const newRows = parseScoCsv(fs.readFileSync(NEW_FIXTURE, 'utf8')).rows;

    const oldIds = identitiesFor(oldRows);
    const newIds = new Set(identitiesFor(newRows));
    const shared = oldIds.filter((id) => newIds.has(id));

    expect(oldRows).toHaveLength(98);
    expect(newRows).toHaveLength(106);
    // Every one of the 98 earlier rows is recognised in the later export.
    expect(shared).toHaveLength(98);
  });

  it('numbers exact repeats so two identical purchases stay distinct', () => {
    // Both files contain rows identical in every column: someone bought the
    // same item twice in one order. Collapsing them would silently drop a
    // payment.
    const rows = parseScoCsv(fs.readFileSync(OLD_FIXTURE, 'utf8')).rows;
    const ids = identitiesFor(rows);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
