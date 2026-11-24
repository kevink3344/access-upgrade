# Visual Reports — Charts Under the Reports Hub

**From:** The Reports hub returns tables and PDFs
**To:** A "Visual Reports" section with 5–6 charts (Recharts) answering the questions staff ask most often
**Prepared:** 2026-11-23
**Status:** Draft for review — decisions in §9 need sign-off before Phase 1

**Related:** [Reports hub](../features/reports-hub.md) · [Access migration plan](./access-migration.md) §8 · [Certificates](../features/certificates.md)

> **Verified against the live database on 2026-11-23.** Every figure in this plan is a real count, not an estimate. Two of them changed the design: the top-agencies chart would silently drop a quarter of all registrations, and one of the six charts was replaced because the data behind it is 41,341 rows of one value.

---

## 1. Executive summary

The Reports hub already answers "show me the rows". It does not answer "what does this look like?" — a table of 41,345 registrations tells nobody anything at a glance. This adds a **Visual Reports** section: six charts, each backed by one small aggregate query, with a shared school-year filter.

**Recharts is not currently a dependency.** It needs adding to `apps/web`.

**Effort estimate: 4–6 days.** The charts are the easy part; the work is the aggregate endpoints, honest handling of sparse data, and accessibility.

**The main risk is not technical — it is picking charts that look good and answer nothing.** §2 sets out why each of the six earns its place, and §8 lists the ones I deliberately left out.

---

## 2. The six charts, and what each answers

Each is chosen because a staff member would act on it. A chart nobody acts on is decoration. Counts below are live.

| # | Chart | Type | Question it answers | Live shape |
| --- | --- | --- | --- | --- |
| 1 | **Registrations by month** | Line | Are we busier than last year at this point? | 2024-25 runs Aug 229 → Sep 377 → Oct 224 → … → May 1. A real seasonal curve |
| 2 | **Attendance outcomes** | Donut | Of everyone registered, how many attended / cancelled / no-showed? | 27,098 attended · 1,858 cancelled · **12,510 no-show** |
| 3 | **Workshops by category** | Horizontal bar | Where is the programme concentrated? | Teacher 955 · Parent 510 · Guided Obs 469 · Staff Dev 119 · NCTLC 115 · TPC-K 86 |
| 4 | **Revenue by school year** | Bar | What has each year brought in? | 2026-27 $4,750 · 2025-26 $36,675 · 2024-25 $14,506 · 2023-24 $12,450 · 2022-23 $11,914 |
| 5 | **Credit slips by category** | Pie | Why are we issuing credit? | Hardship 525 ($11,328) · Cancelled 245 ($5,590) · Make-up 65 · Overpayment 6 · Gift 4 |
| 6 | **Top agencies by registrations** | Horizontal bar | Who are our biggest participants? | PE 2,695 · Soapstone 858 · St. Michael's 701 · Hudson Memorial 653 · White Memorial 503 |

### 2.1 Why these six

- **1 and 4** are the same underlying question (volume and money) at two grains, and both are what a director asks first. Chart 1 has a genuine seasonal shape, not noise.
- **2** is the one chart with a *problem* embedded in it: **12,510 no-shows against 27,098 attendances is a 30% no-show rate.** That is the single most actionable number in the dataset.
- **3** and **6** are concentration questions — "are we spread too thin?" and "who matters most?".
- **5** is the only chart that explains a financial instrument rather than a count. Hardship is 62% of all slips, which is a policy signal, not just a number.

### 2.2 What each does *not* show

| Chart | Deliberate limit |
| --- | --- |
| Registrations by month | Counts registrations, not unique people — one person can register for several workshops |
| Attendance outcomes | "No-show" is derived: registered, not cancelled, not marked attended. There is no status column |
| Workshops by category | Counts workshops, not seats — a 40-seat workshop counts the same as a 5-seat one |
| Revenue by school year | Sums `PaidAmount`, which includes negative rows (189 refunds). The chart must say so or the total looks wrong |
| Credit slips | Shows the reason, not whether the slip was used (300 of 846 are unused) |
| Top agencies | **Excludes 10,120 of 41,345 registrations (24%)** — participants with no agency recorded. See §2.3 |

### 2.3 Top agencies is the weakest of the six — and needs a decision

Two problems surfaced in the live data:

1. **24% of registrations have no agency.** 10,120 of 41,345. A "top agencies" bar chart silently drops a quarter of the data. It must either show "No agency recorded" as a bar, or state the exclusion prominently.
2. **"Project Enlightenment" is the largest agency by a factor of three** (2,695 vs 858). That is the programme's own agency — staff registrations and internal bookings. Charting it as the top participant is misleading; it should be excluded, or labelled as internal.

**Recommendation:** exclude the programme's own agency and show "No agency recorded" as an explicit final bar, so the chart accounts for 100% of registrations. That is more honest than a top-10 that quietly represents three quarters of the data.

---

## 3. Where it lives

A **Visual Reports** entry in the Reports hub's left nav, above the report groups:

```
Reports hub
├── Visual Reports          ← new, opens the chart page
├── Attendance & enrollment
├── Workshop listings
├── Evaluations
├── Interest surveys
├── Demographics
├── Operational
└── Financial (links)
```

Two options for the destination:

| Option | Behaviour | Recommendation |
| --- | --- | --- |
| **A. Separate route `/reports/visual`** | Its own page, own layout | **Recommended** — charts need width the hub's two-column layout does not give |
| B. A panel inside the hub | Replaces the report table area | Cramped; the hub's main column is sized for a table |

**Recommendation: A.** The hub's `reports-layout` is a sidebar plus a main column tuned for a table. Charts want the full width, and a separate route keeps the hub's "pick a report, see its rows" model intact.

---

## 4. Design

### 4.1 Layout

```
┌─────────────────────────────────────────────────────────┐
│ Visual Reports                                          │
│ School year [2026-27 ▾]   [All years]                   │
├──────────────────────────┬──────────────────────────────┤
│ Registrations by month   │ Attendance outcomes          │
│ (wide, spans 2)          │ (donut, 1 col)               │
├──────────────────────────┼──────────────────────────────┤
│ Workshops by category    │ Revenue by school year       │
├──────────────────────────┼──────────────────────────────┤
│ Credit slips by category │ Top agencies                 │
└──────────────────────────┴──────────────────────────────┘
```

A CSS grid, two columns above 900px, one below. Each chart is a card with a title, a one-line subtitle stating what it counts (§2.2), and the chart itself.

### 4.2 The shared filter

One school-year selector at the top, applying to every chart. Defaults to the newest year **that has data** — the same rule the hub already uses (`latestSchoolYear`), because 2026-27 is empty and opening on an empty chart is a bad first impression.

Charts that are inherently cross-year (4, revenue by school year) ignore the filter and say so in their subtitle.

### 4.3 Data shape

Every chart endpoint returns the same envelope, so the frontend has one fetch pattern:

```ts
interface ChartSeries {
  /** Rows ready for Recharts; keys are chart-specific. */
  data: Array<Record<string, string | number>>;
  /** Total the chart represents, for the subtitle. */
  total: number;
  /** True when there is nothing to draw. */
  isEmpty: boolean;
  /** Human-readable caveat, shown under the title (see §2.2). */
  note: string | null;
}
```

### 4.4 Recharts specifics

| Concern | Decision |
| --- | --- |
| Bundle size | Recharts is ~100 KB gzipped. Import the page lazily (`React.lazy`) so the hub's first paint is unaffected |
| Responsive | `ResponsiveContainer` at 100% width, fixed height per chart (280px) |
| Colours | Reuse the design tokens already in `packages/shared/src/tokens.css` — no new palette |
| Tooltips | Required on every chart; a chart without exact numbers is a guess |
| Empty state | Every chart renders an explicit "No data for this year" panel rather than an empty axis |
| Single data point | A pie with one slice is a circle; render it as a labelled bar instead |

### 4.5 Accessibility

Charts are images to a screen reader. Every chart card carries:

- An `aria-label` on the container stating the chart's finding, not just its title — e.g. *"Registrations by month: 412 registrations, peaking in September"*.
- A visually-hidden `<table>` of the same data, so the numbers are reachable without the SVG.
- Colour is never the only encoding: each series is labelled directly, not only in a legend.

---

## 5. API

One endpoint per chart keeps each query small and lets a chart fail without taking the page down.

| Endpoint | Returns |
| --- | --- |
| `GET /api/reports/charts/registrations-by-month?schoolYearId=` | `{ month, count }[]` |
| `GET /api/reports/charts/attendance-outcomes?schoolYearId=` | `{ outcome, count }[]` |
| `GET /api/reports/charts/workshops-by-category?schoolYearId=` | `{ category, count }[]` |
| `GET /api/reports/charts/revenue-by-year` | `{ schoolYear, total }[]` |
| `GET /api/reports/charts/credit-slips-by-category?schoolYearId=` | `{ category, count, amount }[]` |
| `GET /api/reports/charts/top-agencies?schoolYearId=&limit=10` | `{ agency, count }[]` |

All under the existing `reportsRouter`, all `requireAuth`, all returning the `ChartSeries` envelope from §4.3.

**Why not one combined endpoint.** Six queries in one request means the slowest decides the page's latency, and one bad year breaks all six. Six small requests load in parallel and degrade independently.

### 5.1 Query notes

- **Registrations by month** groups on `FORMAT(RegistrationDate,'yyyy-MM')`. Grouping on a formatted string is slower than a date-part expression but is the only way to get a stable sortable key; the table is 41k rows, so it is fine. Add `WHERE RegistrationDate IS NOT NULL` — the column is nullable.
- **Attendance outcomes** is three `SUM(CASE …)` over one scan, not three queries.
- **Revenue by year** must include the refund rows. A `WHERE PaidAmount > 0` filter would make the total disagree with the Payments screen, which is worse than a slightly odd chart.
- **Top agencies** uses `TOP (@limit)` with a bound parameter, capped server-side at 25. It must `LEFT JOIN` the agency so the 10,120 agency-less registrations can be bucketed rather than dropped, and exclude the programme's own agency (`AgencyName = 'Project Enlightenment'`, AgencyID 269) from the ranking while still counting it in the stated total.
- **Registrations by month** must be scoped to a school year, not a calendar year — the 2024-25 series runs August to May, and a calendar window would cut the curve in half.

---

## 6. Data caveats that must appear on screen

These are not footnotes — each one changes how a reader should interpret the chart.

| Chart | Caveat to display |
| --- | --- |
| Revenue by school year | "Includes refunds (negative amounts)." |
| Attendance outcomes | "No-show = registered, not cancelled, not marked attended." |
| Registrations by month | "Counts registrations, not people." |
| Top agencies | "Project Enlightenment excluded (internal). 10,120 registrations have no agency and are shown separately." |

The `note` field in the envelope carries these, so the wording lives in the API next to the query that produces the number.

---

## 7. Phasing

| Phase | Work | Effort |
| --- | --- | --- |
| **1. Dependency + scaffold** | Add `recharts`; `/reports/visual` route; lazy-loaded page shell; shared `ChartCard` with title, subtitle, note, empty state, hidden table | 1 day |
| **2. Three simple charts** | Registrations by month, workshops by category, top agencies — all single-table aggregates | 1 day |
| **3. Two derived charts** | Attendance outcomes (three-way CASE), revenue by year (join to school year) | 1 day |
| **4. Credit slips chart** | Reuses the credit slip query shape already written for the Credit slips screen | 0.5 day |
| **5. Polish** | Accessibility pass, empty/single-point states, responsive layout, hub nav entry | 1–2 days |

**Total: 4–6 days.**

### Testing

- `charts.test.ts` — each aggregate returns the envelope shape; empty year yields `isEmpty: true` rather than an empty array with no flag; the revenue note is present.
- A pure unit test for the month-labelling helper (the one piece of formatting logic worth isolating).
- Manual: every chart at 320px, 768px and 1440px; every chart with an empty year.

---

## 8. What I deliberately left out

| Tempting chart | Why not |
| --- | --- |
| Evaluations / satisfaction | The legacy evaluation tables are aggregate tallies (`WorkshopEvalQuestion` stores a rating *and a count*), so there is no per-response data to chart honestly |
| Registrations by source (Manual/Web/eSchools) | **Verified: 41,341 Manual vs 4 Web.** A chart that is 99.99% one bar tells staff nothing. Revisit once the public registration form has run for a term |
| Certificate issuance over time | Certificates are generated on demand, not recorded as issued, so there is no history to plot |
| Training requests funnel | 108 requests, 68 invoiced, 2 active. A funnel of 108 is a bar chart wearing a costume |
| Geographic distribution | `ref.City` is populated on agencies but not on participants, so the map would be mostly blank |
| Training request value by year | 40 of 108 requests have no `AmtDue`; the chart would be a chart of missing data |

If staff want any of these, the data model needs work first — that is a separate conversation, not a chart.

---

## 9. Decisions needed before Phase 1

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Separate route or a panel in the hub? | Separate route `/reports/visual` (§3) |
| 2 | Six charts as listed, or swap some? | As listed — each answers a question in §2 |
| 3 | Should the year filter apply to revenue? | No — it is a cross-year comparison and says so |
| 4 | Add Recharts, or hand-roll SVG? | Recharts — hand-rolling axes, tooltips and responsiveness is a week of work for a worse result |
| 5 | Should charts be exportable as images? | Not in this phase; the PDF path already covers printing |
| 6 | Top agencies: exclude Project Enlightenment and show "No agency" as a bar? | **Yes** — otherwise the chart misrepresents both the leader and a quarter of the data (§2.3) |

---

## 10. Immediate next steps

1. Confirm the six charts in §2 match what staff actually ask about — this is the one thing worth checking before building, because a chart nobody reads is worse than no chart.
2. On sign-off, add `recharts` to `apps/web` and build the `ChartCard` shell first, so the six charts share one frame.

---

## 11. What shipped (2026-11-23)

Implemented per the decisions in §9: separate route, the six charts as listed, revenue ignoring the year filter, Recharts, PDF-only export (no image export), and no separate "No agency recorded" bar.

| Area | File | Notes |
| --- | --- | --- |
| Dependency | `apps/web/package.json` | `recharts` ^3.11.1 |
| Aggregates | `apps/api/src/services/charts.ts` | Six queries, one `ChartSeries` envelope each |
| Route | `apps/api/src/routes/reports.ts` | `GET /api/reports/charts/:key`, registered **before** `/:key` so it is not shadowed |
| Types | `packages/shared/src/index.ts` | `ChartSeries`, `ChartPoint`, `ChartKey` |
| Card | `apps/web/src/components/ChartCard.tsx` | Title, total, note, empty state, hidden data table |
| Page | `apps/web/src/pages/VisualReportsPage.tsx` | Six charts, year filter, responsive grid |
| Styles | `apps/web/src/styles/ui-charts.css` | Two columns above 900px, one below |
| Nav | `apps/web/src/components/AppShell.tsx` | "Visual Reports" under Reports |

### 11.1 Two things the live data changed

**Attendance recording stopped around 2018-19.** Measured: 3,284 attended in 2006-07, 568 in 2018-19, **0 in 2019-20**, and 1 or fewer in every year since. A recent year therefore reads as ~99% no-show — not because nobody came, but because nobody marks the register. The chart now detects this (under 10% attended) and replaces its note with an explicit warning rather than presenting a misleading donut.

**Credit slips are sparse by year.** The newest slip is April 2025, so 2025-26 and 2026-27 legitimately have none and show the empty state.

### 11.2 Bundle

Recharts is ~486 KB. The page is `React.lazy`-loaded, so the main bundle stayed at 636 KB (was 611 KB before Recharts) and the chart chunk only downloads on `/reports/visual`. A static import was tried first and put the whole library in the main chunk — the lazy route is what actually splits it.

### 11.3 Verified

Typecheck across all three workspaces; `npm run build`; 45 tests pass; all six charts render against live data at 2026-27 and 2024-25; revenue total $1,762,644 matches the sum of its bars; the empty state appears for a year with no slips; the responsive grid is single-column below 900px with no horizontal overflow.

### 11.4 Credit slips chart removed (2026-11-23)

The "Credit slips by category" chart was dropped at the user's request after review. Removed from the API (`CHARTS`, the query), the shared `ChartKey` union, and the page. The endpoint now 404s, and the page renders **five** charts.

The reasoning in §2 still stands for the other five; the credit-slip question is served by the Credit slips screen itself, which lists and filters by category directly.

**Not committed or pushed**, at the user's request, so they can test first.
