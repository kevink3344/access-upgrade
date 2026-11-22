/**
 * Shared types between the API and the web app.
 * Kept deliberately small for now — grows as endpoints are added.
 */

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'EDITOR' | 'VIEWER';

export interface AuthUser {
  userId: number;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: AuthUser;
  /** True when the user asked to stay signed in across browser restarts. */
  rememberMe: boolean;
}

/** Dashboard summary — real counts from the migrated database. */
export interface DashboardSummary {
  schoolYear: {
    id: number;
    name: string;
  } | null;
  counts: {
    workshops: number;
    participants: number;
    registrations: number;
    agencies: number;
  };
  currentYear: {
    workshops: number;
    registrations: number;
    participants: number;
    revenue: number;
  };
  upcomingWorkshops: UpcomingWorkshop[];
  unpaidRegistrations: {
    count: number;
    total: number;
  };
  recentActivity: ActivityItem[];
}

export interface UpcomingWorkshop {
  workshopId: number;
  workshopName: string | null;
  workshopCode: string | null;
  startDate: string | null;
  endDate: string | null;
  registered: number;
  capacity: number | null;
  isClosed: boolean;
  isCancelled: boolean;
}

export interface ActivityItem {
  at: string;
  kind: 'registration' | 'payment' | 'workshop';
  description: string;
  /** Present for registration events — links to the record. */
  registrationId?: number;
  isCancelled?: boolean;
}

export interface ApiError {
  error: string;
  message: string;
  details?: { path: string; message: string }[];
}

/* ------------------------------------------------------------------ */
/*  Workshops                                                          */
/* ------------------------------------------------------------------ */

export interface WorkshopRow {
  workshopId: number;
  workshopCode: string | null;
  workshopName: string | null;
  startDate: string | null;
  endDate: string | null;
  schoolYear: string | null;
  categoryCode: string | null;
  registered: number;
  capacity: number | null;
  isClosed: boolean;
  isCancelled: boolean;
}

export interface WorkshopListResponse {
  data: WorkshopRow[];
  page: number;
  pageSize: number;
  total: number;
}

/** One workshop placed on the calendar, keyed on its StartDate. */
export interface WorkshopCalendarEntry {
  workshopId: number;
  workshopCode: string | null;
  workshopName: string | null;
  /** YYYY-MM-DD — the workshop's StartDate. */
  date: string;
  endDate: string | null;
  registered: number;
  capacity: number | null;
  isClosed: boolean;
  isCancelled: boolean;
}

export interface WorkshopCalendarResponse {
  data: WorkshopCalendarEntry[];
  /** Matching workshops with no StartDate — they cannot be placed on a calendar. */
  undated: number;
}

/** A presenter assigned to a workshop (Presenters tab). */
export interface WorkshopPresenterRow {
  workshopPresenterId: number;
  presenterStaffId: number;
  name: string;
  agencyName: string | null;
  isRetired: boolean;
}

/** A session on a workshop (Sessions tab). */
export interface WorkshopSessionRow {
  WorkshopSessionID: number;
  SessionDate: string | null;
  RegAttend: number | null;
  ESchoolAttend: number | null;
  StaffID: number | null;
  PresenterName: string | null;
}

/** One person on a session's attendance checklist. */
export interface AttendanceRow {
  participantId: number;
  name: string | null;
  email: string | null;
  agencyName: string | null;
  /** null means unmarked — distinct from false, which is never stored. */
  attended: boolean | null;
  isLate: boolean;
}

/** A single row on the workshop Registrants tab. */
export interface WorkshopRegistrant {
  RegistrationID: number;
  ParticipantID: number;
  ParticipantName: string | null;
  Email: string | null;
  AgencyName: string | null;
  RegistrationDate: string | null;
  PaidAmount: number | null;
  IsCancelled: boolean;
  Attended: boolean;
  Source: string;
}

export interface WorkshopRegistrantsResponse {
  data: WorkshopRegistrant[];
  page: number;
  pageSize: number;
  total: number;
  /** Workshop-wide totals, independent of the current search filter. */
  counts: {
    active: number;
    cancelled: number;
    attended: number;
    all: number;
  };
}

/** Raw detail row — column names as returned by SQL. */
export interface WorkshopDetail {
  WorkshopID: number;
  WorkshopNameID: number | null;
  EvalTypeID: number | null;
  ComponentID: number | null;
  CategoryID: number | null;
  AgencyID: number | null;
  SchoolYearID: number | null;
  WorkshopCode: string | null;
  StartDate: string | null;
  EndDate: string | null;
  StartTime: string | null;
  EndTime: string | null;
  MaxEnrollment: number | null;
  MinEnrollment: number | null;
  Room: number | null;
  Cost1: number | null;
  Cost2: number | null;
  ConsultFee: number | null;
  CreditPossible: string | null;
  SessionCount: number | null;
  SessionHours: number | null;
  SessionCeus: number | null;
  IsBrochure: boolean;
  IsFolder: boolean;
  IsLabel: boolean;
  IsClosed: boolean;
  IsCancelled: boolean;
  IsContracted: boolean;
  IsStaffDev: boolean;
  IsRegistrationOpen: boolean;
  Notes: string | null;
  SpecialNotes: string | null;
  WorkshopName: string | null;
  ShortName: string | null;
  SchoolYear: string | null;
  CategoryCode: string | null;
  AgencyName: string | null;
  Registered: number;
  /** Cancelled registrations, excluded from `Registered`. */
  CancelledCount: number;
  /** `Registered + CancelledCount` — every registration on the workshop. */
  RegistrationCount: number;
  AttendedCount: number;
}

/** Writable fields — camelCase, matches the API contract. */
export interface WorkshopWrite {
  workshopNameId?: number | null;
  evalTypeId?: number | null;
  componentId?: number | null;
  categoryId?: number | null;
  agencyId?: number | null;
  schoolYearId?: number | null;
  workshopCode?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  maxEnrollment?: number | null;
  minEnrollment?: number | null;
  room?: number | null;
  cost1?: number | null;
  cost2?: number | null;
  consultFee?: number | null;
  creditPossible?: string | null;
  sessionCount?: number | null;
  sessionHours?: number | null;
  sessionCeus?: number | null;
  isBrochure?: boolean;
  isFolder?: boolean;
  isLabel?: boolean;
  isClosed?: boolean;
  isCancelled?: boolean;
  isContracted?: boolean;
  isStaffDev?: boolean;
  isRegistrationOpen?: boolean;
  notes?: string | null;
  specialNotes?: string | null;
}

export interface WorkshopSessionRow {
  WorkshopSessionID: number;
  SessionDate: string | null;
  RegAttend: number | null;
  ESchoolAttend: number | null;
  StaffID: number | null;
  PresenterName: string | null;
}

export interface LookupOption {
  id: number;
  label: string;
}

/** School years carry their bounds so the calendar can open on the current one. */
export interface SchoolYearOption extends LookupOption {
  isPastYear: boolean;
  beginDate: string | null;
  endDate: string | null;
}

/* ------------------------------------------------------------------ */
/*  Registrations                                                      */
/* ------------------------------------------------------------------ */

export interface RegistrationRow {
  RegistrationID: number;
  ParticipantID: number;
  WorkshopID: number | null;
  ParticipantName: string | null;
  Email: string | null;
  WorkshopName: string | null;
  WorkshopCode: string | null;
  StartDate: string | null;
  PaidAmount: number | null;
  RegistrationDate: string | null;
  IsCancelled: boolean;
  Attended: boolean;
  Source: 'Manual' | 'Web' | 'ESchools';
}

export interface RegistrationListResponse {
  data: RegistrationRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface RegistrationDetail extends RegistrationRow {
  CreditTypeID: number | null;
  PaymentMethodID: number | null;
  PayeeID: number | null;
  PaymentID: number | null;
  TicketCount: number | null;
  IsScholarship: boolean;
  EmailConfirmation: boolean;
  ReceiptNumber: number | null;
  CheckNumber: number | null;
  CheckTotal: number | null;
  PaidDate: string | null;
  Notes: string | null;
}

export interface RegistrationWrite {
  participantId?: number;
  workshopId?: number | null;
  creditTypeId?: number | null;
  paymentMethodId?: number | null;
  payeeId?: number | null;
  paymentId?: number | null;
  paidAmount?: number | null;
  ticketCount?: number | null;
  isScholarship?: boolean;
  registrationDate?: string | null;
  isCancelled?: boolean;
  attended?: boolean;
  emailConfirmation?: boolean;
  receiptNumber?: number | null;
  checkNumber?: number | null;
  checkTotal?: number | null;
  paidDate?: string | null;
  notes?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Participants                                                       */
/* ------------------------------------------------------------------ */

export interface ParticipantRow {
  participantId: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  agencyName: string | null;
  hasCeuCertificate: boolean;
  hasChcCertificate: boolean;
  registrationCount: number;
}

export interface ParticipantListResponse {
  data: ParticipantRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ParticipantDetail {
  ParticipantID: number;
  SalutationID: number | null;
  AgencyID: number | null;
  StreetTypeID: number | null;
  CityID: number | null;
  StateID: number | null;
  FirstName: string | null;
  LastName: string | null;
  MiddleName: string | null;
  HomePhone: string | null;
  HomeFax: string | null;
  WorkPhone: string | null;
  WorkPhoneExt: string | null;
  HomeAddress1: string | null;
  HomeAddress2: string | null;
  HomeZip: string | null;
  Email: string | null;
  Email2: string | null;
  Email3: string | null;
  Position: string | null;
  GradeLevel: string | null;
  IsParentMailingList: boolean;
  IsTeacherMailingList: boolean;
  IsDirectorMailingList: boolean;
  IsStaff: boolean;
  IsWcpss: boolean;
  HasCeuCertificate: boolean;
  HasChcCertificate: boolean;
  DateOfEntry: string | null;
  UpdatedAt: string | null;
  AgencyName: string | null;
}

export interface ParticipantWrite {
  salutationId?: number | null;
  agencyId?: number | null;
  streetTypeId?: number | null;
  cityId?: number | null;
  stateId?: number | null;
  firstName?: string | null;
  lastName?: string | null;
  middleName?: string | null;
  homePhone?: string | null;
  homeFax?: string | null;
  workPhone?: string | null;
  workPhoneExt?: string | null;
  homeAddress1?: string | null;
  homeAddress2?: string | null;
  homeZip?: string | null;
  email?: string | null;
  email2?: string | null;
  email3?: string | null;
  position?: string | null;
  gradeLevel?: string | null;
  isParentMailingList?: boolean;
  isTeacherMailingList?: boolean;
  isDirectorMailingList?: boolean;
  isStaff?: boolean;
  isWcpss?: boolean;
}

export interface DuplicateMatch {
  participantId: number;
  displayName: string;
  email: string | null;
  agencyName: string | null;
  registrationCount: number;
  matchReason: 'email' | 'name';
}

export interface ParticipantRegistrationRow {
  RegistrationID: number;
  WorkshopID: number | null;
  PaidAmount: number | null;
  RegistrationDate: string | null;
  IsCancelled: boolean;
  Attended: boolean;
  Source: string;
  WorkshopCode: string | null;
  WorkshopName: string | null;
  StartDate: string | null;
}

/* ------------------------------------------------------------------ */
/*  Agencies                                                           */
/* ------------------------------------------------------------------ */

export interface AgencyRow {
  AgencyID: number;
  AgencyName: string | null;
  AgencyShortName: string | null;
  AgencyPhone: string | null;
  AgencyZip: string | null;
  IsOutOfBusiness: boolean;
  IsWorkshopSite: boolean;
  City: string | null;
  AgencyType: string | null;
  ParticipantCount: number;
}

export interface AgencyListResponse {
  data: AgencyRow[];
  page: number;
  pageSize: number;
  total: number;
}

/** Full agency record, as returned by GET /api/agencies/:id. */
export interface AgencyDetail {
  AgencyID: number;
  AgencyName: string | null;
  AgencyShortName: string | null;
  AgencyTypeID: number | null;
  FacilityTypeID: number | null;
  CountyID: number | null;
  CityID: number | null;
  StateID: number | null;
  StreetTypeID: number | null;
  AgencyAddress1: string | null;
  AgencyAddress2: string | null;
  AgencyZip: string | null;
  AgencyPhone: string | null;
  AgencyFax: string | null;
  AgencyEmail: string | null;
  AgencyWebsite: string | null;
  DirectorFirstName: string | null;
  DirectorLastName: string | null;
  AltContactFirstName: string | null;
  AltContactLastName: string | null;
  IsOutOfBusiness: boolean;
  IsWorkshopSite: boolean;
  Notes: string | null;
  City: string | null;
  State: string | null;
  County: string | null;
}

/** Writable fields — camelCase, matches the API contract. */
export interface AgencyWrite {
  agencyName?: string | null;
  agencyShortName?: string | null;
  agencyTypeId?: number | null;
  facilityTypeId?: number | null;
  countyId?: number | null;
  cityId?: number | null;
  stateId?: number | null;
  streetTypeId?: number | null;
  agencyAddress1?: string | null;
  agencyAddress2?: string | null;
  agencyZip?: string | null;
  agencyPhone?: string | null;
  agencyFax?: string | null;
  agencyEmail?: string | null;
  agencyWebsite?: string | null;
  directorFirstName?: string | null;
  directorLastName?: string | null;
  altContactFirstName?: string | null;
  altContactLastName?: string | null;
  isOutOfBusiness?: boolean;
  isWorkshopSite?: boolean;
  notes?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Presenters and staff                                               */
/* ------------------------------------------------------------------ */

export interface PresenterRow {
  PresenterStaffID: number;
  FirstName: string | null;
  LastName: string | null;
  HomeEmail: string | null;
  WorkPhone: string | null;
  CellPhone: string | null;
  IsRetired: boolean;
  AgencyName: string | null;
  WorkshopCount: number;
}

export interface PresenterListResponse {
  data: PresenterRow[];
  page: number;
  pageSize: number;
  total: number;
}

/** Full presenter record, as returned by GET /api/presenters/:id. */
export interface PresenterDetail {
  PresenterStaffID: number;
  SalutationID: number | null;
  AgencyID: number | null;
  CityID: number | null;
  StateID: number | null;
  FirstName: string | null;
  LastName: string | null;
  MiddleName: string | null;
  WorkPhone: string | null;
  Extension: number | null;
  HomePhone: string | null;
  CellPhone: string | null;
  HomeEmail: string | null;
  Address: string | null;
  Zip: string | null;
  IsRetired: boolean;
  AgencyName: string | null;
  City: string | null;
  State: string | null;
  Salutation: string | null;
}

/** Writable fields — camelCase, matches the API contract. */
export interface PresenterWrite {
  salutationId?: number | null;
  agencyId?: number | null;
  cityId?: number | null;
  stateId?: number | null;
  firstName?: string | null;
  lastName?: string | null;
  middleName?: string | null;
  workPhone?: string | null;
  extension?: number | null;
  homePhone?: string | null;
  cellPhone?: string | null;
  homeEmail?: string | null;
  address?: string | null;
  zip?: string | null;
  isRetired?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Workshop catalog                                                   */
/* ------------------------------------------------------------------ */

export interface WorkshopNameRow {
  WorkshopNameID: number;
  WorkshopName: string | null;
  ShortName: string | null;
  ECourseNum: number | null;
  IsLiteracy: boolean;
  Ages: string | null;
  /** 1 when a description exists, 0 when it does not. */
  HasDescription: number;
  WorkshopCount: number;
}

export interface WorkshopNameListResponse {
  data: WorkshopNameRow[];
  page: number;
  pageSize: number;
  total: number;
}

/** Full catalog entry, as returned by GET /api/workshop-names/:id. */
export interface WorkshopNameDetail {
  WorkshopNameID: number;
  AgesID: number | null;
  WorkshopName: string | null;
  ShortName: string | null;
  ECourseNum: number | null;
  WLCourse: number | null;
  Prerequisites: string | null;
  Description: string | null;
  TopicNums: string | null;
  IsLiteracy: boolean;
  Ages: string | null;
}

/** Writable fields — camelCase, matches the API contract. */
export interface WorkshopNameWrite {
  agesId?: number | null;
  workshopName?: string | null;
  shortName?: string | null;
  eCourseNum?: number | null;
  wlCourse?: number | null;
  prerequisites?: string | null;
  description?: string | null;
  topicNums?: string | null;
  isLiteracy?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Payments and receipts                                              */
/* ------------------------------------------------------------------ */

export interface PaymentRow {
  RegistrationID: number;
  PaidAmount: number | null;
  PaidDate: string | null;
  ReceiptNumber: number | null;
  CheckNumber: number | null;
  CheckTotal: number | null;
  IsCancelled: boolean;
  IsScholarship: boolean;
  PaymentMethod: string | null;
  ParticipantID: number | null;
  FirstName: string | null;
  LastName: string | null;
  WorkshopID: number | null;
  WorkshopCode: string | null;
  WorkshopName: string | null;
  PaymentID: number | null;
  PaymentRecordTotal: number | null;
  Payee: string | null;
}

export interface PaymentListResponse {
  data: PaymentRow[];
  page: number;
  pageSize: number;
  total: number;
  /** Totals for the whole filtered set, not just the page. */
  totals: { total: number; paid: number; refunded: number };
}

export interface PaymentDetail extends PaymentRow {
  PaymentMethodID: number | null;
  PaymentCheckNumber: number | null;
  PaymentReceiptNumber: number | null;
  /** Participant's email. Named Email on core.Participant; HomeEmail is a
   *  PresenterStaff column and does not exist here. */
  Email: string | null;
  StartDate: string | null;
  SchoolYear: string | null;
}

export interface PaymentWrite {
  paidAmount?: number | null;
  paidDate?: string | null;
  paymentMethodId?: number | null;
  receiptNumber?: number | null;
  checkNumber?: number | null;
  payeeId?: number | null;
}

export interface PaymentSummary {
  byYear: {
    SchoolYearID: number;
    SchoolYear: string | null;
    Registrations: number;
    Amount: number;
  }[];
  byMethod: {
    PaymentMethodID: number;
    PaymentMethod: string | null;
    Registrations: number;
    Amount: number;
  }[];
}

/* ------------------------------------------------------------------ */
/*  Public registration                                                */
/* ------------------------------------------------------------------ */

export type PublicLinkStatus = 'open' | 'closed' | 'not-yet-open' | 'revoked' | 'full';

export interface RegistrationLinkState {
  workshop: {
    workshopId: number;
    workshopCode: string | null;
    workshopName: string | null;
    isRegistrationOpen: boolean;
    maxEnrollment: number | null;
  };
  link: {
    slug: string;
    url: string;
    isActive: boolean;
    webSeatCap: number | null;
    opensAt: string | null;
    closesAt: string | null;
    /** Send the registrant to PaymentUrl after a successful submission. */
    redirectToPayment: boolean;
    paymentUrl: string | null;
    /** The form version this link asks. Null = the built-in form. */
    formTemplateVersionId: number | null;
    webRegistrations: number;
    createdBy: string;
    createdAt: string;
  } | null;
}

export interface PublicLinkState {
  state: PublicLinkStatus;
  /** Seats left, from the live roster. Null when the workshop is uncapped. */
  seatsRemaining: number | null;
  /**
   * The form version this link is pinned to, or null when the link uses the
   * built-in form. Workshop details always render regardless.
   */
  form: FormVersion | null;
  opensAt: string | null;
  /** True when staff configured a payment redirect for this link. */
  redirectToPayment: boolean;
  paymentUrl: string | null;
  workshop: {
    title: string | null;
    code: string | null;
    startDate: string | null;
    endDate: string | null;
    startTime: string | null;
    endTime: string | null;
    room: number | null;
    location: string | null;
    cost: number | null;
    credit: string | null;
    ceus: number | null;
  };
}

/** Who the registrant is. Drives which questions the public form asks. */
export type RegistrantRole = 'Educator' | 'Parent/caregiver';

export interface PublicRegisterRequest {
  firstName: string;
  lastName: string;
  email: string;
  /** Required — the form branches on this. */
  registrantRole: RegistrantRole;
  phone?: string;
  agencyId?: number | null;
  /** Educator only — ages of the students in the class. */
  classAges?: string;
  /** Parent/caregiver only — ages of the registrant's children. */
  childrenAges?: string;
  /** Parent/caregiver only — details for a second caregiver. */
  secondCaregiverInfo?: string;
  paymentMethod?: string;
  notes?: string;
  /** Honeypot — must stay empty. */
  website?: string;
  elapsedMs?: number;
  /** Custom answers keyed by QuestionKey, for links pinned to a form version. */
  answers?: Record<string, string | string[] | null>;
}

/* ------------------------------------------------------------------ */
/*  Certificates                                                       */
/* ------------------------------------------------------------------ */

export type CertificateType = 'CEU' | 'CHC';

export interface CertificateFieldVisibility {
  name: boolean;
  certificateType: boolean;
  programTitle: boolean;
  programDirector: boolean;
  inclusiveDates: boolean;
  unitsOfRenewalCredit: boolean;
  agency: boolean;
  employedBy: boolean;
  roleFlags: boolean;
  ssn: boolean;
  homeAddress: boolean;
  expirationDate: boolean;
}

export interface CertificateTemplateRow {
  CertificateTemplateID: number;
  SchoolYearID: number;
  SchoolYear: string | null;
  CertificateType: CertificateType;
  Title: string | null;
  Subtitle: string | null;
  LogoPath: string | null;
  LogoAssetID: number | null;
  HasLogo: boolean;
  ProgramDirectorName: string | null;
  ProgramDirectorTitle: string | null;
  ApprovingDirectorName: string | null;
  ApprovingDirectorTitle: string | null;
  CreditUnitLabel: string | null;
  FooterText: string | null;
  VisibleFields: CertificateFieldVisibility;
  /** 'portrait' (8.5x11) or 'landscape' (11x8.5). */
  Layout: 'portrait' | 'landscape';
  UpdatedBy: string | null;
  UpdatedAt: string;
}

export interface CertificateTemplateWrite {
  title?: string | null;
  subtitle?: string | null;
  programDirectorName?: string | null;
  programDirectorTitle?: string | null;
  approvingDirectorName?: string | null;
  approvingDirectorTitle?: string | null;
  creditUnitLabel?: string | null;
  footerText?: string | null;
  visibleFields?: Partial<CertificateFieldVisibility>;
  layout?: 'portrait' | 'landscape';
}

export interface CertificateEligibleRow {
  ParticipantID: number;
  SchoolYearID: number;
  FirstName: string | null;
  LastName: string | null;
  MiddleName: string | null;
  Email: string | null;
  AgencyName: string | null;
  WorkshopCount: number;
  TotalHours: number | null;
  TotalCeus: number | null;
  FirstDate: string | null;
  LastDate: string | null;
  MissingHoursCount: number;
  HasIssued: number;
}

export interface CertificateEligibleResponse {
  data: CertificateEligibleRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CertificateOverrideRow {
  CertificateOverrideID: number;
  CustomText: string | null;
  CustomTextLabel: string | null;
  ImageAssetID: number | null;
  ImageAltText: string | null;
  ImagePlacement: 'header' | 'body' | 'footer' | null;
  UpdatedAt: string;
  ImageContentType: string | null;
}

export interface CertificateOverrideWrite {
  schoolYearId: number;
  certificateType: CertificateType;
  customText?: string | null;
  customTextLabel?: string | null;
  imageAltText?: string | null;
  imagePlacement?: 'header' | 'body' | 'footer' | null;
  /** Full data URI, or null to remove the image. */
  imageData?: string | null;
  imageContentType?: string;
  imageFileName?: string;
}
/* ------------------------------------------------------------------ */
/*  Reports                                                            */
/* ------------------------------------------------------------------ */

export type ReportGroup =
  | 'attendance'
  | 'workshops'
  | 'evaluations'
  | 'surveys'
  | 'demographics'
  | 'operational';

export interface ReportParameter {
  key: string;
  label: string;
  type: 'school-year' | 'date' | 'category' | 'workshop';
  required?: boolean;
}

export interface ReportColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
}

export interface ReportCatalogueItem {
  key: string;
  title: string;
  description: string;
  group: ReportGroup;
  replaces: string;
  parameters: ReportParameter[];
  columns: ReportColumn[];
}

export interface ReportFinancialLink {
  title: string;
  description: string;
  href: string;
  replaces: string;
}

export interface ReportCatalogueResponse {
  data: ReportCatalogueItem[];
  links: ReportFinancialLink[];
  /** Most recent school year each report can produce rows for. */
  defaultSchoolYearByReport: Record<string, number | null>;
}

export interface ReportRunResponse {
  key: string;
  title: string;
  columns: ReportColumn[];
  parameters: Record<string, string | number>;
  data: Record<string, string | number | null>[];
  total: number;
  truncated: boolean;
}
/* ------------------------------------------------------------------ */
/*  Notifications                                                      */
/* ------------------------------------------------------------------ */

export interface NotificationRow {
  NotificationID: number;
  Kind: string;
  Title: string;
  Body: string | null;
  LinkPath: string | null;
  WorkshopID: number | null;
  CreatedAt: string;
  IsRead: boolean;
  IsArchived: boolean;
}

/** Which slice of a user's notifications a list request returns. */
export type NotificationView = 'all' | 'unread' | 'archived';

export interface NotificationListResponse {
  data: NotificationRow[];
  unread: number;
  /** Rows matching the view, ignoring paging — drives the "view all" pager. */
  total: number;
  /** Archived rows, so the filter can show a count without a second request. */
  archived: number;
  limit: number;
  offset: number;
}

export interface WorkshopNotificationSettings {
  workshopId: number;
  capacity: number | null;
  registered: number;
  percentFull: number | null;
  notifyPercentFull: number | null;
  lastNotifiedAt: string | null;
}
/* ------------------------------------------------------------------ */
/*  Form Designer                                                      */
/* ------------------------------------------------------------------ */

export type FormFieldType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  /** Live type-ahead over core.Agency; stores the chosen AgencyID. */
  | 'agency';

export interface FormQuestion {
  formQuestionId: number;
  sortOrder: number;
  questionKey: string;
  label: string;
  helpText: string | null;
  placeholder: string | null;
  fieldType: FormFieldType;
  isRequired: boolean;
  options: string[];
  maxLength: number | null;
  mapsToColumn: string | null;
  isBuiltIn: boolean;
  /** Shown only when this question's answer matches branchOptionValue. */
  branchOnQuestionKey: string | null;
  branchOptionValue: string | null;
}

/** A question as sent by the editor — ids are assigned server-side. */
export interface FormQuestionDraft {
  sortOrder: number;
  questionKey: string;
  label: string;
  helpText?: string | null;
  placeholder?: string | null;
  fieldType: FormFieldType;
  isRequired: boolean;
  options: string[];
  maxLength?: number | null;
  mapsToColumn?: string | null;
  isBuiltIn: boolean;
  /** Question key whose answer gates this one. Null = always shown. */
  branchOnQuestionKey?: string | null;
  branchOptionValue?: string | null;
}

export interface FormVersion {
  formTemplateVersionId: number;
  formTemplateId: number;
  versionNumber: number;
  publishedAt: string | null;
  publishedBy: string | null;
  questions: FormQuestion[];
}

export interface FormVersionSummary {
  formTemplateVersionId: number;
  versionNumber: number;
  publishedAt: string | null;
  publishedBy: string | null;
  createdBy: string;
  createdAt: string;
  questionCount: number;
}

export interface FormTemplateSummary {
  formTemplateId: number;
  name: string;
  description: string | null;
  isActive: boolean;
  currentVersionId: number | null;
  currentVersionNumber: number | null;
  isPublished: boolean;
  updatedAt: string | null;
}

/** One registration's custom answers. */
export interface FormAnswerGroup {
  registrationId: number;
  participantName: string | null;
  workshopId?: number;
  workshopCode?: string | null;
  workshopName?: string | null;
  startDate?: string | null;
  answers: { questionKey: string; label: string; value: string | null }[];
}

/* ------------------------------------------------------------------ */
/*  Webhooks                                                           */
/* ------------------------------------------------------------------ */

export interface WebhookRow {
  WebhookID: number;
  Title: string;
  Description: string | null;
  Url: string;
  JsonSchema: string | null;
  /** 'json' sends the schema shape; 'slack' wraps it for Slack's webhook format. */
  PayloadFormat: 'json' | 'slack';
  IsActive: boolean;
  CreatedBy: string | null;
  CreatedAt: string;
  UpdatedBy: string | null;
  UpdatedAt: string;
  DeliveryCount: number;
  LastSucceeded: boolean | null;
  LastAttemptAt: string | null;
}

export interface WebhookWrite {
  title: string;
  description?: string | null;
  url: string;
  jsonSchema?: string | null;
  payloadFormat?: 'json' | 'slack';
  isActive?: boolean;
  secret?: string | null;
}

export interface WebhookTestResult {
  succeeded: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  payload: Record<string, unknown>;
}

export interface WebhookDeliveryRow {
  WebhookDeliveryID: number;
  EventKind: string;
  StatusCode: number | null;
  Succeeded: boolean;
  Error: string | null;
  DurationMs: number | null;
  AttemptedAt: string;
}