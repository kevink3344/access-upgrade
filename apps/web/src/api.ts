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

/**
 * Query string for a folder packet.
 *
 * The preview iframe and the PDF link both need it, and both must describe
 * the same packet as the JSON call, so the encoding lives in one place.
 */
function packetQuery(
  sections: string[],
  setup: import('@pe/shared').PacketPrintSetup,
): string {
  const qs = new URLSearchParams();
  if (sections.length) qs.set('sections', sections.join(','));
  qs.set('paper', setup.paper);
  qs.set('orientation', setup.orientation);
  qs.set('margin', String(setup.margin));
  qs.set('copies', String(setup.copies));
  return `?${qs.toString()}`;
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

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
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

  // An expired access token is expected, not a sign-out: exchange the refresh
  // cookie for a new one and replay the request once. Only a failed refresh
  // (no cookie, revoked, reused) ends the session.
  if (res.status === 401 && retry && !path.startsWith('/api/auth/')) {
    const renewed = await refreshSession();
    if (renewed) return request<T>(path, init, false);
  }

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

/**
 * Exchange the refresh cookie for a new access token.
 *
 * Concurrent 401s would otherwise each fire a refresh; because the token
 * rotates, the second would present an already-revoked value and the server
 * would kill the whole session. One in-flight promise is shared instead.
 */
let refreshInFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;

      const body = (await res.json()) as LoginResponse;
      // Keep the token where it already lived so "remember me" survives.
      setToken(body.token, localStorage.getItem(TOKEN_KEY) !== null);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
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

    addSession: (id: number, body: import('@pe/shared').WorkshopSessionWrite) =>
      request<{ workshopSessionId: number; warning: string | null }>(
        `/api/workshops/${id}/sessions`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      ),

    addSessionsBulk: (id: number, body: import('@pe/shared').WorkshopSessionBulkWrite) =>
      request<import('@pe/shared').WorkshopSessionBulkResult & { warning: string | null }>(
        `/api/workshops/${id}/sessions/bulk`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      ),

    updateSession: (
      id: number,
      sessionId: number,
      body: Partial<import('@pe/shared').WorkshopSessionWrite>,
    ) =>
      request<{ warning: string | null }>(`/api/workshops/${id}/sessions/${sessionId}`, {
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

    /** A standalone form's public link — no workshop involved. */
    getForForm: (formTemplateId: number) =>
      request<import('@pe/shared').FormLinkState>(`/api/forms/${formTemplateId}/link`),

    createForForm: (formTemplateId: number, body: { rotate?: boolean } = {}) =>
      request<{ registrationLinkId: number; slug: string; url: string; isActive: boolean }>(
        `/api/forms/${formTemplateId}/link`,
        { method: 'POST', body: JSON.stringify(body) },
      ),

    updateForForm: (formTemplateId: number, body: { isActive?: boolean }) =>
      request<{ ok: true }>(`/api/forms/${formTemplateId}/link`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

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
    create: (body: import('@pe/shared').PaymentCreate) =>
      request<import('@pe/shared').PaymentCreateResponse>('/api/payments', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (registrationId: number, body: Partial<import('@pe/shared').PaymentWrite>) =>
      request<{ registrationId: number }>(`/api/payments/${registrationId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  },

  trainingRequests: {
    list: (
      params: {
        page?: number;
        pageSize?: number;
        q?: string;
        status?: 'all' | 'active' | 'inactive' | 'invoiced' | 'uninvoiced';
        sort?: 'recent' | 'oldest' | 'agency';
      } = {},
    ) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').TrainingRequestListResponse>(
        `/api/training-requests${suffix}`,
      );
    },
    get: (id: number) =>
      request<import('@pe/shared').TrainingRequestDetail>(`/api/training-requests/${id}`),
    create: (body: import('@pe/shared').TrainingRequestWrite) =>
      request<{ trainingRequestId: number }>('/api/training-requests', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: number, body: Partial<import('@pe/shared').TrainingRequestWrite>) =>
      request<void>(`/api/training-requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    addContact: (id: number, body: { contactDate: string; note?: string | null }) =>
      request<{ contactId: number }>(`/api/training-requests/${id}/contacts`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  creditSlips: {
    list: (
      params: {
        page?: number;
        pageSize?: number;
        q?: string;
        status?: 'all' | 'unused' | 'used';
        categoryId?: number;
        trackingYear?: number;
        sort?: 'recent' | 'oldest' | 'amount' | 'participant';
      } = {},
    ) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').CreditSlipListResponse>(`/api/credit-slips${suffix}`);
    },
    get: (id: number) =>
      request<import('@pe/shared').CreditSlipDetail>(`/api/credit-slips/${id}`),
    create: (body: import('@pe/shared').CreditSlipWrite) =>
      request<{ creditSlipId: number }>('/api/credit-slips', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: number, body: Partial<import('@pe/shared').CreditSlipWrite>) =>
      request<void>(`/api/credit-slips/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    redeem: (id: number, body: import('@pe/shared').CreditSlipRedeem) =>
      request<void>(`/api/credit-slips/${id}/redeem`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    undoRedeem: (id: number) =>
      request<void>(`/api/credit-slips/${id}/redeem`, { method: 'DELETE' }),
    remove: (id: number) => request<void>(`/api/credit-slips/${id}`, { method: 'DELETE' }),
  },

  schoolCash: {
    /**
     * Uploads the CSV as raw text rather than multipart: it is a single text
     * file, and the API reads it with express.text. The file name travels in
     * a header so the history can show what was uploaded.
     */
    upload: (fileName: string, csv: string) =>
      request<{ importId: number; rowCount: number; matched: number; review: number; ignored: number }>(
        '/api/school-cash/imports',
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'X-File-Name': fileName },
          body: csv,
        },
      ),

    imports: (params: { page?: number; pageSize?: number } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').ScoImportListResponse>(`/api/school-cash/imports${suffix}`);
    },

    import: (id: number) =>
      request<import('@pe/shared').ScoImportDetail>(`/api/school-cash/imports/${id}`),

    /** Step one: the distinct items in an upload and their workshops. */
    items: (importId: number) =>
      request<import('@pe/shared').ScoItemsResponse>(`/api/school-cash/imports/${importId}/items`),

    /** Every workshop, for the picker. */
    workshops: () =>
      request<{ rows: import('@pe/shared').ScoWorkshopOption[] }>('/api/school-cash/workshops'),

    /** Resolve one item to an existing workshop, or create one. */
    resolveItem: (
      itemId: number,
      body: {
        workshopId?: number;
        create?: {
          workshopNameId?: number;
          newWorkshopName?: string;
          workshopCode?: string | null;
          startDate?: string | null;
          price?: number | null;
        };
      },
    ) =>
      request<{
        ScoItemID: number;
        WorkshopID: number;
        ResolvedBy: string;
        matched: number;
        review: number;
        ignored: number;
      }>(
        `/api/school-cash/items/${itemId}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),

    matchRow: (rowId: number, body: { registrationId?: number | null; ignore?: boolean; ignoreReason?: string | null }) =>
      request<Record<string, unknown>>(`/api/school-cash/rows/${rowId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    candidates: (importId: number, params: { rowId?: number; q?: string }) => {
      const qs = new URLSearchParams();
      if (params.rowId !== undefined) qs.set('rowId', String(params.rowId));
      if (params.q) qs.set('q', params.q);
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<{ rows: import('@pe/shared').ScoCandidate[] }>(
        `/api/school-cash/imports/${importId}/candidates${suffix}`,
      );
    },

    apply: (id: number) =>
      request<import('@pe/shared').ScoApplyResult>(`/api/school-cash/imports/${id}/apply`, {
        method: 'POST',
      }),

    discard: (id: number) =>
      request<void>(`/api/school-cash/imports/${id}/discard`, { method: 'POST' }),

    history: (params: {
      page?: number;
      pageSize?: number;
      q?: string;
      importId?: number;
      from?: string;
      to?: string;
    } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').ScoHistoryResponse>(`/api/school-cash/history${suffix}`);
    },
  },

  lookups: {
    list: () => request<{ data: string[] }>('/api/lookups'),    get: (name: string) =>
      request<{ data: { id: number; label: string }[] }>(`/api/lookups/${name}`),
    schoolYears: () =>
      request<{ data: import('@pe/shared').SchoolYearOption[] }>('/api/lookups/school-years'),
  },

  forms: {
    list: (includeArchived = false) =>
      request<{ data: import('@pe/shared').FormTemplateSummary[] }>(
        `/api/forms${includeArchived ? '?includeArchived=true' : ''}`,
      ),

    create: (body: {
      name: string;
      description?: string | null;
      kind?: import('@pe/shared').FormTemplateKind;
    }) =>
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
    /** What the system notifies staff about, plus recent volume. */
    catalogue: () =>
      request<import('@pe/shared').NotificationCatalogueResponse>('/api/notifications/catalogue'),

    /** Turns a notification type or delivery channel on or off. */
    setSetting: (key: string, enabled: boolean) =>
      request<{ key: string; enabled: boolean }>('/api/notifications/settings', {
        method: 'PATCH',
        body: JSON.stringify({ key, enabled }),
      }),

    list: (limit = 20, opts: { offset?: number; view?: import('@pe/shared').NotificationView } = {}) => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (opts.offset) qs.set('offset', String(opts.offset));
      if (opts.view && opts.view !== 'all') qs.set('view', opts.view);
      return request<import('@pe/shared').NotificationListResponse>(`/api/notifications?${qs}`);
    },
    markRead: (id: number) =>
      request<void>(`/api/notifications/${id}/read`, { method: 'POST' }),
    markUnread: (id: number) =>
      request<void>(`/api/notifications/${id}/unread`, { method: 'POST' }),
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

    /** One Visual Reports chart. `schoolYearId` is ignored by cross-year charts. */
    chart: (key: import('@pe/shared').ChartKey, schoolYearId?: number | null) => {
      const qs = schoolYearId ? `?schoolYearId=${schoolYearId}` : '';
      return request<import('@pe/shared').ChartSeries>(`/api/reports/charts/${key}${qs}`);
    },

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
      name?: string | null;
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
    pdfUrl: (
      participantId: number,
      schoolYearId: number,
      certificateType: 'CEU' | 'CHC',
      templateId?: number | null,
    ) =>
      `/api/certificates/pdf/${participantId}?schoolYearId=${schoolYearId}&certificateType=${certificateType}` +
      (templateId ? `&templateId=${templateId}` : ''),

    previewUrl: (
      participantId: number,
      schoolYearId: number,
      certificateType: 'CEU' | 'CHC',
      templateId?: number | null,
    ) =>
      `/api/certificates/preview/${participantId}?schoolYearId=${schoolYearId}&certificateType=${certificateType}` +
      (templateId ? `&templateId=${templateId}` : ''),
  },

  folders: {
    /** Workshops the builder can open, newest first. */
    workshops: (params: { q?: string; limit?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.q) qs.set('q', params.q);
      if (params.limit) qs.set('limit', String(params.limit));
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<{ rows: import('@pe/shared').PacketWorkshopOption[] }>(
        `/api/folders/workshops${suffix}`,
      );
    },

    packet: (
      workshopId: number,
      sections: string[],
      setup: import('@pe/shared').PacketPrintSetup,
    ) =>
      request<import('@pe/shared').PacketDetail>(
        `/api/folders/workshops/${workshopId}/packet${packetQuery(sections, setup)}`,
      ),

    /**
     * URL for the HTML preview. Returned as a URL rather than fetched because
     * it is loaded straight into an iframe, so the browser handles it and the
     * packet renders in its own document.
     */
    previewUrl: (
      workshopId: number,
      sections: string[],
      setup: import('@pe/shared').PacketPrintSetup,
    ) => `/api/folders/workshops/${workshopId}/preview${packetQuery(sections, setup)}`,

    pdfUrl: (
      workshopId: number,
      sections: string[],
      setup: import('@pe/shared').PacketPrintSetup,
    ) => `/api/folders/workshops/${workshopId}/pdf${packetQuery(sections, setup)}`,
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

  utilities: {
    catalogue: () =>
      request<{
        data: import('@pe/shared').UtilityDefinition[];
        overview: import('@pe/shared').UtilityOverview;
      }>('/api/admin/utilities'),

    participants: (params: { q?: string; page?: number; pageSize?: number } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').UtilityParticipantListResponse>(
        `/api/admin/utilities/participants${suffix}`,
      );
    },

    duplicateGroups: (params: { schoolYearId?: number; page?: number; pageSize?: number } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').DuplicateGroupsResponse>(
        `/api/admin/utilities/duplicate-participants${suffix}`,
      );
    },

    schoolYears: () =>
      request<import('@pe/shared').UtilitySchoolYearsResponse>(
        '/api/admin/utilities/school-years',
      ),

    negativePayments: () =>
      request<import('@pe/shared').NegativePaymentsResponse>(
        '/api/admin/utilities/negative-payments',
      ),

    orphanRegistrations: () =>
      request<import('@pe/shared').OrphanRegistrationsResponse>(
        '/api/admin/utilities/registrations-no-workshop',
      ),

    previewMerge: (sourceParticipantId: number, targetParticipantId: number) =>
      request<import('@pe/shared').MergePreview>('/api/admin/utilities/merge-participants/preview', {
        method: 'POST',
        body: JSON.stringify({ sourceParticipantId, targetParticipantId }),
      }),

    runMerge: (body: {
      sourceParticipantId: number;
      targetParticipantId: number;
      token: string;
    }) =>
      request<import('@pe/shared').MergeResult>('/api/admin/utilities/merge-participants/run', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    runs: (params: { key?: string; limit?: number } = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('@pe/shared').UtilityRunsResponse>(
        `/api/admin/utilities/runs${suffix}`,
      );
    },
  },
};
