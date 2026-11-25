import type {
  PacketDetail,
  PacketPrintSetup,
  PacketRosterRow,
  PacketSectionKind,
  PacketWorkshop,
} from '@pe/shared';

/**
 * A workshop folder packet, rendered as HTML.
 *
 * One template backs both the on-screen preview and the PDF, for the same
 * reason the certificate does: what staff approve on screen has to be what
 * prints. The preview embeds this document in an iframe, the PDF hands it to
 * Chromium — neither can diverge.
 *
 * Page structure is expressed with CSS `@page` and explicit page breaks
 * rather than by measuring content in JavaScript. A packet is a stack of
 * fixed sheets (a roster, a blank roster, an attendance slip, …), so the page
 * count is known before anything is laid out; that is what lets the contents
 * list print "p. 1–2" and the footer print "Page 1 of 13" honestly.
 */

/** Every section, in the order a folder is assembled. */
export const SECTION_ORDER: PacketSectionKind[] = [
  'roster',
  'blank-roster',
  'attendance',
  'eval-teacher',
  'eval-parent',
  'contact-list',
  'banner',
  'instructor-notes',
  'codification',
];

export const SECTION_LABELS: Record<PacketSectionKind, string> = {
  roster: 'Roster',
  'blank-roster': 'Blank roster',
  attendance: 'Attendance slip',
  'eval-teacher': 'Evaluation — teacher',
  'eval-parent': 'Evaluation — parent',
  'contact-list': 'Contact list',
  banner: 'Banner',
  'instructor-notes': 'Instructor notes',
  codification: 'Codification sheet',
};

export const DEFAULT_PRINT_SETUP: PacketPrintSetup = {
  paper: 'Letter',
  orientation: 'Portrait',
  margin: 0.5,
  copies: 2,
};

export function isPacketSectionKind(value: string): value is PacketSectionKind {
  return (SECTION_ORDER as string[]).includes(value);
}

/**
 * How many sheets a section occupies, given the roster size.
 *
 * The roster is the only section whose length depends on data: 15 rows fit a
 * portrait page at this type size, so 38 participants print as 3 pages. The
 * rest are single sheets by design — a two-page attendance slip would be
 * awkward to use on a clipboard.
 */
const ROSTER_ROWS_PER_PAGE = 15;

function rosterPages(participantCount: number): number {
  if (participantCount === 0) return 1;
  return Math.ceil(participantCount / ROSTER_ROWS_PER_PAGE);
}

/** Pages each section occupies. */
export function sectionPageCount(kind: PacketSectionKind, participantCount: number): number {
  if (kind === 'roster') return rosterPages(participantCount);
  if (kind === 'contact-list') return rosterPages(participantCount);
  return 1;
}

/**
 * Builds the section list with page numbers, so the contents panel and the
 * printed footer are derived from the same arithmetic.
 */
export function buildSections(
  kinds: PacketSectionKind[],
  detail: { participantCount: number; rosterEmpty: boolean; hasNotes: boolean },
): PacketDetail['sections'] {
  let page = 1;
  return kinds.map((kind) => {
    const pages = sectionPageCount(kind, detail.participantCount);
    const section = {
      kind,
      label: SECTION_LABELS[kind],
      startPage: page,
      endPage: page + pages - 1,
      filled: true,
      note: null as string | null,
    };

    if (kind === 'roster' && detail.rosterEmpty) {
      section.filled = false;
      section.note = 'No participants registered yet';
    }
    if (kind === 'instructor-notes' && !detail.hasNotes) {
      section.filled = false;
      section.note = 'Workshop notes are empty';
    }

    page += pages;
    return section;
  });
}

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function esc(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "8:50 AM- 10:50 AM" from the database reads badly; normalise the spacing. */
function tidyTime(text: string | null): string | null {
  if (!text) return null;
  return text.replace(/\s*-\s*/g, ' – ').replace(/\s+/g, ' ').trim();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/*  Section renderers                                                  */
/* ------------------------------------------------------------------ */

function headerHtml(workshop: PacketWorkshop): string {
  return `
    <header class="pk-head">
      <div class="pk-brand">
        <div class="pk-brand-name">Project Enlightenment</div>
        <div class="pk-brand-sub">Wake County Public School System</div>
      </div>
      <div class="pk-code">
        <div class="pk-code-value">${esc(workshop.workshopCode ?? '—')}</div>
        <div class="pk-code-year">SY ${esc(workshop.schoolYear ?? '')}</div>
      </div>
    </header>`;
}

function titleBlock(workshop: PacketWorkshop): string {
  const meta = [workshop.dateText, workshop.timeText, workshop.room ? `Room ${workshop.room}` : null]
    .filter(Boolean)
    .join(' · ');
  const presenters = workshop.presenterNames.length
    ? `Presenter: ${workshop.presenterNames.join(', ')}`
    : '';
  return `
    <h1 class="pk-title">${esc(workshop.workshopName)}</h1>
    <p class="pk-meta">${esc([meta, presenters].filter(Boolean).join(' · '))}</p>`;
}

function rosterSheet(
  workshop: PacketWorkshop,
  rows: PacketRosterRow[],
  pageIndex: number,
  pageTotal: number,
): string {
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="c-num">${r.index}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.agency ?? '—')}</td>
        <td>${esc(r.email ?? '')}</td>
        <td class="c-credit">${esc(r.credit ?? '—')}</td>
        <td class="c-attend">${r.attended === true ? '✓' : ''}</td>
      </tr>`,
    )
    .join('');

  return `
    <section class="pk-page">
      ${headerHtml(workshop)}
      ${titleBlock(workshop)}
      <table class="pk-table">
        <thead>
          <tr>
            <th class="c-num">#</th>
            <th>Participant</th>
            <th>Agency</th>
            <th>Email</th>
            <th class="c-credit">Credit</th>
            <th class="c-attend">Attended</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
      <div class="pk-sign">
        <span>Presenter signature</span><span>Date</span><span>Room / site</span>
      </div>
      ${footerHtml(workshop, 'Roster (filled)', pageIndex, pageTotal)}
    </section>`;
}

function blankRosterSheet(workshop: PacketWorkshop): string {
  const lines = Array.from(
    { length: 18 },
    () =>
      '<tr><td class="c-num"></td><td></td><td></td><td></td><td class="c-credit"></td><td class="c-attend"></td></tr>',
  ).join('');
  return `
    <section class="pk-page">
      ${headerHtml(workshop)}
      ${titleBlock(workshop)}
      <p class="pk-note">For walk-ins and late registrations.</p>
      <table class="pk-table pk-table-blank">
        <thead>
          <tr>
            <th class="c-num">#</th>
            <th>Participant</th>
            <th>Agency</th>
            <th>Email</th>
            <th class="c-credit">Credit</th>
            <th class="c-attend">Attended</th>
          </tr>
        </thead>
        <tbody>${lines}</tbody>
      </table>
      ${footerHtml(workshop, 'Roster (blank)', 1, 1)}
    </section>`;
}

function attendanceSheet(workshop: PacketWorkshop, rows: PacketRosterRow[]): string {
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="c-num">${r.index}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.agency ?? '—')}</td>
        <td class="c-sign"></td>
      </tr>`,
    )
    .join('');

  return `
    <section class="pk-page">
      ${headerHtml(workshop)}
      ${titleBlock(workshop)}
      <p class="pk-note">Sign in on arrival. One line per participant.</p>
      <table class="pk-table pk-table-attendance">
        <thead>
          <tr><th class="c-num">#</th><th>Participant</th><th>Agency</th><th class="c-sign">Signature</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
      ${footerHtml(workshop, 'Attendance slip', 1, 1)}
    </section>`;
}

function evaluationSheet(
  workshop: PacketWorkshop,
  audience: 'teacher' | 'parent',
  hasRoster: boolean,
): string {
  const questions =
    audience === 'teacher'
      ? [
          'How well did this workshop meet the stated objectives?',
          'How useful were the materials and handouts?',
          'How knowledgeable and prepared was the presenter?',
          'How likely are you to use what you learned in your classroom?',
        ]
      : [
          'How well did this workshop meet the stated objectives?',
          'How useful were the ideas you took away?',
          'How approachable and well prepared was the presenter?',
          'How likely are you to try what you learned at home?',
        ];

  const scale = `
    <div class="pk-scale">
      <span>1 — Not at all</span><span>2</span><span>3</span><span>4</span><span>5 — Very much</span>
    </div>`;

  const body = questions
    .map(
      (q, i) => `
      <div class="pk-question">
        <div class="pk-question-text">${i + 1}. ${esc(q)}</div>
        ${scale}
      </div>`,
    )
    .join('');

  return `
    <section class="pk-page">
      ${headerHtml(workshop)}
      ${titleBlock(workshop)}
      <p class="pk-note">
        ${audience === 'teacher' ? 'Teacher' : 'Parent'} evaluation${
          hasRoster ? '' : ' — no participants registered yet'
        }
      </p>
      ${body}
      <div class="pk-question">
        <div class="pk-question-text">5. What is one thing we could improve?</div>
        <div class="pk-lines">${'<div class="pk-line"></div>'.repeat(3)}</div>
      </div>
      ${footerHtml(workshop, `Evaluation — ${audience}`, 1, 1)}
    </section>`;
}

function contactListSheet(
  workshop: PacketWorkshop,
  rows: PacketRosterRow[],
  pageIndex: number,
  pageTotal: number,
): string {
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="c-num">${r.index}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.agency ?? '—')}</td>
        <td>${esc(r.email ?? '—')}</td>
      </tr>`,
    )
    .join('');

  return `
    <section class="pk-page">
      ${headerHtml(workshop)}
      ${titleBlock(workshop)}
      <table class="pk-table">
        <thead>
          <tr><th class="c-num">#</th><th>Participant</th><th>Agency</th><th>Email</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
      ${footerHtml(workshop, 'Contact list', pageIndex, pageTotal)}
    </section>`;
}

function bannerSheet(workshop: PacketWorkshop): string {
  return `
    <section class="pk-page pk-page-banner">
      <div class="pk-banner">
        <div class="pk-banner-brand">Project Enlightenment</div>
        <div class="pk-banner-title">${esc(workshop.workshopName)}</div>
        <div class="pk-banner-meta">
          ${esc([workshop.dateText, workshop.timeText].filter(Boolean).join(' · '))}
        </div>
        <div class="pk-banner-code">${esc(workshop.workshopCode ?? '')}</div>
      </div>
      ${footerHtml(workshop, 'Banner', 1, 1)}
    </section>`;
}

function instructorNotesSheet(workshop: PacketWorkshop, notes: string | null): string {
  const content = notes
    ? `<div class="pk-notes">${esc(notes).replace(/\n/g, '<br />')}</div>`
    : `<div class="pk-lines">${'<div class="pk-line"></div>'.repeat(14)}</div>`;
  return `
    <section class="pk-page">
      ${headerHtml(workshop)}
      ${titleBlock(workshop)}
      <p class="pk-note">Instructor notes</p>
      ${content}
      ${footerHtml(workshop, 'Instructor notes', 1, 1)}
    </section>`;
}

function codificationSheet(workshop: PacketWorkshop, detail: PacketDetail): string {
  const rows: [string, string][] = [
    ['Workshop code', workshop.workshopCode ?? '—'],
    ['Workshop name', workshop.workshopName],
    ['School year', workshop.schoolYear ?? '—'],
    ['Date', workshop.dateText ?? '—'],
    ['Time', workshop.timeText ?? '—'],
    ['Room', workshop.room ?? '—'],
    ['Presenters', workshop.presenterNames.join(', ') || '—'],
    ['Participants', String(workshop.participantCount)],
    ['Packet pages', String(detail.pageCount)],
  ];
  const body = rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  return `
    <section class="pk-page">
      ${headerHtml(workshop)}
      ${titleBlock(workshop)}
      <p class="pk-note">Codification sheet — file with the completed folder.</p>
      <table class="pk-table pk-table-codify"><tbody>${body}</tbody></table>
      <div class="pk-sign">
        <span>Codified by</span><span>Date</span><span>Initials</span>
      </div>
      ${footerHtml(workshop, 'Codification sheet', 1, 1)}
    </section>`;
}

function footerHtml(
  workshop: PacketWorkshop,
  sectionLabel: string,
  pageIndex: number,
  pageTotal: number,
): string {
  const pageText = pageTotal > 1 ? `Page ${pageIndex} of ${pageTotal}` : `Page ${pageIndex}`;
  return `
    <footer class="pk-foot">
      <span>Project Enlightenment · Training Database</span>
      <span>${esc(workshop.workshopCode ?? '')} · ${esc(sectionLabel)} · ${pageText}</span>
    </footer>`;
}

/* ------------------------------------------------------------------ */
/*  Document                                                           */
/* ------------------------------------------------------------------ */

export interface PacketRenderInput {
  detail: PacketDetail;
  sections: PacketSectionKind[];
  /** Workshop notes, for the instructor-notes sheet. */
  notes: string | null;
}

/**
 * The stylesheet.
 *
 * Page size comes from the print setup rather than being hard-coded, because
 * the builder lets staff switch to Legal or Landscape. `@page` is what
 * Chromium honours when printing to PDF; the on-screen preview scales the
 * same sheet with a CSS transform instead of re-flowing it, so the two cannot
 * disagree about where a line falls.
 */
function stylesheet(setup: PacketPrintSetup): string {
  const shortSide = '8.5in';
  const longSide = setup.paper === 'Legal' ? '14in' : '11in';
  const pageWidth = setup.orientation === 'Landscape' ? longSide : shortSide;
  const pageHeight = setup.orientation === 'Landscape' ? shortSide : longSide;

  return `
    @page {
      size: ${pageWidth} ${pageHeight};
      margin: ${setup.margin}in;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      color: #262626;
      font-size: 10pt;
      line-height: 1.35;
      background: #fff;
    }
    .pk-page {
      width: ${pageWidth};
      min-height: ${pageHeight};
      padding: ${setup.margin}in;
      position: relative;
      page-break-after: always;
      break-after: page;
      display: flex;
      flex-direction: column;
      background: #fff;
    }
    .pk-page:last-child { page-break-after: auto; break-after: auto; }

    .pk-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #165788;
      padding-bottom: 8px;
    }
    .pk-brand-name { color: #165788; font-size: 13pt; font-weight: 700; }
    .pk-brand-sub { color: #6b7780; font-size: 8pt; }
    .pk-code { text-align: right; }
    .pk-code-value { font-weight: 700; font-size: 11pt; }
    .pk-code-year { color: #6b7780; font-size: 8pt; }

    .pk-title { font-size: 16pt; margin: 16px 0 4px; color: #165788; }
    .pk-meta { margin: 0 0 14px; color: #525252; font-size: 9pt; }
    .pk-note { color: #6b7780; font-size: 9pt; font-style: italic; margin: 0 0 10px; }

    .pk-table { width: 100%; border-collapse: collapse; }
    .pk-table thead th {
      background: #165788;
      color: #fff;
      text-align: left;
      font-size: 8.5pt;
      padding: 5px 6px;
      font-weight: 600;
    }
    .pk-table tbody td {
      padding: 4px 6px;
      border-bottom: 1px solid #eef0f2;
      font-size: 9pt;
      vertical-align: top;
    }
    .pk-table tbody tr:nth-child(even) { background: #fafbfc; }
    .c-num { width: 26px; text-align: right; color: #6b7780; }
    .c-credit { width: 56px; }
    .c-attend { width: 64px; text-align: center; }
    .c-sign { width: 180px; }
    .pk-table-blank tbody td { height: 22px; }
    .pk-table-attendance tbody td { height: 26px; }

    .pk-table-codify th {
      background: #eef1f4;
      color: #262626;
      width: 32%;
      text-align: left;
      font-weight: 600;
      font-size: 9pt;
      padding: 6px;
    }
    .pk-table-codify td { padding: 6px; border-bottom: 1px solid #eef0f2; }

    .pk-sign {
      display: flex;
      gap: 28px;
      margin-top: 26px;
      color: #6b7780;
      font-size: 8pt;
    }
    .pk-sign span {
      flex: 1;
      border-top: 1px solid #cfd6dc;
      padding-top: 4px;
    }

    .pk-question { margin-bottom: 16px; }
    .pk-question-text { font-size: 10pt; margin-bottom: 6px; }
    .pk-scale {
      display: flex;
      justify-content: space-between;
      border: 1px solid #cfd6dc;
      padding: 6px 8px;
      font-size: 8pt;
      color: #6b7780;
    }
    .pk-lines { margin-top: 6px; }
    .pk-line { border-bottom: 1px solid #cfd6dc; height: 22px; }
    .pk-notes { font-size: 9.5pt; white-space: pre-wrap; }

    .pk-page-banner { justify-content: center; align-items: center; text-align: center; }
    .pk-banner { width: 100%; border: 6px double #165788; padding: 40px 24px; }
    .pk-banner-brand { color: #df6d1c; font-size: 12pt; letter-spacing: 2px; text-transform: uppercase; }
    .pk-banner-title { color: #165788; font-size: 26pt; font-weight: 700; margin: 18px 0; }
    .pk-banner-meta { color: #525252; font-size: 12pt; }
    .pk-banner-code { color: #6b7780; font-size: 10pt; margin-top: 14px; }

    .pk-foot {
      margin-top: auto;
      padding-top: 10px;
      border-top: 1px solid #eef0f2;
      display: flex;
      justify-content: space-between;
      color: #8a8a8a;
      font-size: 7.5pt;
    }

    @media print {
      body { background: #fff; }
      .pk-page { box-shadow: none; }
    }
  `;
}

/**
 * Renders the whole packet.
 *
 * `preview` adds a grey backdrop and page shadows so the iframe shows the
 * sheets as pages rather than as one endless scroll. The printed document is
 * the same markup either way.
 */
export function renderPacketHtml(input: PacketRenderInput, preview: boolean): string {
  const { detail, sections, notes } = input;
  const { workshop, roster, printSetup } = detail;
  const hasRoster = roster.length > 0;

  const rosterChunks = chunk(roster, ROSTER_ROWS_PER_PAGE);
  const pages: string[] = [];

  for (const kind of sections) {
    switch (kind) {
      case 'roster': {
        const chunks = rosterChunks.length ? rosterChunks : [[]];
        chunks.forEach((rows, i) => {
          pages.push(rosterSheet(workshop, rows, i + 1, chunks.length));
        });
        break;
      }
      case 'blank-roster':
        pages.push(blankRosterSheet(workshop));
        break;
      case 'attendance':
        pages.push(attendanceSheet(workshop, roster));
        break;
      case 'eval-teacher':
        pages.push(evaluationSheet(workshop, 'teacher', hasRoster));
        break;
      case 'eval-parent':
        pages.push(evaluationSheet(workshop, 'parent', hasRoster));
        break;
      case 'contact-list': {
        const chunks = rosterChunks.length ? rosterChunks : [[]];
        chunks.forEach((rows, i) => {
          pages.push(contactListSheet(workshop, rows, i + 1, chunks.length));
        });
        break;
      }
      case 'banner':
        pages.push(bannerSheet(workshop));
        break;
      case 'instructor-notes':
        pages.push(instructorNotesSheet(workshop, notes));
        break;
      case 'codification':
        pages.push(codificationSheet(workshop, detail));
        break;
    }
  }

  // The preview looks like pages on a desk. That dressing is screen-only:
  // staff print the packet straight from the preview iframe, and a grey
  // backdrop would otherwise print as a grey band behind every sheet.
  const previewCss = preview
    ? `
      @media screen {
        body { background: #5b6670; padding: 24px 0; }
        .pk-page {
          margin: 0 auto 24px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        }
      }
      @media print {
        body { background: #fff; padding: 0; }
        .pk-page { margin: 0; box-shadow: none; }
      }
    `
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(workshop.workshopCode ?? 'Packet')} — ${esc(workshop.workshopName)}</title>
<style>${stylesheet(printSetup)}${previewCss}</style>
</head>
<body>
${pages.join('\n')}
</body>
</html>`;
}

/** The date text the packet prints, e.g. "Wednesday, April 8, 2027". */
export function formatPacketDate(startDate: string | null, datesText: string | null): string | null {
  if (!startDate) return datesText;
  const d = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return datesText;
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export { tidyTime };
