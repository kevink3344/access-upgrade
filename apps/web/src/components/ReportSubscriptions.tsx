import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ReportCatalogueItem,
  ReportDateToken,
  ReportSubscription,
  ReportSubscriptionParams,
} from '@pe/shared';
import { api, HttpError } from '../api';

/**
 * Scheduled report subscriptions, on the Reports hub.
 *
 * A staff member subscribes to the report they are looking at, with the
 * filters they already chose, and the app emails it on a chosen weekday.
 * Date filters are stored as tokens ("last 7 days") rather than the literal
 * dates on screen, so next week's email covers next week.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: `${h === 0 ? 12 : h > 12 ? h - 12 : h}:00 ${h < 12 ? 'AM' : 'PM'}`,
}));

/** The date-range choices offered for a report that takes from/to. */
const RANGES: { value: ReportDateToken; label: string }[] = [
  { value: 'last-7-days', label: 'Last 7 days' },
  { value: 'last-week', label: 'Last week (Mon–Sun)' },
  { value: 'this-week', label: 'This week so far' },
];

/** Turns the on-screen filter values into what a subscription stores. */
function toSubscriptionParams(
  report: ReportCatalogueItem,
  values: Record<string, string>,
): ReportSubscriptionParams {
  const params: ReportSubscriptionParams = {};
  for (const p of report.parameters) {
    const raw = values[p.key];
    if (!raw) continue;
    if (p.type === 'school-year') params.schoolYearId = Number(raw);
    if (p.type === 'category') params.categoryId = Number(raw);
    if (p.type === 'workshop') params.workshopId = Number(raw);
  }
  return params;
}

export function ReportSubscriptions({
  report,
  values,
}: {
  report: ReportCatalogueItem;
  values: Record<string, string>;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(5);
  const [hour, setHour] = useState(7);
  const [range, setRange] = useState<ReportDateToken>('last-7-days');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasDateRange = report.parameters.some((p) => p.type === 'date');

  const { data } = useQuery({
    queryKey: ['report-subscriptions'],
    queryFn: () => api.reports.subscriptions(),
    staleTime: 30_000,
  });

  const mine = (data?.data ?? []).filter((s) => s.reportKey === report.key);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['report-subscriptions'] });
  };

  const subscribe = useMutation({
    mutationFn: () => {
      const params = toSubscriptionParams(report, values);
      if (hasDateRange) {
        params.from = range;
        params.to = range;
      }
      return api.reports.subscribe({ reportKey: report.key, params, dayOfWeek: day, sendHour: hour });
    },
    onSuccess: () => {
      setError(null);
      setNotice(`Subscribed — ${DAYS[day]} at ${HOURS[hour]!.label}.`);
      setOpen(false);
      refresh();
    },
    onError: (e) =>
      setError(e instanceof HttpError ? e.message : 'Could not save the subscription.'),
  });

  const toggle = useMutation({
    mutationFn: (s: ReportSubscription) =>
      api.reports.updateSubscription(s.reportSubscriptionId, { isActive: !s.isActive }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof HttpError ? e.message : 'Could not update it.'),
  });

  const remove = useMutation({
    mutationFn: (s: ReportSubscription) => api.reports.unsubscribe(s.reportSubscriptionId),
    onSuccess: () => {
      setError(null);
      setNotice('Unsubscribed.');
      refresh();
    },
    onError: (e) => setError(e instanceof HttpError ? e.message : 'Could not remove it.'),
  });

  const sendNow = useMutation({
    mutationFn: (s: ReportSubscription) => api.reports.sendSubscriptionNow(s.reportSubscriptionId),
    onSuccess: (r) => {
      setError(null);
      setNotice(
        r.sent
          ? 'Sent — check your inbox.'
          : `Not sent (${r.reason ?? 'unknown reason'}). Check the webhook on the Webhooks screen.`,
      );
      refresh();
    },
    onError: (e) => setError(e instanceof HttpError ? e.message : 'Could not send it.'),
  });

  const busy = subscribe.isPending || toggle.isPending || remove.isPending || sendNow.isPending;

  return (
    <div className="report-subs">
      <div className="report-subs-head">
        <h4>Scheduled email</h4>
        {!open && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
            Subscribe…
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="alert alert-info" role="status">
          <span>{notice}</span>
        </div>
      )}

      {open && (
        <div className="report-subs-form">
          <div className="field">
            <label htmlFor="sub-day">Send on</label>
            <select id="sub-day" value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sub-hour">Time</label>
            <select id="sub-hour" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h.value} value={h.value}>
                  {h.label}
                </option>
              ))}
            </select>
          </div>
          {hasDateRange && (
            <div className="field">
              <label htmlFor="sub-range">Dates</label>
              <select
                id="sub-range"
                value={range}
                onChange={(e) => setRange(e.target.value as ReportDateToken)}
              >
                {RANGES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="row-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => subscribe.mutate()}
              disabled={busy}
            >
              {subscribe.isPending ? 'Saving…' : 'Subscribe'}
            </button>
          </div>
        </div>
      )}

      {mine.length > 0 && (
        <ul className="report-subs-list">
          {mine.map((s) => (
            <li key={s.reportSubscriptionId}>
              <div className="report-subs-line">
                <span>
                  <b>{DAYS[s.dayOfWeek]}</b> at {HOURS[s.sendHour]?.label ?? s.sendHour}
                  {s.params.from && ` · ${RANGES.find((r) => r.value === s.params.from)?.label ?? s.params.from}`}
                </span>
                <span className="muted">
                  {s.lastSentOn ? `Last sent ${s.lastSentOn}` : 'Not sent yet'}
                  {s.lastSend && !s.lastSend.succeeded && ' · last attempt failed'}
                </span>
              </div>
              {s.disabledReason && (
                <p className="field-hint" style={{ color: 'var(--badge-amber-text)' }}>
                  {s.disabledReason}
                </p>
              )}
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => sendNow.mutate(s)}
                  disabled={busy}
                >
                  Send now
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => toggle.mutate(s)}
                  disabled={busy}
                >
                  {s.isActive ? 'Pause' : 'Resume'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => remove.mutate(s)}
                  disabled={busy}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
