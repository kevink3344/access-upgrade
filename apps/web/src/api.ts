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
  // "Remember me" stores in localStorage so the session survives a browser
  // restart; otherwise sessionStorage keeps it to the current tab.
  return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null, remember = false): void {
  // Always clear both stores so switching modes can't leave a stale token
  // behind in the other one.
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);

  if (!token) return;
  if (remember) localStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.setItem(TOKEN_KEY, token);
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
  login: (email: string, password: string, rememberMe = false) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, rememberMe }),
    }),

  me: () => request<AuthUser>('/api/auth/me'),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  dashboard: () => request<import('@pe/shared').DashboardSummary>('/api/dashboard'),

  /** Non-sensitive UI config, e.g. the deployment badge. */
  config: () => request<{ mode: string | null }>('/health/config'),

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

    /** Registrant roster for the Registrants tab. */
    registrants: (
      id: number,
      params: {
        status?: 'active' | 'cancelled' | 'all';
        q?: string;
        page?: number;
        pageSize?: number;
      } = {},
    ) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').WorkshopRegistrantsResponse>(
        `/api/workshops/${id}/registrants${suffix}`,
      );
    },

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
    get: (id: number) => request<import('@pe/shared').AgencyDetail>(`/api/agencies/${id}`),
    create: (body: import('@pe/shared').AgencyWrite) =>
      request<{ agencyId: number }>('/api/agencies', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: number, body: Partial<import('@pe/shared').AgencyWrite>) =>
      request<{ agencyId: number }>(`/api/agencies/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    remove: (id: number) => request<void>(`/api/agencies/${id}`, { method: 'DELETE' }),
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

  presenters: {
    list: (params: { page?: number; pageSize?: number; q?: string; includeRetired?: boolean } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').PresenterListResponse>(`/api/presenters${suffix}`);
    },
    get: (id: number) => request<import('@pe/shared').PresenterDetail>(`/api/presenters/${id}`),
    workshops: (id: number) =>
      request<{
        data: {
          WorkshopID: number;
          WorkshopCode: string | null;
          WorkshopName: string | null;
          StartDate: string | null;
          SchoolYear: string | null;
        }[];
      }>(`/api/presenters/${id}/workshops`),
    create: (body: import('@pe/shared').PresenterWrite) =>
      request<{ presenterStaffId: number }>('/api/presenters', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: number, body: Partial<import('@pe/shared').PresenterWrite>) =>
      request<{ presenterStaffId: number }>(`/api/presenters/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    remove: (id: number) => request<void>(`/api/presenters/${id}`, { method: 'DELETE' }),
  },

  workshopNames: {
    list: (params: {
      page?: number;
      pageSize?: number;
      q?: string;
      includeUnused?: boolean;
      sort?: 'newest' | 'title';
    } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').WorkshopNameListResponse>(`/api/workshop-names${suffix}`);
    },
    get: (id: number) =>
      request<import('@pe/shared').WorkshopNameDetail>(`/api/workshop-names/${id}`),
    workshops: (id: number) =>
      request<{
        data: {
          WorkshopID: number;
          WorkshopCode: string | null;
          StartDate: string | null;
          SchoolYear: string | null;
        }[];
      }>(`/api/workshop-names/${id}/workshops`),
    create: (body: import('@pe/shared').WorkshopNameWrite) =>
      request<{ workshopNameId: number }>('/api/workshop-names', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: number, body: Partial<import('@pe/shared').WorkshopNameWrite>) =>
      request<{ workshopNameId: number }>(`/api/workshop-names/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    remove: (id: number) => request<void>(`/api/workshop-names/${id}`, { method: 'DELETE' }),
  },

  payments: {
    list: (params: {
      page?: number;
      pageSize?: number;
      q?: string;
      paymentMethodId?: number;
      status?: 'all' | 'paid' | 'unpaid' | 'refunded';
      from?: string;
      to?: string;
      includeCancelled?: boolean;
    } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').PaymentListResponse>(`/api/payments${suffix}`);
    },
    get: (registrationId: number) =>
      request<import('@pe/shared').PaymentDetail>(`/api/payments/${registrationId}`),
    summary: () => request<import('@pe/shared').PaymentSummary>('/api/payments/summary'),
    update: (registrationId: number, body: Partial<import('@pe/shared').PaymentWrite>) =>
      request<{ registrationId: number }>(`/api/payments/${registrationId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  },

  lookups: {
    list: () => request<{ data: string[] }>('/api/lookups'),
    get: (name: string) =>
      request<{ data: { id: number; label: string }[] }>(`/api/lookups/${name}`),
  },

  certificates: {
    capabilities: () => request<{ pdfRendering: boolean }>('/api/certificates/capabilities'),

    templates: (schoolYearId: number) =>
      request<{ data: import('@pe/shared').CertificateTemplateRow[] }>(
        `/api/certificates/templates?schoolYearId=${schoolYearId}`,
      ),

    updateTemplate: (id: number, body: import('@pe/shared').CertificateTemplateWrite) =>
      request<{ certificateTemplateId: number }>(`/api/certificates/templates/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    uploadLogo: (id: number, body: { data: string; contentType: string; fileName?: string }) =>
      request<{ certificateTemplateId: number; logoAssetId: number }>(
        `/api/certificates/templates/${id}/logo`,
        { method: 'POST', body: JSON.stringify(body) },
      ),

    eligible: (params: { schoolYearId: number; q?: string; page?: number; pageSize?: number }) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      return request<import('@pe/shared').CertificateEligibleResponse>(
        `/api/certificates/eligible?${qs}`,
      );
    },

    override: (participantId: number, schoolYearId: number, certificateType: 'CEU' | 'CHC') =>
      request<{ data: import('@pe/shared').CertificateOverrideRow | null }>(
        `/api/certificates/overrides/${participantId}?schoolYearId=${schoolYearId}&certificateType=${certificateType}`,
      ),

    saveOverride: (participantId: number, body: import('@pe/shared').CertificateOverrideWrite) =>
      request<{ participantId: number; saved: boolean }>(
        `/api/certificates/overrides/${participantId}`,
        { method: 'PUT', body: JSON.stringify(body) },
      ),

    /** Returns a blob URL for the rendered PDF. */
    pdfUrl: (participantId: number, schoolYearId: number, certificateType: 'CEU' | 'CHC') =>
      `/api/certificates/pdf/${participantId}?schoolYearId=${schoolYearId}&certificateType=${certificateType}`,

    previewUrl: (participantId: number, schoolYearId: number, certificateType: 'CEU' | 'CHC') =>
      `/api/certificates/preview/${participantId}?schoolYearId=${schoolYearId}&certificateType=${certificateType}`,
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
