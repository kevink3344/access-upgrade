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
      sort?: 'upcoming' | 'startDate' | 'code' | 'name' | 'registered';
      dir?: 'asc' | 'desc';
    } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').WorkshopListResponse>(`/api/workshops${suffix}`);
    },

    calendar: (params: {
      from: string;
      to: string;
      q?: string;
      schoolYear?: number;
      status?: 'open' | 'closed' | 'cancelled' | 'all';
    }) => {
      const qs = new URLSearchParams({ from: params.from, to: params.to });
      if (params.q) qs.set('q', params.q);
      if (params.schoolYear) qs.set('schoolYear', String(params.schoolYear));
      if (params.status && params.status !== 'all') qs.set('status', params.status);
      return request<import('@pe/shared').WorkshopCalendarResponse>(
        `/api/workshops/calendar?${qs}`,
      );
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

    addSession: (id: number, body: { sessionDate: string; staffId?: number | null }) =>
      request<{ workshopSessionId: number }>(`/api/workshops/${id}/sessions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateSession: (
      id: number,
      sessionId: number,
      body: { sessionDate?: string; staffId?: number | null },
    ) =>
      request<void>(`/api/workshops/${id}/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    removeSession: (id: number, sessionId: number) =>
      request<void>(`/api/workshops/${id}/sessions/${sessionId}`, { method: 'DELETE' }),

    /** Attendance checklist for one session. */
    attendance: (id: number, sessionId: number) =>
      request<{ data: import('@pe/shared').AttendanceRow[] }>(
        `/api/workshops/${id}/sessions/${sessionId}/attendance`,
      ),

    setAttendance: (
      id: number,
      sessionId: number,
      participantId: number,
      body: { attended: boolean; isLate?: boolean },
    ) =>
      request<void>(`/api/workshops/${id}/sessions/${sessionId}/attendance/${participantId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    /** Presenters assigned to a workshop. */
    presenters: (id: number) =>
      request<{ data: import('@pe/shared').WorkshopPresenterRow[] }>(
        `/api/workshops/${id}/presenters`,
      ),

    addPresenter: (id: number, presenterStaffId: number) =>
      request<{ workshopPresenterId: number }>(`/api/workshops/${id}/presenters`, {
        method: 'POST',
        body: JSON.stringify({ presenterStaffId }),
      }),

    removePresenter: (id: number, presenterRowId: number) =>
      request<void>(`/api/workshops/${id}/presenters/${presenterRowId}`, { method: 'DELETE' }),

    /** Capacity notification settings for the Notifications tab. */
    notificationSettings: (id: number) =>
      request<import('@pe/shared').WorkshopNotificationSettings>(
        `/api/workshops/${id}/notification-settings`,
      ),

    setNotificationSettings: (id: number, notifyPercentFull: number | null) =>
      request<{ workshopId: number; notifyPercentFull: number | null }>(
        `/api/workshops/${id}/notification-settings`,
        { method: 'PATCH', body: JSON.stringify({ notifyPercentFull }) },
      ),

    /** Registrant roster for the Registrants tab. */    registrants: (
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
      includeEmpty?: boolean;
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
      body: {
        isActive?: boolean;
        webSeatCap?: number | null;
        redirectToPayment?: boolean;
        paymentUrl?: string | null;
        formTemplateVersionId?: number | null;
      },
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
    schoolYears: () =>
      request<{ data: import('@pe/shared').SchoolYearOption[] }>('/api/lookups/school-years'),
  },

  forms: {
    list: (includeArchived = false) =>
      request<{ data: import('@pe/shared').FormTemplateSummary[] }>(
        `/api/forms${includeArchived ? '?includeArchived=true' : ''}`,
      ),

    create: (body: { name: string; description?: string | null }) =>
      request<{ formTemplateId: number; versionId: number }>('/api/forms', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    update: (id: number, body: { name?: string; description?: string | null; isActive?: boolean }) =>
      request<void>(`/api/forms/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

    archive: (id: number) => request<void>(`/api/forms/${id}/archive`, { method: 'POST' }),
    restore: (id: number) => request<void>(`/api/forms/${id}/restore`, { method: 'POST' }),

    versions: (id: number) =>
      request<{ data: import('@pe/shared').FormVersionSummary[] }>(`/api/forms/${id}/versions`),

    version: (id: number, versionId: number) =>
      request<import('@pe/shared').FormVersion>(`/api/forms/${id}/versions/${versionId}`),

    saveDraft: (id: number, questions: import('@pe/shared').FormQuestionDraft[]) =>
      request<{ formTemplateVersionId: number }>(`/api/forms/${id}/versions`, {
        method: 'POST',
        body: JSON.stringify({ questions }),
      }),

    publish: (id: number, versionId: number) =>
      request<void>(`/api/forms/${id}/versions/${versionId}/publish`, { method: 'POST' }),

    answersForWorkshop: (workshopId: number) =>
      request<{ data: import('@pe/shared').FormAnswerGroup[] }>(
        `/api/forms/answers/workshop/${workshopId}`,
      ),

    answersForParticipant: (participantId: number) =>
      request<{ data: import('@pe/shared').FormAnswerGroup[] }>(
        `/api/forms/answers/participant/${participantId}`,
      ),

    answersForRegistration: (registrationId: number) =>
      request<{
        formName: string | null;
        formVersionNumber: number | null;
        answers: { questionKey: string; label: string; value: string | null }[];
      }>(`/api/forms/answers/registration/${registrationId}`),
  },

  webhooks: {
    list: () => request<{ data: import('@pe/shared').WebhookRow[] }>('/api/webhooks'),
    get: (id: number) => request<import('@pe/shared').WebhookRow>(`/api/webhooks/${id}`),
    create: (body: import('@pe/shared').WebhookWrite) =>
      request<{ webhookId: number }>('/api/webhooks', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: number, body: Partial<import('@pe/shared').WebhookWrite>) =>
      request<{ webhookId: number }>(`/api/webhooks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    remove: (id: number) => request<void>(`/api/webhooks/${id}`, { method: 'DELETE' }),
    test: (id: number) =>
      request<import('@pe/shared').WebhookTestResult>(`/api/webhooks/${id}/test`, {
        method: 'POST',
      }),
    deliveries: (id: number) =>
      request<{ data: import('@pe/shared').WebhookDeliveryRow[] }>(
        `/api/webhooks/${id}/deliveries`,
      ),
  },

  notifications: {
    list: (limit = 20, opts: { offset?: number; view?: import('@pe/shared').NotificationView } = {}) => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (opts.offset) qs.set('offset', String(opts.offset));
      if (opts.view && opts.view !== 'all') qs.set('view', opts.view);
      return request<import('@pe/shared').NotificationListResponse>(`/api/notifications?${qs}`);
    },
    markRead: (id: number) =>
      request<void>(`/api/notifications/${id}/read`, { method: 'POST' }),
    markAllRead: () =>
      request<{ updated: number }>('/api/notifications/read-all', { method: 'POST' }),
    archive: (id: number) =>
      request<void>(`/api/notifications/${id}/archive`, { method: 'POST' }),
    unarchive: (id: number) =>
      request<void>(`/api/notifications/${id}/unarchive`, { method: 'POST' }),
    archiveAll: () =>
      request<{ updated: number }>('/api/notifications/archive-all', { method: 'POST' }),
  },

  reports: {    catalogue: () =>
      request<import('@pe/shared').ReportCatalogueResponse>('/api/reports'),

    run: (key: string, params: Record<string, string | number | undefined>) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').ReportRunResponse>(`/api/reports/${key}${suffix}`);
    },

    pdfUrl: (key: string, params: Record<string, string | number | undefined>) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return `/api/reports/${key}/pdf${suffix}`;
    },
  },

  certificates: {    capabilities: () => request<{ pdfRendering: boolean }>('/api/certificates/capabilities'),

    templates: (schoolYearId: number) =>
      request<{ data: import('@pe/shared').CertificateTemplateRow[] }>(
        `/api/certificates/templates?schoolYearId=${schoolYearId}`,
      ),

    createTemplate: (body: {
      schoolYearId: number;
      certificateType: 'CEU' | 'CHC';
      title?: string;
      subtitle?: string;
      layout?: 'portrait' | 'landscape';
    }) =>
      request<{ certificateTemplateId: number }>('/api/certificates/templates', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

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
