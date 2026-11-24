import type { ReactNode } from 'react';
import type { ChartPoint, ChartSeries } from '@pe/shared';

/**
 * The frame every chart sits in.
 *
 * Three things are not optional here:
 *
 *  - `note` is rendered, not hidden. Several charts count something that
 *    reads differently from what a viewer assumes, and the wording comes from
 *    the API next to the query that produced the number.
 *  - An empty series shows a message rather than bare axes.
 *  - A hidden table carries the same numbers, so the data is reachable
 *    without the SVG.
 */
export function ChartCard({
  title,
  series,
  isLoading,
  error,
  height = 280,
  children,
  footnote,
}: {
  title: string;
  series: ChartSeries | undefined;
  isLoading: boolean;
  error: Error | null;
  height?: number;
  children: (data: ChartPoint[], series: ChartSeries) => ReactNode;
  footnote?: string;
}) {
  const data = series?.data ?? [];

  return (
    <section className="chart-card" aria-label={title}>
      <header className="chart-card-head">
        <h3>{title}</h3>
        {series && !series.isEmpty && (
          <p className="chart-card-total">
            {series.unit === 'USD'
              ? `$${Math.round(series.total).toLocaleString('en-US')}`
              : `${series.total.toLocaleString('en-US')} ${series.unit}`}
          </p>
        )}
      </header>

      {isLoading ? (
        <div className="skeleton" style={{ height }} />
      ) : error ? (
        <div className="chart-empty" role="alert">
          Could not load this chart. {error.message}
        </div>
      ) : !series || series.isEmpty ? (
        <div className="chart-empty">No data for this selection.</div>
      ) : (
        <>
          <div className="chart-body" style={{ height }}>
            {children(data, series)}
          </div>

          {/* The numbers, for screen readers and for anyone who wants them. */}
          <table className="visually-hidden">
            <caption>{title}</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.label}>
                  <th scope="row">{p.label}</th>
                  <td>{p.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {(series?.note || footnote) && (
        <p className="chart-card-note">{series?.note ?? footnote}</p>
      )}
    </section>
  );
}
