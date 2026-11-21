/**
 * Certificate HTML template.
 *
 * Modelled on the "Credit Slips 26-27" template staff supplied, rebuilt in
 * portrait (8.5x11in) per the plan. The same markup backs both the on-screen
 * preview and the PDF, so what staff approve is exactly what prints.
 *
 * Text stays real text: no flattened background images. That keeps the
 * certificate selectable, searchable and readable by a screen reader, which
 * is why a Canva export was rejected (plan §8.6.1).
 *
 * Palette sampled from the supplied template:
 *   #0C5488  deep blue — frame, titles, headings
 *   #E3732B  orange    — accent dot, metric icons
 *   #2B59A1  link blue — footer sponsor line
 *   #212121  near-black body text
 */

export interface CertificateFieldVisibility {
  name: boolean;
  certificateType: boolean;
  programTitle: boolean;
  programDirector: boolean;
  inclusiveDates: boolean;
  unitsOfRenewalCredit: boolean;
  agency: boolean;
  employedBy: boolean;
  roleFlags: boolean;
  ssn: boolean;
  homeAddress: boolean;
  expirationDate: boolean;
}

export const DEFAULT_VISIBLE_FIELDS: CertificateFieldVisibility = {
  name: true,
  certificateType: true,
  programTitle: true,
  programDirector: true,
  inclusiveDates: true,
  unitsOfRenewalCredit: true,
  agency: true,
  employedBy: true,
  roleFlags: true,
  // Legacy artifacts. Off by default — see plan §8.6.2.
  ssn: false,
  homeAddress: false,
  expirationDate: false,
};

export interface CertificateModel {
  template: {
    title: string;
    subtitle: string;
    programDirectorName: string | null;
    programDirectorTitle: string | null;
    approvingDirectorName: string | null;
    approvingDirectorTitle: string | null;
    creditUnitLabel: string;
    footerText: string | null;
    visibleFields: CertificateFieldVisibility;
    /** 'portrait' (8.5x11) or 'landscape' (11x8.5). */
    layout: 'portrait' | 'landscape';
    /** Data URI, already resolved from the database. */
    logoDataUri: string | null;
    /** Optional second mark shown top-left (the NCDHHS block). */
    secondaryLogoDataUri: string | null;
  };
  participant: {
    fullName: string;
    certificateType: 'Initial' | 'Continuing';
    agencyName: string | null;
    schoolYear: string;
    totalHours: number;
    totalCeus: number;
    firstDate: string | null;
    lastDate: string | null;
    workshops: { title: string; date: string | null; hours: number | null }[];
  };
  override: {
    customText: string | null;
    customTextLabel: string | null;
    imageDataUri: string | null;
    imageAltText: string | null;
    imagePlacement: 'header' | 'body' | 'footer' | null;
  } | null;
  /** When the certificate was produced, for the GENERATED ON block. */
  generatedOn: string;
}

function esc(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtRange(from: string | null, to: string | null): string {
  const a = fmtDate(from);
  const b = fmtDate(to);
  if (!a) return '';
  if (!b || a === b) return a;
  return `${a} – ${b}`;
}

/** Calendar glyph for the attendance-dates block. */
const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>`;

/** Clock glyph for the total-hours block. */
const CLOCK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;

export function renderCertificateHtml(model: CertificateModel): string {
  const { template: t, participant: p, override: o } = model;
  const v = { ...DEFAULT_VISIBLE_FIELDS, ...t.visibleFields };

  const landscape = t.layout === 'landscape';
  // Landscape is 11x8.5in: less vertical room, more horizontal. The type
  // scale and spacing shrink so the same content still fits one page.
  const pageW = landscape ? '11in' : '8.5in';
  const pageH = landscape ? '8.5in' : '11in';
  const scale = landscape ? 0.82 : 1;

  const logo = t.logoDataUri
    ? `<img class="logo" src="${t.logoDataUri}" alt="Project Enlightenment" />`
    : '';

  const secondaryLogo = t.secondaryLogoDataUri
    ? `<img class="logo-secondary" src="${t.secondaryLogoDataUri}" alt="NC Department of Health and Human Services, Division of Child Development and Early Education" />`
    : '';

  const overrideImage =
    o?.imageDataUri && o.imageAltText
      ? `<figure class="participant-image"><img src="${o.imageDataUri}" alt="${esc(o.imageAltText)}" /></figure>`
      : '';

  const customText =
    o?.customText && o.customText.trim()
      ? `<p class="custom-text">${
          o.customTextLabel ? `<span class="custom-label">${esc(o.customTextLabel)}:</span> ` : ''
        }${esc(o.customText)}</p>`
      : '';

  // The workshop series line names what was attended. With one workshop we
  // name it inline; with several we show the count and list them underneath.
  const seriesLine =
    p.workshops.length === 1
      ? `<span class="series-name">${esc(p.workshops[0]!.title)}</span>`
      : `<span class="series-name">${p.workshops.length} workshops</span>`;

  const workshopList =
    p.workshops.length > 1
      ? `<ul class="workshops">${p.workshops
          .map(
            (w) =>
              `<li><span class="w-title">${esc(w.title)}</span>` +
              (w.date ? `<span class="w-date">${fmtDate(w.date)}</span>` : '') +
              (w.hours !== null ? `<span class="w-hours">${w.hours} hr</span>` : '') +
              `</li>`,
          )
          .join('')}</ul>`
      : '';

  const signature = (name: string | null, title: string | null) =>
    `<div class="sig">
       <div class="sig-line"></div>
       <div class="sig-name">${esc(name) || '&nbsp;'}</div>
       <div class="sig-title">${esc(title)}</div>
     </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(t.title)} — ${esc(p.fullName)}</title>
<style>
  @page { size: ${pageW} ${pageH}; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    font-family: 'Open Sans', 'Segoe UI', Arial, Helvetica, sans-serif;
    color: #212121;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page {
    width: ${pageW}; height: ${pageH};
    padding: 0.3in;
    position: relative;
  }
  /* Double rule frame — the outer line is heavier, as in the source. */
  .frame {
    position: absolute; inset: 0.22in;
    border: 3px solid #0C5488;
    pointer-events: none;
  }
  .frame::after {
    content: ''; position: absolute; inset: 3px;
    border: 1px solid #0C5488;
  }
  .content {
    position: relative;
    height: 100%;
    padding: 0.28in 0.34in 0.2in;
    display: flex; flex-direction: column;
  }

  /* ---- header ----
     Three columns so the Project Enlightenment mark sits in the optical
     centre of the page: NCDHHS lockup left, PE centred, right column left
     empty as whitespace. Equal side columns keep the centre truly centred
     rather than offset by the wider NCDHHS lockup. */
  .header {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 0.2in;
    margin-bottom: 0.04in;
  }
  .header-left { justify-self: start; }
  .header-centre { justify-self: center; }
  .header-right { justify-self: end; }
  .logo-secondary {
    display: block;
    width: ${(2.35 * scale).toFixed(2)}in;
    height: auto;
    object-fit: contain;
  }
  .logo {
    display: block;
    /* The PE mark is a 3.1:1 lockup (sunburst + wordmark), so it is sized by
       width to keep the wordmark legible next to the NCDHHS block. */
    width: ${(1.95 * scale).toFixed(2)}in;
    height: auto;
    object-fit: contain;
  }

  h1 {
    font-size: ${(52 * scale).toFixed(1)}pt; line-height: 1; letter-spacing: .02em;
    margin: ${(0.04 * scale).toFixed(3)}in 0 0; text-align: center;
    color: #0C5488; font-weight: 800; text-transform: uppercase;
  }
  .subtitle {
    font-size: ${(27 * scale).toFixed(1)}pt; line-height: 1.1; text-align: center;
    color: #0C5488; font-weight: 400; text-transform: uppercase;
    letter-spacing: .04em; margin: 0;
  }

  /* Rule with the orange dot, exactly as in the source template. */
  .divider {
    position: relative; height: 1px; background: #0C5488;
    margin: ${(0.16 * scale).toFixed(3)}in 0 ${(0.22 * scale).toFixed(3)}in;
  }
  .divider::after {
    content: ''; position: absolute; left: 50%; top: 50%;
    width: 10px; height: 10px; border-radius: 50%;
    background: #E3732B; transform: translate(-50%, -50%);
  }

  /* ---- body ---- */
  .presented {
    text-align: center; font-size: ${(13 * scale).toFixed(1)}pt;
    color: #212121; margin-bottom: ${(0.08 * scale).toFixed(3)}in;
  }
  .name {
    text-align: center; font-size: ${(28 * scale).toFixed(1)}pt; font-weight: 600;
    color: #212121; margin: ${(0.12 * scale).toFixed(3)}in 0.4in ${(0.18 * scale).toFixed(3)}in;
    border-bottom: 1px solid #212121; padding-bottom: ${(0.08 * scale).toFixed(3)}in;
  }
  .cert-type {
    text-align: center; font-size: ${(11 * scale).toFixed(1)}pt; font-style: italic;
    color: #5E8EB0; margin-bottom: ${(0.16 * scale).toFixed(3)}in;
  }

  .series {
    text-align: center; font-size: ${(13 * scale).toFixed(1)}pt;
    color: #212121; margin-bottom: ${(0.22 * scale).toFixed(3)}in; line-height: 1.5;
  }
  .series-name { font-weight: 600; }

  .workshops {
    list-style: none; padding: 0; margin: 0 0 0.14in;
    font-size: 9pt; color: #3a464f;
  }
  .workshops li { margin-bottom: 2px; display: flex; gap: 6px; }
  .w-title { flex: 1; }
  .w-date, .w-hours { color: #8a8a8a; white-space: nowrap; }

  .custom-text {
    text-align: center; font-size: 11pt; font-style: italic;
    margin: 0 0 0.14in; color: #212121;
  }
  .custom-label { font-style: normal; font-weight: 700; }

  .participant-image { margin: 0 auto 0.14in; text-align: center; }
  .participant-image img { max-height: 1.3in; max-width: 3.4in; object-fit: contain; }

  /* ---- metrics row ---- */
  .metrics {
    display: flex; align-items: stretch; justify-content: center;
    gap: 0; margin: ${(0.1 * scale).toFixed(3)}in 0 ${(0.18 * scale).toFixed(3)}in;
    border-top: 1px solid #0C5488; border-bottom: 1px solid #0C5488;
    padding: ${(0.12 * scale).toFixed(3)}in 0;
  }
  .metric {
    flex: 1; display: flex; align-items: center; gap: 0.1in;
    padding: 0 0.16in;
  }
  .metric + .metric { border-left: 1px solid #212121; }
  .metric-icon {
    width: ${(0.42 * scale).toFixed(2)}in; height: ${(0.42 * scale).toFixed(2)}in;
    border-radius: 50%;
    background: #E3732B; color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .metric-icon svg { width: ${(0.24 * scale).toFixed(2)}in; height: ${(0.24 * scale).toFixed(2)}in; }
  .metric-label {
    font-size: ${(10 * scale).toFixed(1)}pt; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; color: #0C5488;
  }
  .metric-value { font-size: ${(15 * scale).toFixed(1)}pt; font-weight: 700; color: #212121; line-height: 1.15; }

  .spacer { flex: 1; }

  /* ---- signatures ---- */
  .signatures {
    display: flex; justify-content: space-around; gap: 0.5in;
    margin: ${(0.18 * scale).toFixed(3)}in 0 ${(0.16 * scale).toFixed(3)}in;
  }
  .sig { flex: 1; text-align: center; }
  .sig-line { border-top: 1px solid #212121; margin-bottom: 5px; }
  .sig-name { font-size: ${(11 * scale).toFixed(1)}pt; font-weight: 600; }
  .sig-title { font-size: ${(9 * scale).toFixed(1)}pt; color: #5E8EB0; }

  /* ---- footer ---- */
  .footer {
    display: flex; align-items: stretch; gap: 0;
    border-top: 1px solid #212121; padding-top: ${(0.1 * scale).toFixed(3)}in;
    font-size: ${(9 * scale).toFixed(1)}pt; color: #212121;
  }
  .footer-col { padding: 0 0.14in; }
  .footer-col + .footer-col { border-left: 1px solid #212121; }
  .footer-sponsor { flex: 1.35; }
  .footer-note { flex: 1.25; display: flex; align-items: center; }
  .footer-generated { flex: 1; }
  .sponsor-line { color: #2B59A1; font-size: ${(9.5 * scale).toFixed(1)}pt; }
  .sponsor-org { font-weight: 700; color: #212121; font-size: ${(9.5 * scale).toFixed(1)}pt; }
  .footer-label {
    font-size: ${(9.5 * scale).toFixed(1)}pt; font-weight: 700; letter-spacing: .05em;
    text-transform: uppercase; color: #0C5488; margin-bottom: 2px;
  }
  .footer-value { font-size: ${(10.5 * scale).toFixed(1)}pt; font-weight: 700; color: #212121; }
  .disclaimer { font-size: ${(8 * scale).toFixed(1)}pt; color: #5E8EB0; margin-top: 0.08in; }
</style>
</head>
<body>
<div class="page">
  <div class="frame"></div>
  <div class="content">
    <div class="header">
      <div class="header-left">${secondaryLogo}</div>
      <div class="header-centre">${logo}</div>
      <div class="header-right"></div>
    </div>

    <h1>${esc(t.title)}</h1>
    ${t.subtitle ? `<div class="subtitle">${esc(t.subtitle)}</div>` : ''}
    <div class="divider"></div>

    <div class="presented">This certifies that</div>
    <div class="name">${esc(p.fullName)}</div>
    ${v.certificateType ? `<div class="cert-type">${esc(p.certificateType)} Certificate</div>` : ''}

    ${v.programTitle ? `<div class="series">participated in the following Project Enlightenment workshop series: ${seriesLine}</div>` : ''}
    ${workshopList}
    ${customText}
    ${o?.imagePlacement === 'body' ? overrideImage : ''}

    <div class="metrics">
      ${v.inclusiveDates
        ? `<div class="metric">
             <span class="metric-icon">${CALENDAR_ICON}</span>
             <span>
               <span class="metric-label">Attendance dates:</span>
               <span class="metric-value">${esc(fmtRange(p.firstDate, p.lastDate))}</span>
             </span>
           </div>`
        : ''}
      ${v.unitsOfRenewalCredit
        ? `<div class="metric">
             <span class="metric-icon">${CLOCK_ICON}</span>
             <span>
               <span class="metric-label">Total hours:</span>
               <span class="metric-value">${p.totalHours.toFixed(1)}</span>
             </span>
           </div>`
        : ''}
    </div>

    <div class="spacer"></div>

    ${o?.imagePlacement === 'header' ? overrideImage : ''}

    ${
      v.programDirector
        ? `<div class="signatures">
             ${signature(t.programDirectorName, t.programDirectorTitle)}
             ${signature(t.approvingDirectorName, t.approvingDirectorTitle)}
           </div>`
        : ''
    }

    ${o?.imagePlacement === 'footer' ? overrideImage : ''}

    <div class="footer">
      <div class="footer-col footer-sponsor">
        <div class="sponsor-line">Sponsored by Project Enlightenment</div>
        <div class="sponsor-org">Wake County Public School System</div>
        <div>501 S. Boylan Avenue</div>
        <div>Raleigh, NC 27603</div>
      </div>
      <div class="footer-col footer-note">
        <span>This document serves as official proof of attendance.</span>
      </div>
      <div class="footer-col footer-generated">
        <div class="footer-label">Generated on:</div>
        <div class="footer-value">${esc(model.generatedOn)}</div>
        ${v.agency && p.agencyName ? `<div class="disclaimer">${esc(p.agencyName)}</div>` : ''}
      </div>
    </div>

    ${t.footerText ? `<div class="disclaimer">${esc(t.footerText)}</div>` : ''}
  </div>
</div>
</body>
</html>`;
}
