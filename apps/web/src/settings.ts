/**
 * The Settings screen's destinations.
 *
 * These used to be two sidebar groups (Administration and Developer). They
 * live here so the Settings page and the topbar gear share one list and one
 * role rule â€” the gear only appears for roles that have something to reach.
 */
import type { ReactNode } from 'react';
import type { AuthUser } from '@pe/shared';
import {
  IconBell,
  IconAgencies,
  IconApi,
  IconCatalog,
  IconCertificate,
  IconParticipants,
  IconRequests,
  IconSchoolCash,
  IconUsers,
  IconUtilities,
  IconWebhook,
  IconWorkshops,
} from './components/icons';

export interface SettingsItem {
  to: string;
  label: string;
  description: string;
  icon: (p: { width?: number; height?: number }) => ReactNode;
  roles: AuthUser['role'][];
}

export interface SettingsGroup {
  title: string;
  items: SettingsItem[];
}

const ADMINS: AuthUser['role'][] = ['SUPER_ADMIN', 'ADMIN'];
const DESIGNERS: AuthUser['role'][] = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'];

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: 'Administration',
    items: [
      {
        to: '/admin/users',
        label: 'Users',
        description: 'Staff accounts, roles and access.',
        icon: IconUsers,
        roles: ADMINS,
      },
      {
        to: '/admin/certificates',
        label: 'Certificate Designer',
        description: 'Certificate templates and layout.',
        icon: IconCertificate,
        roles: DESIGNERS,
      },
      {
        to: '/admin/forms',
        label: 'Form Designer',
        description: 'Public registration forms and branching.',
        icon: IconRequests,
        roles: DESIGNERS,
      },
      {
        to: '/admin/participants',
        label: 'Participants',
        description: 'Teachers, parents and staff who attend workshops.',
        icon: IconParticipants,
        roles: DESIGNERS,
      },
      {
        to: '/admin/agencies',
        label: 'Agencies',
        description: 'Schools, childcare centres and community organisations.',
        icon: IconAgencies,
        roles: DESIGNERS,
      },
      {
        to: '/settings/dropdown-lists',
        label: 'Dropdown lists',
        description: 'Age groups, payment methods, school years and other picklists.',
        icon: IconCatalog,
        roles: ADMINS,
      },
      {
        to: '/admin/utilities',
        label: 'Utilities',
        description: 'Maintenance tools and data fixes.',
        icon: IconUtilities,
        roles: ADMINS,
      },
      {
        to: '/school-cash',
        label: 'School Cash matching',
        description: 'Match SchoolCash Online payments to registrations.',
        icon: IconSchoolCash,
        roles: ADMINS,
      },
      {
        to: '/admin',
        label: 'Notifications',
        description: 'What the system tells staff about, and how it is delivered.',
        icon: IconBell,
        roles: ADMINS,
      },
      {
        to: '/admin/calendar',
        label: 'Calendar feed',
        description: 'Publish the workshops calendar for Google Calendar and Outlook.',
        icon: IconWorkshops,
        roles: ADMINS,
      },
    ],
  },
  {
    title: 'Developer',
    items: [
      {
        to: '/api-docs',
        label: 'API documentation',
        description: 'Endpoints, payloads and auth.',
        icon: IconApi,
        roles: ADMINS,
      },
      {
        to: '/admin/webhooks',
        label: 'Webhooks',
        description: 'Outbound event subscriptions.',
        icon: IconWebhook,
        roles: ADMINS,
      },
    ],
  },
];

/** Groups filtered to what this role can actually open. */
export function settingsGroupsFor(
  role: AuthUser['role'] | undefined,
): SettingsGroup[] {
  if (!role) return [];
  return SETTINGS_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.roles.includes(role)),
  })).filter((g) => g.items.length > 0);
}

export function canSeeSettings(role: AuthUser['role'] | undefined): boolean {
  return settingsGroupsFor(role).length > 0;
}

/**
 * True when the current path is Settings itself or one of the destinations it
 * lists, so the topbar gear stays lit while you are inside a Settings screen.
 * Derived from the list rather than hard-coded, so moving a destination into
 * Settings cannot leave the gear unlit.
 */
export function isSettingsDestination(
  path: string,
  role: AuthUser['role'] | undefined,
): boolean {
  if (path === '/settings') return true;
  return settingsGroupsFor(role).some((g) =>
    g.items.some((i) => path === i.to || path.startsWith(`${i.to}/`)),
  );
}
