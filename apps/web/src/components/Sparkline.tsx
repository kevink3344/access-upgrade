import { useId } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const WIDTH = 160;
const HEIGHT = 44;
const PAD = 3;

/**
 * A 12-point trend line for a stat card: one point per month of the current
 * calendar year, with the month-to-date value as the last point.
 *
 * Drawn as inline SVG rather than a chart library — it has no axes, no
 * tooltip and no legend, and a full chart component would pull a layout
 * engine into every card for a 160px line.
 */
export function Sparkline({
  values,
  label,
  format = (v) => v.toLocaleString('en-US'),
}: {
  /** Twelve monthly values, January first. */
  values: number[];
  /** What the values count, for the accessible summary. */
  label: string;
  format?: (v: number) => string;
}) {
  const gradientId = useId();

  const max = Math.max(...values, 0);
  const step = (WIDTH - PAD * 2) / Math.max(values.length - 1, 1);
  const y = (v: number) => HEIGHT - PAD - (max === 0 ? 0 : (v / max) * (HEIGHT - PAD * 2));

  const points = values.map((v, i) => [PAD + i * step, y(v)] as const);
  const line = points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${PAD},${HEIGHT} ${line} ${(PAD + (values.length - 1) * step).toFixed(1)},${HEIGHT}`;

  const summary = values.map((v, i) => `${MONTHS[i]} ${format(v)}`).join(', ');

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label} by month: ${summary}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
