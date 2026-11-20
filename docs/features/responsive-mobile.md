# Responsive & Mobile Requirements

**Status:** Draft for review
**Related:** [Migration plan §4](../plans/access-migration.md) · [Public registration](./public-registration.md)
**Prepared:** 2026-11-19

---

## 1. Why this is a Phase 0 concern

The migration plan was written around desktop workflows: a 175-control workshop form, virtualized grids, keyboard-first data entry. That is a reasonable description of how staff work *today*.

Two things change it:

1. **The public registration form is phone-first.** Participants will open a shared link on a phone, often on a slow connection, sometimes on an old device.
2. **Staff already use phones.** Attendance is taken at the workshop, not at a desk. Certificate lookup happens in the hallway.

Responsive layout is cheapest to build into the token layer in Phase 0 and most expensive to retrofit in Phase 4. Treat "works at 320 px" as an acceptance criterion from the first screen, not a cleanup task.

---

## 2. Breakpoints

Four breakpoints, aligned to real device widths rather than round numbers.

| Name | Width | Targets | Layout |
| --- | --- | --- | --- |
| `xs` | < 480 px | Phones (portrait) | Single column, bottom tab bar |
| `sm` | 480–767 px | Large phones, small tablets (portrait) | Single column, wider gutters |
| `md` | 768–1023 px | Tablets (landscape), small laptops | Two columns, collapsible sidebar |
| `lg` | ≥ 1024 px | Desktops | Full sidebar + content, multi-column forms |

```css
/* src/styles/breakpoints.css */
:root {
  --bp-xs: 0;
  --bp-sm: 480px;
  --bp-md: 768px;
  --bp-lg: 1024px;
}
```

**Mobile-first.** Base styles target `xs`; larger breakpoints add. This is not stylistic preference — the public form is the lowest-common-denominator surface, and building it last means building it twice.

---

## 3. Navigation

### 3.1 Staff app

| Breakpoint | Pattern |
| --- | --- |
| `lg` | Persistent left sidebar (the current design) |
| `md` | Sidebar collapses to icons; expands on tap |
| `sm` / `xs` | **Bottom tab bar** — 4 primary destinations + "More" |

The bottom tab bar carries only what staff actually do on a phone:

1. **Workshops**
2. **Participants**
3. **Attendance** (today's workshops)
4. **Scan / Lookup**
5. **More** → everything else, including reports and admin

Reports, utilities, and admin are **not** in the tab bar. They are desktop tasks, and burying them is correct.

### 3.2 Public form

No navigation at all. One linear flow, one primary action per screen. A "Back" control within the flow and nothing else — no menu, no footer links that lead away from registering.

---

## 4. Per-screen mobile treatment

The screen inventory from the migration plan (§7.2), re-specified for small screens.

| # | Screen | Desktop | Mobile |
| --- | --- | --- | --- |
| 1 | Dashboard | Multi-column card grid | Single column, stacked cards; counts first, charts below |
| 2 | Workshops list | Virtualized grid, many columns | Card list: title, date, status pill, seats filled. Filter as a sheet. |
| 3 | Workshop detail | Tabs across the top | Tabs become a scrollable segmented control; subforms stack |
| 4 | Workshop catalog | Table + rich-text editor | List + full-screen editor |
| 5 | Participants list | Grid with many columns | Card list: name, agency, email. Search pinned at top. |
| 6 | Participant detail | Multi-column form | Single column; sections collapse |
| 7 | Agencies | Grid | Card list; address block collapsible |
| 8 | Presenters & staff | Grid | Card list |
| 9 | Registrations | Inline editable grid | Card list per participant; edit in a sheet |
| 10 | **Attendance** | Checklist grid | **Optimised for phone** — large tap targets, sticky header, works one-handed |
| 11 | Payments & receipts | Form + grid | Single-column form |
| 12 | Credit slips | Grid | Card list |
| 13 | Training requests | Multi-pane workflow | Stepper: quote → schedule → invoice |
| 14 | Community events | Grid | Card list |
| 15 | eSchools reconciliation | Side-by-side columns | Stacked: eSchools count above, internal count below, difference highlighted |
| 16 | Folder builder | Pick workshop → packet | Desktop-only. Show a "best on a larger screen" notice. |
| 17 | Reports hub | Parameter form + wide preview | Parameter form single-column; preview scaled to fit; **Download PDF** primary |
| 18 | Mailing lists | Build + preview + export | Build + export only; preview is desktop |
| 19 | Utilities | Grid of actions | Card list; destructive actions require an extra confirm |
| 20 | Admin | Tables | Card list; user management desktop-only |

**Screens 16 and 20 are desktop-only by design.** Saying so explicitly is better than shipping a cramped version.

### 4.1 Attendance is the priority mobile screen

Attendance is the one screen staff will genuinely use standing up, in a room, with a phone in one hand. It deserves more than a responsive reflow:

- One row per participant, full-width, ≥ 56 px tall
- A single large toggle: **Present / Absent / Late**
- Sticky workshop header with the count ("18 of 20 marked")
- Save on change, not on a submit button — no lost work if the phone locks
- Works with poor connectivity: queue changes locally, sync when back online

This is the strongest candidate for offline support (see §7).

---

## 5. Component conventions

Extending the WCPSS token layer from the migration plan (§4.3).

| Component | Mobile rule |
| --- | --- |
| **Buttons** | Full-width primary action at the bottom of the screen; ≥ 44 px tall |
| **Tables** | Never horizontally scroll a data grid on `xs`. Use card rows. |
| **Forms** | One field per row; labels above inputs; no placeholder-as-label |
| **Modals** | Become full-screen sheets on `xs` |
| **Pills** | Keep the existing colours; do not shrink below 24 px tall |
| **Toasts** | Bottom-anchored, above the tab bar |
| **Date pickers** | Native `<input type="date">` on mobile — the OS picker beats any custom one |
| **Search** | Pinned to the top of the screen, not inside a scrolling container |

### 5.1 Input modes

Getting the keyboard right is the cheapest usability win available.

| Field | Attributes |
| --- | --- |
| Phone | `type="tel" inputmode="tel" autocomplete="tel"` |
| Email | `type="email" inputmode="email" autocomplete="email"` |
| ZIP | `inputmode="numeric" autocomplete="postal-code"` |
| Currency | `inputmode="decimal"` |
| Name | `autocomplete="given-name"` / `"family-name"` |
| Address | `autocomplete="street-address"` |

Autocomplete matters more than it looks — it removes most of the typing on a phone, and it is an accessibility win for users with motor difficulties.

---

## 6. Accessibility — WCAG 2.1 AA

Applies to both surfaces; the public form is non-negotiable and the staff app should match.

| Criterion | Requirement |
| --- | --- |
| 1.4.3 Contrast | 4.5:1 body text, 3:1 large text. `#165788` on white is 7.4:1. Never white on `#fed100` or `#BED600`. |
| 1.4.4 Resize | Usable at 200% zoom |
| 1.4.10 Reflow | No horizontal scrolling at 320 px width |
| 1.4.11 Non-text contrast | 3:1 for borders, icons, focus indicators |
| 2.1.1 Keyboard | Every action reachable without a mouse |
| 2.4.3 Focus order | Logical; focus moves to first error on submit |
| 2.4.7 Focus visible | Always visible — never `outline: none` without a replacement |
| 2.5.5 Target size | ≥ 44×44 px |
| 3.3.1 Error identification | Text, not just a red border |
| 3.3.2 Labels | Visible labels; placeholders are not labels |
| 4.1.3 Status messages | `role="status"` / `role="alert"` for async results |

**Testing:** keyboard-only pass, VoiceOver (iOS) and TalkBack (Android) pass, and an automated axe scan in CI. Automated tools catch roughly a third of issues — the manual passes are the real gate.

---

## 7. Offline and poor connectivity

Workshop sites may have weak signal. Decide this in Phase 0, not Phase 4.

| Level | What it buys | Cost |
| --- | --- | --- |
| **None** | Simplest | Attendance fails in a basement room |
| **Optimistic UI + retry queue** (recommended start) | Attendance feels instant; changes retry on reconnect | Moderate — needs a durable local queue |
| **Full PWA with offline data** | Works fully offline | High — conflict resolution, cache invalidation, much more surface area |

**Recommendation:** start with optimistic UI plus a durable retry queue, scoped to attendance only. A service worker that caches the app shell is worth adding at the same time. Full offline data sync is a separate decision and should not block Phase 2.

---

## 8. Performance budget

Mobile users are on real networks, not office Wi-Fi.

| Metric | Budget |
| --- | --- |
| Public form — first load (JS + CSS, gzipped) | ≤ 150 KB |
| Public form — Largest Contentful Paint on 4G | ≤ 2.5 s |
| Staff app — first load | ≤ 400 KB |
| Images | WebP/AVIF; no image above 200 KB |
| Fonts | `font-display: swap`; subset Open Sans and Solway |

The public form's budget is deliberately tight. It is the page a stranger opens from a text message, and it is the only page where a slow load costs a registration.

---

## 9. Testing

| Test | Gate |
| --- | --- |
| 320 px viewport | No horizontal scroll on any screen |
| Real low-end Android device | Manual pass per phase |
| iOS Safari | Manual pass per phase |
| Keyboard only | Every flow completable |
| Screen reader | VoiceOver + TalkBack pass on the public form |
| axe scan | Zero critical issues in CI |
| Slow 3G throttle | Public form usable within 5 s |

---

## 10. Delivery

| Phase | Work |
| --- | --- |
| **0** | Breakpoints and responsive primitives in the token layer; bottom tab bar shell; decide offline scope |
| **2** | Every staff screen built responsive from the start; attendance optimised for phone |
| **3** | Public form built mobile-first against the performance budget |
| **4** | Offline retry queue for attendance; accessibility audit pass |

**Exit criteria:** a staff member takes attendance for a live workshop on a phone, and a participant registers from a phone, both without horizontal scrolling and both passing an axe scan.
