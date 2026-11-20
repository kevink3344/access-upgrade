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
    webRegistrations: number;
    createdBy: string;
    createdAt: string;
  } | null;
}

export interface PublicLinkState {
  state: PublicLinkStatus;
  /** Seats left, from the live roster. Null when the workshop is uncapped. */
  seatsRemaining: number | null;
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
}
