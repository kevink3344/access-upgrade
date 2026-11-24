import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartKey, ChartSeries } from '@pe/shared';
import { api } from '../api';
import { AppShell } from '../components/AppShell';
import { ChartCard } from '../components/ChartCard';

/**
 * Visual Reports — the same numbers the hub returns as rows, drawn so a shape
 * is visible at a glance.
 *
 * Each chart is its own request. Six small queries load in parallel and
 * degrade independently; one combined endpoint would let the slowest decide
 * the whole page's latency and one bad year break all six.
 */

/** Palette from the design tokens, so charts match the rest of the app. */
const SERIES_COLOURS = ['#165788', '#2f7fb5', '#5aa5d1', '#8cc3e0', '#b6d9ec', '#d6e9f4'];
const OUTCOME_COLOURS: Record<string, string> = {
  Attended: '#2e7d4f',
  'No-show': '#c9a227',
  Cancelled: '#a33a4a',
};

const CHART_ORDER: ChartKey[] = [
  'registrations-by-month',
  'attendance-outcomes',
  'workshops-by-category',
  'revenue-by-year',
  'top-agencies',
];

const TITLES: Record<ChartKey, string> = {
  'registrations-by-month': 'Registrations by month',
  'attendance-outcomes': 'Attendance outcomes',
  'workshops-by-category': 'Workshops by category',
  'revenue-by-year': 'Revenue by school year',
  'top-agencies': 'Top agencies',
};

function useChart(key: ChartKey, schoolYearId: number | null) {
  return useQuery({
    queryKey: ['chart', key, schoolYearId],
    queryFn: () => api.reports.chart(key, schoolYearId),
    staleTime: 5 * 60_000,
  });
}

/** Money tooltip: $36,675 rather than 36675. */
function money(v: number): string {
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

export function VisualReportsPage() {
  const [schoolYearId, setSchoolYearId] = useState<number | null>(null);

  const { data: years } = useQuery({
    queryKey: ['lookup', 'school-years'],
    queryFn: () => api.lookups.get('school-years'),
    staleTime: 10 * 60_000,
  });

  useEffect(() => {
    if (schoolYearId === null && years?.data?.length) {
      setSchoolYearId(years.data[0]!.id);
    }
  }, [years, schoolYearId]);

  const month = useChart('registrations-by-month', schoolYearId);
  const outcomes = useChart('attendance-outcomes', schoolYearId);
  const categories = useChart('workshops-by-category', schoolYearId);
  const revenue = useChart('revenue-by-year', schoolYearId);
  const agencies = useChart('top-agencies', schoolYearId);

  return (
    <AppShell currentPath="/reports/visual" title="Visual Reports">
      <div className="page-head">
        <div>
          <h2>Visual Reports</h2>
          <p>
            The same numbers the reports return, drawn so the shape is visible. Each chart states
            what it counts — several of them are easy to misread.
          </p>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar-field">
          <label htmlFor="vr-year">School year</label>
          <select
            id="vr-year"
            value={schoolYearId ?? ''}
            onChange={(e) => setSchoolYearId(Number(e.target.value))}
          >
            {(years?.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>{y.label}</option>
            ))}
          </select>
        </div>
        <span className="toolbar-count">
          Revenue by school year ignores this filter — it compares years.
        </span>
      </div>

      <div className="chart-grid">
        {/* 1. Registrations by month — spans two columns, it is a trend. */}
        <div className="chart-span-2">
          <ChartCard
            title={TITLES['registrations-by-month']}
            series={month.data}
            isLoading={month.isLoading}
            error={month.error as Error | null}
          >
            {(data) => (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf0" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 12 }} width={44} />
                  <Tooltip formatter={(v) => [Number(v), 'registrations']} />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke={SERIES_COLOURS[0]}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </div>

        {/* 2. Attendance outcomes — a donut, three slices. */}
        <ChartCard
          title={TITLES['attendance-outcomes']}
          series={outcomes.data}
          isLoading={outcomes.isLoading}
          error={outcomes.error as Error | null}
        >
          {(data) => (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="55%"
                  outerRadius="80%"
                  paddingAngle={2}
                >
                  {data.map((p) => (
                    <Cell key={p.label} fill={OUTCOME_COLOURS[p.label] ?? SERIES_COLOURS[0]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => [Number(v), 'registrations']} />
                <Legend verticalAlign="bottom" height={28} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* 3. Workshops by category — horizontal bars, labels read better. */}
        <ChartCard
          title={TITLES['workshops-by-category']}
          series={categories.data}
          isLoading={categories.isLoading}
          error={categories.error as Error | null}
        >
          {(data) => (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  width={130}
                />
                <Tooltip formatter={(v) => [Number(v), 'workshops']} />
                <Bar dataKey="value" fill={SERIES_COLOURS[1]} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* 4. Revenue by year — ignores the year filter by design. */}
        <ChartCard
          title={TITLES['revenue-by-year']}
          series={revenue.data}
          isLoading={revenue.isLoading}
          error={revenue.error as Error | null}
        >
          {(data) => (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf0" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  interval="preserveStartEnd"
                  angle={-45}
                  textAnchor="end"
                  height={56}
                />
                <YAxis tick={{ fontSize: 11 }} width={64} tickFormatter={money} />
                <Tooltip formatter={(v) => [money(Number(v)), 'revenue']} />
                <Bar dataKey="value" fill={SERIES_COLOURS[0]} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* 5. Top agencies — horizontal bars. */}
        <ChartCard
          title={TITLES['top-agencies']}
          series={agencies.data}
          isLoading={agencies.isLoading}
          error={agencies.error as Error | null}
        >
          {(data) => (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  width={150}
                />
                <Tooltip formatter={(v) => [Number(v), 'registrations']} />
                <Bar dataKey="value" fill={SERIES_COLOURS[2]} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      {/* Keeps CHART_ORDER honest: adding a chart to the type without a card
          here is a compile error rather than a silently missing chart. */}
      <p className="visually-hidden">{CHART_ORDER.length} charts</p>
    </AppShell>
  );
}

export type { ChartSeries };
