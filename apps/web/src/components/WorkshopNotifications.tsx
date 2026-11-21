import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

/**
 * Capacity notification settings for one workshop.
 *
 * The threshold is per workshop because a 300-seat conference and an 8-seat
 * observation have very different notions of "nearly full".
 */
export function WorkshopNotifications({
  workshopId,
  canEdit,
}: {
  workshopId: number;
  canEdit: boolean;
}) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['workshop-notification-settings', workshopId],
    queryFn: () => api.workshops.notificationSettings(workshopId),
  });

  // Blank means "off"; otherwise 1-100.
  const [threshold, setThreshold] = useState<string>('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setThreshold(data.notifyPercentFull === null ? '' : String(data.notifyPercentFull));
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const trimmed = threshold.trim();
      const value = trimmed === '' ? null : Number(trimmed);
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > 100)) {
        throw new Error('Enter a whole number between 1 and 100, or leave it blank to turn alerts off.');
      }
      return api.workshops.setNotificationSettings(workshopId, value);
    },
    onSuccess: () => {
      setNotice('Notification settings saved.');
      setError(null);
      qc.invalidateQueries({ queryKey: ['workshop-notification-settings', workshopId] });
    },
    onError: (e: Error) => {
      setError(e.message);
      setNotice(null);
    },
  });

  if (isLoading) {
    return (
      <div>
        {[0, 1].map((i) => (
          <div key={i} className="skeleton" style={{ height: 44, marginBottom: 10 }} />
        ))}
      </div>
    );
  }

  if (!data) {
    return <div className="roster-empty">Could not load notification settings.</div>;
  }

  const { capacity, registered, percentFull, lastNotifiedAt } = data;
  const hasCapacity = capacity !== null && capacity > 0;
  const thresholdNum = threshold.trim() === '' ? null : Number(threshold);
  const willFire =
    hasCapacity && thresholdNum !== null && percentFull !== null && percentFull >= thresholdNum;

  return (
    <div>
      <p className="roster-summary">
        <strong>{registered}</strong> registered
        {hasCapacity && (
          <>
            {' of '}
            <strong>{capacity}</strong> places
          </>
        )}
        {percentFull !== null && (
          <>
            {' · '}
            <strong>{percentFull}%</strong> full
          </>
        )}
      </p>

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

      {!hasCapacity && (
        <div className="alert alert-info" role="note">
          <span>
            This workshop has no maximum enrollment, so a percentage threshold cannot be
            calculated. Set a capacity on the Details tab first.
          </span>
        </div>
      )}

      <fieldset className="fieldset" disabled={!canEdit || !hasCapacity}>
        <legend>Capacity alert</legend>

        <label className="checkbox" style={{ marginBottom: 14 }}>
          <input
            type="checkbox"
            checked={threshold.trim() !== ''}
            onChange={(e) => setThreshold(e.target.checked ? '80' : '')}
          />
          <span>Notify admins when this workshop is nearly full</span>
        </label>

        <div className="field" style={{ maxWidth: 240 }}>
          <label htmlFor="notif-threshold">Percent full</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              id="notif-threshold"
              type="number"
              min={1}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              disabled={threshold.trim() === ''}
              style={{ width: 90 }}
            />
            <span style={{ color: 'var(--text-muted)' }}>%</span>
          </div>
          <span className="field-hint">
            Between 1 and 100. Leave the box unticked to turn alerts off for this workshop.
          </span>
        </div>

        {willFire && (
          <div className="alert alert-info" role="note">
            <span>
              This workshop is already {percentFull}% full, so saving will raise the alert now.
            </span>
          </div>
        )}

        {lastNotifiedAt && (
          <p className="field-hint">
            Last alerted {new Date(lastNotifiedAt).toLocaleString('en-US')}. The alert fires once
            per threshold; it re-arms if the workshop drops back below it.
          </p>
        )}

        {canEdit && hasCapacity && (
          <div className="drawer-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => save.mutate()}
              disabled={save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save notification settings'}
            </button>
          </div>
        )}
      </fieldset>

      <p className="field-hint">
        Notifications appear in the bell at the top of the screen, for administrators only. Email
        is not sent yet.
      </p>
    </div>
  );
}
