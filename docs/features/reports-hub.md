# Reports hub

Read-only reports you run to understand something — attendance, enrollment,
evaluations, interest surveys. Documents generated *for* a specific workshop
(rosters, folders, certificates) live on the screen that owns their data.

- **Route:** `/reports`
- **Plan reference:** [`docs/plans/access-migration.md`](../plans/access-migration.md) §8
- **Status:** in progress

---

## 1. What belongs here

The Access database has **112 reports**. Most do not belong in the hub.

| Where | What | Count |
| --- | --- | --- |
| Folder builder | `rptFolder*` — roster, attendance slip, evaluations, contact list, banner, label | 36 |
| Certificates | `rptCEU*`, `rptCHC*` — built separately | 5 |
| Training requests | `rptTrainingRequest*`, `rptReceipt*` | 10 |
| **Reports hub** | read-only, cross-cutting | **~30** |
| Not rebuilt | `OLD_*` | 4 |
| Omitted for now | `rptCommEvents*` — the screen was removed from the nav | 4 |

The hub is for "show me the numbers", not "produce a document for this
workshop".

---

## 2. The reports

### 2.1 Attendance & enrollment

| Report | Replaces | Answers |
| --- | --- | --- |
| Attendance by component | `rptAttendbyComponent` | How many attended, grouped by component |
| Attendance summary by category | `rptAttendSumByCategory` | Totals per category |
| Attendance by category and workshop | `rptAttendSumByCatWks` | Category × workshop breakdown |
| WCPC workshop attendance | `rptAttendWCPCWorkshops` | Attendance for WCPC-run workshops |
| WCPC workshop registrations | `rptRegWCPCWorkshops` | Registrations for the same |
| Saturday participants | `rptSaturdayParticipants` | Everyone attending Saturday sessions |

### 2.2 Workshop listings

| Report | Replaces | Answers |
| --- | --- | --- |
| Workshops in a date range | `rptWorkshopsDateRange` | What is scheduled between two dates |
| …for parents | `rptWorkshopsDateRangeParent` | Parent-audience subset |
| …for teachers | `rptWorkshopsDateRangeTeacher` | Teacher-audience subset |
| Current workshops | `rptWorkshopsCurrent` | This school year's schedule |
| Current checklist | `rptWorkshopsCurrentCheckList` | Pre-delivery sanity check |

### 2.3 Evaluations

| Report | Replaces | Answers |
| --- | --- | --- |
| Rating distribution | `rptWorkshopEvalScores`, `rptWorkshopEvalScoresSum` | How many 5s, 4s, 3s… per question |
| Evaluation summary | `rptWorkshopEvalSummary` | Distribution plus response count |
| Liked most | `srptWorkshopLikedMost` | Free-text positives |
| Liked least | `srptWorkshopLikedLeast` | Free-text improvements |
| Practices adopted | `srptWorkshopPractices` | What staff say they will change |

**Ratings are 1–5 and heavily skewed.** Across 3,540 responses: 5★ = 1,948,
4★ = 1,325, 3★ = 236, 2★ = 21, 1★ = 9. An average would sit near 4.5 and say
nothing, so these reports show a **distribution** rather than a crosstab.

### 2.4 Interest surveys

| Report | Replaces | Answers |
| --- | --- | --- |
| Desired topics | `rptDesiredTopics` | What people want us to offer |
| Preferred times | `rptPreferredTimes` | When they want it |

### 2.5 Demographics

| Report | Replaces | Answers |
| --- | --- | --- |
| By agency | `rptNCDemoByAgency` | NCDHHS state reporting |
| By workshop | `rptNCDemoByWorkshop` | NCDHHS state reporting |

These have a fixed external format, so they are genuinely different from
everything else here.

### 2.6 Operational

| Report | Replaces | Answers |
| --- | --- | --- |
| Backup schedule — day | `rptBackupScheduleDay` | Staffing aid |
| Backup schedule — evening | `rptBackupScheduleEvening` | Staffing aid |

### 2.7 Financial — link out, do not rebuild

`rptNotPaidRegistrations`, `rptPaymentRegistrationsCurrent`, `rptRefundAgency`
and `rptRefundParticipant` are all views over data the **Payments & receipts**
screen already owns.

Rebuilding them here would create a second source of truth for money, and the
two would drift. The hub shows a card that deep-links to Payments with the
right filter applied:

| Card | Links to |
| --- | --- |
| Unpaid registrations | `/payments?status=unpaid` |
| Registrations and payments | `/payments` |
| Refunds by agency | `/payments?status=refunded` |
| Refunds by participant | `/payments?status=refunded` |

---

## 3. How it works

One generic pattern rather than thirty bespoke screens:

```
Pick a report  →  fill its parameters  →  table on screen  →  Download PDF
```

### 3.1 Report definition

Each report is a row in a definition table, not a hand-built screen:

```ts
interface ReportDefinition {
  key: string;                    // 'attendance-by-component'
  title: string;
  description: string;
  group: 'attendance' | 'workshops' | 'evaluations' | 'surveys' | 'demographics' | 'operational';
  parameters: ReportParameter[];  // date range, school year, category, workshop
  columns: { key: string; label: string; align?: 'left' | 'right' }[];
  run: (params) => Promise<Record<string, unknown>[]>;
  totals?: (rows) => Record<string, unknown>;  // optional footer
}
```

Adding a report means adding a definition, not a page.

### 3.2 Parameters

| Parameter | Control | Used by |
| --- | --- | --- |
| School year | Select | Most reports |
| Date range | Two date inputs | Workshop listings, attendance |
| Category | Select | Attendance |
| Workshop | Typeahead | Evaluations, free-text |

Defaults are the current school year, so opening a report is one click.

### 3.3 Output

- **On screen:** a table with the report's columns, right-aligned numerics,
  and a totals row where it makes sense
- **PDF:** the same table rendered through the existing HTML→PDF service, with
  a header carrying the report name, parameters and run date

Both come from the same data, so they cannot diverge.

### 3.4 Empty and large results

- Zero rows shows the parameters that were used, so staff can see *why* it is
  empty rather than assuming the report is broken
- Results cap at 5,000 rows on screen with a notice; the PDF is uncapped

---

## 4. API

```
GET  /api/reports                     # catalogue: key, title, group, parameters
GET  /api/reports/:key                # run with query params, returns rows
GET  /api/reports/:key/pdf            # same, as PDF
```

All authenticated. Reports are read-only, so any signed-in role may run them.

---

## 5. Acceptance criteria

- A report can be added by adding a definition, with no new page or route.
- The on-screen table and the PDF show identical numbers.
- An empty result states which parameters produced it.
- Financial cards link to Payments rather than duplicating its data.
- Evaluation reports show a rating distribution, not an average.
- Every report states its parameters in the PDF header.
