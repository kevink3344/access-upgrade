import { query, sql } from '../db.js';

/**
 * The look of the login screen's left-hand panel.
 *
 * A workspace-wide choice, stored in `core.NotificationSetting` beside the
 * other workspace settings so it needs no new table. It is public — every
 * visitor sees it before signing in — so the value is served from
 * `/health/config` and must never carry anything sensitive.
 */

export const LOGIN_THEME_KEY = 'ui:login-theme';

export const LOGIN_THEMES = ['blue', 'classroom', 'garden', 'night', 'paper'] as const;
export type LoginTheme = (typeof LOGIN_THEMES)[number];

export const DEFAULT_LOGIN_THEME: LoginTheme = 'blue';

/** Human names and descriptions for the Settings screen. */
export const LOGIN_THEME_META: Record<LoginTheme, { label: string; description: string }> = {
  blue: {
    label: 'WCPSS blue',
    description: 'The default. Deep blue gradient with the orange glow.',
  },
  classroom: {
    label: 'Classroom',
    description: 'Warm sand tones — the most "school" of the set.',
  },
  garden: {
    label: 'Garden',
    description: 'Soft greens, calm and outdoors.',
  },
  night: {
    label: 'Night',
    description: 'Deep slate, for staff who prefer a dark panel.',
  },
  paper: {
    label: 'Paper',
    description: 'A plain light panel with no tint — the quietest option.',
  },
};

export function isLoginTheme(value: unknown): value is LoginTheme {
  return typeof value === 'string' && (LOGIN_THEMES as readonly string[]).includes(value);
}

/**
 * The current theme. A missing row or an unrecognised value falls back to the
 * default rather than failing: the login page must always render.
 *
 * `no-store`: this is read on every login-page load and changes only when an
 * admin picks something, so caching it would show the old panel for a while.
 */
export async function getLoginTheme(): Promise<LoginTheme> {
  try {
    const r = await query<{ SettingValue: string | null }>(
      `SELECT SettingValue FROM core.NotificationSetting WHERE SettingKey = @key`,
      { key: { type: sql.NVarChar(80), value: LOGIN_THEME_KEY } },
    );
    const value = r.recordset[0]?.SettingValue;
    return isLoginTheme(value) ? value : DEFAULT_LOGIN_THEME;
  } catch {
    // The column may not exist yet on a database that has not had migration
    // 036 applied; the login page still has to work.
    return DEFAULT_LOGIN_THEME;
  }
}

export async function setLoginTheme(theme: LoginTheme, updatedBy: string): Promise<void> {
  await query(
    `MERGE core.NotificationSetting AS target
       USING (SELECT @key AS SettingKey) AS source
          ON target.SettingKey = source.SettingKey
     WHEN MATCHED THEN
       UPDATE SET SettingValue = @value, IsEnabled = 1,
                  UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @by
     WHEN NOT MATCHED THEN
       INSERT (SettingKey, IsEnabled, SettingValue, UpdatedAt, UpdatedBy)
       VALUES (@key, 1, @value, SYSUTCDATETIME(), @by)
     OUTPUT INSERTED.SettingValue AS saved;`,
    {
      key: { type: sql.NVarChar(80), value: LOGIN_THEME_KEY },
      value: { type: sql.NVarChar(40), value: theme },
      by: { type: sql.NVarChar(200), value: updatedBy },
    },
  );
}
