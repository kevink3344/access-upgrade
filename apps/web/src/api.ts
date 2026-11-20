import type { AuthUser, LoginResponse, ApiError } from '@pe/shared';

const TOKEN_KEY = 'pe.access_token';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();

  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = body as ApiError | null;
    throw new HttpError(
      res.status,
      err?.error ?? 'request_failed',
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }

  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<AuthUser>('/api/auth/me'),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  dashboard: () => request<import('@pe/shared').DashboardSummary>('/api/dashboard'),

  users: {
    list: (params: { q?: string; role?: string; isActive?: boolean } = {}) => {
      const qs = new URLSearchParams();
      if (params.q) qs.set('q', params.q);
      if (params.role) qs.set('role', params.role);
      if (params.isActive !== undefined) qs.set('isActive', String(params.isActive));
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<{ data: AuthUser[]; total: number }>(`/api/users${suffix}`);
    },

    create: (body: {
      email: string;
      displayName: string;
      password: string;
      role: AuthUser['role'];
      isActive?: boolean;
    }) => request<AuthUser>('/api/users', { method: 'POST', body: JSON.stringify(body) }),

    update: (
      id: number,
      body: Partial<{
        email: string;
        displayName: string;
        password: string;
        role: AuthUser['role'];
        isActive: boolean;
      }>,
    ) => request<AuthUser>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

    deactivate: (id: number) => request<void>(`/api/users/${id}`, { method: 'DELETE' }),
  },

  workshops: {
    list: (params: {
      page?: number;
      pageSize?: number;
      q?: string;
      schoolYear?: number;
      category?: number;
      status?: 'open' | 'closed' | 'cancelled' | 'all';
      sort?: 'startDate' | 'code' | 'name' | 'registered';
      dir?: 'asc' | 'desc';
    } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').WorkshopListResponse>(`/api/workshops${suffix}`);
    },

    get: (id: number) =>
      request<import('@pe/shared').WorkshopDetail>(`/api/workshops/${id}`),

    create: (body: import('@pe/shared').WorkshopWrite) =>
      request<{ workshopId: number }>('/api/workshops', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    update: (id: number, body: Partial<import('@pe/shared').WorkshopWrite>) =>
      request<{ workshopId: number }>(`/api/workshops/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    remove: (id: number) => request<void>(`/api/workshops/${id}`, { method: 'DELETE' }),

    sessions: (id: number) =>
      request<{ data: import('@pe/shared').WorkshopSessionRow[] }>(`/api/workshops/${id}/sessions`),

    /** Workshop catalog titles for the picker. */
    lookupNames: () =>
      request<{ data: import('@pe/shared').LookupOption[] }>('/api/workshops/lookup-names'),
  },

  participants: {
    list: (params: {
      page?: number;
      pageSize?: number;
      q?: string;
      agencyId?: number;
      sort?: 'name' | 'email' | 'agency';
      dir?: 'asc' | 'desc';
    } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').ParticipantListResponse>(`/api/participants${suffix}`);
    },

    get: (id: number) =>
      request<import('@pe/shared').ParticipantDetail>(`/api/participants/${id}`),

    create: (body: import('@pe/shared').ParticipantWrite) =>
      request<{ participantId: number }>('/api/participants', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    update: (id: number, body: Partial<import('@pe/shared').ParticipantWrite>) =>
      request<{ participantId: number }>(`/api/participants/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    remove: (id: number) => request<void>(`/api/participants/${id}`, { method: 'DELETE' }),

    registrations: (id: number) =>
      request<{ data: import('@pe/shared').ParticipantRegistrationRow[] }>(
        `/api/participants/${id}/registrations`,
      ),

    checkDuplicate: (params: {
      email?: string;
      firstName?: string;
      lastName?: string;
      excludeId?: number;
    }) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      return request<{ data: import('@pe/shared').DuplicateMatch[] }>(
        `/api/participants/check-duplicate?${qs}`,
      );
    },
  },

  agencies: {
    list: (params: { page?: number; pageSize?: number; q?: string; includeOutOfBusiness?: boolean } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').AgencyListResponse>(`/api/agencies${suffix}`);
    },
    get: (id: number) => request<Record<string, unknown>>(`/api/agencies/${id}`),
  },

  registrationLink: {
    get: (workshopId: number) =>
      request<import('@pe/shared').RegistrationLinkState>(
        `/api/workshops/${workshopId}/registration-link`,
      ),

    create: (workshopId: number, body: { rotate?: boolean; webSeatCap?: number | null } = {}) =>
      request<{ registrationLinkId: number; slug: string; url: string; isActive: boolean }>(
        `/api/workshops/${workshopId}/registration-link`,
        { method: 'POST', body: JSON.stringify(body) },
      ),

    update: (
      workshopId: number,
      body: { isActive?: boolean; webSeatCap?: number | null },
    ) =>
      request<{ ok: true }>(`/api/workshops/${workshopId}/registration-link`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  },

  publicRegistration: {
    resolve: (slug: string) =>
      request<import('@pe/shared').PublicLinkState>(`/api/public/registration-links/${slug}`),

    register: (slug: string, body: import('@pe/shared').PublicRegisterRequest) =>
      request<{ registered: true; registrationId: number; message: string }>(
        `/api/public/registration-links/${slug}/register`,
        { method: 'POST', body: JSON.stringify(body) },
      ),

    agencies: (q: string) =>
      request<{ data: { id: number; label: string }[] }>(
        `/api/public/agencies?q=${encodeURIComponent(q)}`,
      ),
  },

  lookups: {
    list: () => request<{ data: string[] }>('/api/lookups'),
    get: (name: string) =>
      request<{ data: { id: number; label: string }[] }>(`/api/lookups/${name}`),
  },

  registrations: {
    list: (params: {      page?: number;
      pageSize?: number;
      q?: string;
      workshopId?: number;
      participantId?: number;
      source?: 'Manual' | 'Web' | 'ESchools';
      status?: 'all' | 'active' | 'cancelled' | 'attended' | 'unpaid';
    } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').RegistrationListResponse>(`/api/registrations${suffix}`);
    },

    get: (id: number) =>
      request<import('@pe/shared').RegistrationDetail>(`/api/registrations/${id}`),

    create: (body: import('@pe/shared').RegistrationWrite) =>
      request<{ registrationId: number }>('/api/registrations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    update: (id: number, body: Partial<import('@pe/shared').RegistrationWrite>) =>
      request<{ registrationId: number }>(`/api/registrations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    cancel: (id: number) => request<void>(`/api/registrations/${id}`, { method: 'DELETE' }),

    lookupParticipants: (q: string) =>
      request<{ data: { id: number; label: string }[] }>(
        `/api/registrations/lookup-participants?q=${encodeURIComponent(q)}`,
      ),

    lookupWorkshops: (q: string) =>
      request<{ data: { id: number; label: string }[] }>(
        `/api/registrations/lookup-workshops?q=${encodeURIComponent(q)}`,
      ),
  },
};
