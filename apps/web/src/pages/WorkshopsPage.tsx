import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkshopRow } from '@pe/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppShell } from '../components/AppShell';
import { IconWorkshops } from '../components/icons';
import { WorkshopDrawer } from '../components/WorkshopDrawer';
import { WorkshopCalendar, monthLabel, ymd } from '../components/WorkshopCalendar';
import { CalendarDayPanel } from '../components/CalendarDayPanel';
import { useRecentVisits, relativeTime } from '../hooks/useRecentVisits';

type View = 'table' | 'calendar';

const VIEW_KEY = 'pe.workshops.view';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'table';
  } catch {
    return 'table';
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function StatusPill({ w }: { w: WorkshopRow }) {
  if (w.isCancelled) return <span className="pill pill-cancelled">Cancelled</span>;
  if (w.isClosed) return <span className="pill pill-closed">Closed</span>;
  if (w.capacity !== null && w.capacity > 0 && w.registered >= w.capacity) {
    return <span className="pill pill-full">Full</span>;
  }
  return <span className="pill pill-open">Open</span>;
}

function Capacity({ registered, capacity }: { registered: number; capacity: number | null }) {
  if (capacity === null || capacity <= 0) {
    return <span className="capacity"><span className="txt">{registered} registered</span></span>;
  }
  const pct = Math.min(100, Math.round((registered / capacity) * 100));
  const cls = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
  return (
    <span className="capacity">
      <span className="bar" aria-hidden="true">
        <i className={cls} style={{ width: `${pct}%` }} />
      </span>
      <span className="txt">{registered}/{capacity}</span>
    </span>
  );
}

export function WorkshopsPage() {
  const { user } = useAuth();
  const canEdit = user && ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EDITOR'].includes(user.role);
  const canDelete = user && ['SUPER_ADMIN', 'ADMIN'].includes(user.role);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<'all' | 'open' | 'closed' | 'cancelled'>('all');
  const [schoolYear, setSchoolYear] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'startDate' | 'code' | 'name' | 'registered'>('startDate');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');

  const [view, setView] = useState<View>(readView);
  // Calendar cursor. Seeded from the current school year once that loads.
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [cursorSeeded, setCursorSeeded] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const recent = useRecentVisits('pe.recentWorkshops');

  const pageSize = 25;

  // Deep link: /workshops?edit=<id> opens that workshop straight away.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('edit');
    if (id && /^\d+$/.test(id)) {
      setEditingId(Number(id));
      setDrawerOpen(true);
      // Drop the query so closing the drawer does not reopen it.
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: years } = useQuery({
    queryKey: ['lookup', 'school-years'],
    queryFn: () => api.lookups.schoolYears(),
    staleTime: 10 * 60_000,
  });

  // The calendar opens on the current school year, not on today: the data
  // spans 2001-2027, so "today" alone would show an almost empty month.
  const currentYear = years?.data.find((y) => !y.isPastYear) ?? years?.data[0];

  useEffect(() => {
    if (cursorSeeded || !currentYear?.beginDate) return;
    const begin = new Date(`${currentYear.beginDate.slice(0, 10)}T00:00:00`);
    const now = new Date();
    // Land on the current month if it falls inside the school year,
    // otherwise on the year's opening month (July).
    const inYear = now >= begin && now <= new Date(`${currentYear.endDate?.slice(0, 10)}T00:00:00`);
    const target = inYear ? now : begin;
    setCursor({ year: target.getFullYear(), month: target.getMonth() });
    setCursorSeeded(true);
  }, [currentYear, cursorSeeded]);

  // The month grid shows 6 weeks, so the range reaches into the neighbouring
  // months — otherwise the leading/trailing cells would look empty.
  const range = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1);
    const from = new Date(first);
    from.setDate(1 - first.getDay());
    const to = new Date(from);
    to.setDate(from.getDate() + 41);
    return { from: ymd(from), to: ymd(to) };
  }, [cursor]);

  const calendar = useQuery({
    queryKey: ['workshops', 'calendar', range.from, range.to, debounced, status, schoolYear],
    queryFn: () =>
      api.workshops.calendar({
        from: range.from,
        to: range.to,
        q: debounced || undefined,
        status,
        schoolYear: schoolYear ? Number(schoolYear) : undefined,
      }),
    enabled: view === 'calendar',
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['workshops', debounced, status, schoolYear, page, sort, dir],
    queryFn: () =>
      api.workshops.list({
        page,
        pageSize,
        q: debounced || undefined,
        status,
        schoolYear: schoolYear ? Number(schoolYear) : undefined,
        sort,
        dir,
      }),
    enabled: view === 'table',
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  function changeView(next: View) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* storage is a convenience; the toggle still works without it */
    }
  }

  function shiftMonth(delta: number) {
    setCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function toggleSort(col: typeof sort) {
    if (sort === col) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(col);
      setDir(col === 'name' || col === 'code' ? 'asc' : 'desc');
    }
    setPage(1);
  }

  function sortIndicator(col: typeof sort) {
    if (sort !== col) return '';
    return dir === 'asc' ? ' ▲' : ' ▼';
  }

  function openCreate() {
    setEditingId(null);
    setDrawerOpen(true);
  }

  function openEdit(id: number) {
    setEditingId(id);
    setDrawerOpen(true);

      // Record the visit for the "recently visited" chips. The row may not be
      // on the current page, so fall back to what the list already knows.
      const row = rows.find((r) => r.workshopId === id);
      if (row) {
        recent.record({
          id,
          title: row.workshopName ?? 'Untitled workshop',
          subtitle: row.workshopCode,
        });
      }
  }

  /**
   * The roster is read-only, so a row hands off to the Registrations screen
   * with that record open rather than editing in place.
   */
  function openRegistration(registrationId: number) {
    window.history.pushState({}, '', `/registrations?edit=${registrationId}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  return (
    <AppShell currentPath="/workshops" title="Workshops">
      <div className="page-head">
        <div>
          <h2>Workshops</h2>
          <p>Every scheduled offering, across all school years.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add workshop
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field toolbar-search">
          <label htmlFor="ws-search" className="visually-hidden">Search workshops</label>
          <input
            id="ws-search"
            type="search"
            placeholder="Search title or code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="field toolbar-select">
          <label htmlFor="ws-status" className="visually-hidden">Status</label>
          <select
            id="ws-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setPage(1);
            }}
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div className="field toolbar-select">
          <label htmlFor="ws-year" className="visually-hidden">School year</label>
          <select
            id="ws-year"
            value={schoolYear}
            onChange={(e) => {
              setSchoolYear(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All school years</option>
            {years?.data.map((y) => (
              <option key={y.id} value={y.id}>{y.label}</option>
            ))}
          </select>
        </div>

        <div className="segmented" role="group" aria-label="View">
          <button
            type="button"
            className={view === 'table' ? 'is-active' : ''}
            aria-pressed={view === 'table'}
            onClick={() => changeView('table')}
          >
            Table
          </button>
          <button
            type="button"
            className={view === 'calendar' ? 'is-active' : ''}
            aria-pressed={view === 'calendar'}
            onClick={() => changeView('calendar')}
          >
            Calendar
          </button>
        </div>

        <span className="toolbar-count">
          {view === 'calendar'
            ? `${(calendar.data?.data.length ?? 0).toLocaleString()} this month`
            : `${total.toLocaleString()} workshops`}
        </span>
      </div>

      {recent.items.length > 0 && (
        <section className="recent-visits" aria-label="Recently visited workshops">
          <div className="recent-visits-head">
            <span className="recent-visits-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              Recently visited
            </span>
            <button type="button" className="link-button recent-clear" onClick={recent.clear}>
              Clear
            </button>
          </div>

          <div className="recent-chips">
            {recent.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="recent-chip"
                onClick={() => openEdit(item.id)}
                title={`Open ${item.title}`}
              >
                <span className="recent-chip-title">{item.title}</span>
                {item.subtitle && <span className="recent-chip-sub">{item.subtitle}</span>}
                <span className="recent-chip-time">{relativeTime(item.visitedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {isError && (
        <div className="alert alert-error" role="alert">
          <span>
            Could not load workshops.
            {error instanceof Error ? ` ${error.message}` : ''}
          </span>
        </div>
      )}

      {view === 'calendar' ? (
        <div className="panel">
          <div className="cal-head">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
            >
              ◀
            </button>
            <h3 className="cal-title">{monthLabel(cursor.year, cursor.month)}</h3>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
            >
              ▶
            </button>
            <span className="cal-spacer" />
            {currentYear && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  const now = new Date();
                  setCursor({ year: now.getFullYear(), month: now.getMonth() });
                }}
              >
                Today
              </button>
            )}
          </div>

          <div className="panel-body">
            {calendar.isLoading ? (
              <div style={{ padding: 18 }}>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeleton" style={{ height: 72, marginBottom: 8 }} />
                ))}
              </div>
            ) : calendar.isError ? (
              <div className="alert alert-error" role="alert">
                <span>
                  Could not load the calendar.
                  {calendar.error instanceof Error ? ` ${calendar.error.message}` : ''}
                </span>
              </div>
            ) : (
              <WorkshopCalendar
                year={cursor.year}
                month={cursor.month}
                entries={calendar.data?.data ?? []}
                selectedDate={selectedDay}
                onOpen={openEdit}
                onPickDay={(date) => {
                  setSelectedDay((cur) => (cur === date ? null : date));
                  const d = new Date(`${date}T00:00:00`);
                  if (d.getMonth() !== cursor.month || d.getFullYear() !== cursor.year) {
                    setCursor({ year: d.getFullYear(), month: d.getMonth() });
                  }
                }}
              />
            )}

            {!!calendar.data?.undated && (
              <p className="cal-note">
                {calendar.data.undated} matching workshop
                {calendar.data.undated === 1 ? '' : 's'} have no start date and cannot be shown
                on the calendar.
              </p>
            )}
          </div>
        </div>
      ) : (
      <div className="panel">
        <div className="panel-body">
          {isLoading ? (
            <div style={{ padding: 18 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <IconWorkshops width={28} height={28} />
              <p style={{ marginTop: 10 }}>
                {debounced || status !== 'all' || schoolYear
                  ? 'No workshops match your filters.'
                  : 'No workshops yet.'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">
                    <button type="button" className="th-sort" onClick={() => toggleSort('name')}>
                      Workshop{sortIndicator('name')}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="th-sort" onClick={() => toggleSort('code')}>
                      Code{sortIndicator('code')}
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" className="th-sort" onClick={() => toggleSort('startDate')}>
                      Date{sortIndicator('startDate')}
                    </button>
                  </th>
                  <th scope="col">School year</th>
                  <th scope="col">
                    <button type="button" className="th-sort" onClick={() => toggleSort('registered')}>
                      Capacity{sortIndicator('registered')}
                    </button>
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.workshopId}>
                    <td data-label="Workshop">
                      {canEdit ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => openEdit(w.workshopId)}
                        >
                          {w.workshopName ?? 'Untitled workshop'}
                        </button>
                      ) : (
                        <strong>{w.workshopName ?? 'Untitled workshop'}</strong>
                      )}
                    </td>
                    <td data-label="Code" className="muted">{w.workshopCode ?? '—'}</td>
                    <td data-label="Date">{fmtDate(w.startDate)}</td>
                    <td data-label="School year" className="muted">{w.schoolYear ?? '—'}</td>
                    <td data-label="Capacity">
                      <Capacity registered={w.registered} capacity={w.capacity} />
                    </td>
                    <td data-label="Status"><StatusPill w={w} /></td>
                    <td data-label="Actions" className="num">
                      <span className="row-actions">
                        {canEdit && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => openEdit(w.workshopId)}
                          >
                            Edit
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {pageCount > 1 && (
          <div className="pager">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </button>
            <span className="pager-info">
              Page {page} of {pageCount.toLocaleString()}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
            >
              Next
            </button>
          </div>
        )}
      </div>
      )}

      {view === 'calendar' && selectedDay && (
        <CalendarDayPanel
          date={selectedDay}
          entries={(calendar.data?.data ?? []).filter((e) => e.date === selectedDay)}
          onOpen={(id) => {
            setSelectedDay(null);
            openEdit(id);
          }}
          onClose={() => setSelectedDay(null)}
        />
      )}

      {drawerOpen && (
        <WorkshopDrawer
          workshopId={editingId}
          canEdit={!!canEdit}
          canDelete={!!canDelete}
          onClose={() => setDrawerOpen(false)}
          onOpenRegistration={openRegistration}
        />
      )}
    </AppShell>
  );
}
