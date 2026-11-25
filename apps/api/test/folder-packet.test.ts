import { describe, expect, it } from 'vitest';
import {
  SECTION_ORDER,
  buildSections,
  formatPacketDate,
  renderPacketHtml,
  sectionPageCount,
  tidyTime,
} from '../src/services/folder-packet.js';
import type { PacketDetail, PacketRosterRow, PacketSectionKind } from '@pe/shared';

/**
 * Folder packet layout.
 *
 * The page arithmetic is what the contents panel and every printed footer
 * quote, so an error here tells staff to look on the wrong sheet. These tests
 * pin the numbers rather than the markup.
 */

function rosterOf(n: number): PacketRosterRow[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    name: `Person ${i + 1}`,
    agency: null,
    email: null,
    credit: null,
    attended: null,
  }));
}

function detailFor(participantCount: number): PacketDetail {
  const sections = buildSections(SECTION_ORDER, {
    participantCount,
    rosterEmpty: participantCount === 0,
    hasNotes: false,
  });
  return {
    workshop: {
      workshopId: 1,
      workshopCode: 'PVB2737',
      workshopName: 'Guided Observation',
      schoolYear: '2026-27',
      dateText: 'Thursday, April 8, 2027',
      timeText: '6:30 – 8:00 PM',
      room: null,
      presenterNames: [],
      participantCount,
      rosterEmpty: participantCount === 0,
    },
    sections,
    roster: rosterOf(participantCount),
    printSetup: { paper: 'Letter', orientation: 'Portrait', margin: 0.5, copies: 2 },
    pageCount: sections.reduce((n, s) => n + (s.endPage - s.startPage + 1), 0),
    warnings: [],
  };
}

describe('sectionPageCount', () => {
  it('fits 15 roster rows on a page', () => {
    expect(sectionPageCount('roster', 15)).toBe(1);
    expect(sectionPageCount('roster', 16)).toBe(2);
    expect(sectionPageCount('roster', 38)).toBe(3);
  });

  it('gives an empty roster one page rather than none', () => {
    // A workshop with no registrations still needs a sheet saying so; zero
    // pages would make the contents list skip it.
    expect(sectionPageCount('roster', 0)).toBe(1);
  });

  it('keeps the slips to a single sheet', () => {
    for (const kind of ['attendance', 'eval-teacher', 'banner'] as PacketSectionKind[]) {
      expect(sectionPageCount(kind, 200)).toBe(1);
    }
  });
});

describe('buildSections', () => {
  it('numbers every section consecutively from page 1', () => {
    const sections = buildSections(SECTION_ORDER, {
      participantCount: 38,
      rosterEmpty: false,
      hasNotes: false,
    });

    expect(sections[0]).toMatchObject({ kind: 'roster', startPage: 1, endPage: 3 });
    for (let i = 1; i < sections.length; i += 1) {
      expect(sections[i]!.startPage).toBe(sections[i - 1]!.endPage + 1);
    }
  });

  it('reproduces the mockup packet for 38 participants', () => {
    // The mockup's contents panel: roster 1–2 at 15 rows/page would be 3, and
    // the mockup shows 13 pages with the roster spanning 1–3.
    const sections = buildSections(SECTION_ORDER, {
      participantCount: 38,
      rosterEmpty: false,
      hasNotes: false,
    });
    const total = sections.reduce((n, s) => n + (s.endPage - s.startPage + 1), 0);
    expect(total).toBe(13);
    expect(sections.find((s) => s.kind === 'codification')!.endPage).toBe(13);
  });

  it('marks an empty roster and empty notes as unfilled, with a reason', () => {
    const sections = buildSections(SECTION_ORDER, {
      participantCount: 0,
      rosterEmpty: true,
      hasNotes: false,
    });
    expect(sections.find((s) => s.kind === 'roster')).toMatchObject({
      filled: false,
      note: 'No participants registered yet',
    });
    expect(sections.find((s) => s.kind === 'instructor-notes')!.filled).toBe(false);
  });

  it('renumbers when a section is left out', () => {
    const without = SECTION_ORDER.filter((k) => k !== 'banner');
    const sections = buildSections(without, {
      participantCount: 38,
      rosterEmpty: false,
      hasNotes: true,
    });
    const total = sections.reduce((n, s) => n + (s.endPage - s.startPage + 1), 0);
    expect(total).toBe(12);
    expect(sections.some((s) => s.kind === 'banner')).toBe(false);
  });
});

describe('renderPacketHtml', () => {
  it('renders exactly as many sheets as the contents list promises', () => {
    // The two must never disagree: the footer says "Page 4 of 13" and the
    // panel says "p. 4", and both come from this count.
    const detail = detailFor(38);
    const html = renderPacketHtml(
      { detail, sections: SECTION_ORDER, notes: null },
      false,
    );
    const rendered = (html.match(/<section class="pk-page/g) ?? []).length;
    expect(rendered).toBe(detail.pageCount);
  });

  it('paginates the contact list the same way as the roster', () => {
    const detail = detailFor(38);
    const html = renderPacketHtml(
      { detail, sections: ['contact-list'], notes: null },
      false,
    );
    const rendered = (html.match(/<section class="pk-page/g) ?? []).length;
    expect(rendered).toBe(3);
  });

  it('escapes workshop names rather than emitting raw markup', () => {
    const detail = detailFor(1);
    detail.workshop.workshopName = 'Taming the "No!" Phase <script>alert(1)</script>';
    const html = renderPacketHtml({ detail, sections: ['roster'], notes: null }, false);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('applies the print setup to the page size', () => {
    const detail = detailFor(1);
    detail.printSetup = { paper: 'Legal', orientation: 'Landscape', margin: 0.75, copies: 1 };
    const html = renderPacketHtml({ detail, sections: ['roster'], notes: null }, false);
    expect(html).toContain('size: 14in 8.5in');
    expect(html).toContain('padding: 0.75in');
  });
});

describe('formatPacketDate', () => {
  it('spells out the weekday for the packet header', () => {
    expect(formatPacketDate('2027-04-08', null)).toBe('Thursday, April 8, 2027');
  });

  it('falls back to the stored text when there is no date', () => {
    expect(formatPacketDate(null, 'April 8')).toBe('April 8');
    expect(formatPacketDate(null, null)).toBeNull();
  });
});

describe('tidyTime', () => {
  it('normalises the dash the database stores', () => {
    expect(tidyTime('8:50 AM- 10:50 AM')).toBe('8:50 AM – 10:50 AM');
  });

  it('passes null through', () => {
    expect(tidyTime(null)).toBeNull();
  });
});
