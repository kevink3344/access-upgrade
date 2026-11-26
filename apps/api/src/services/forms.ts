import { query, sql, type SqlParam } from '../db.js';

/**
 * Form templates: the staff-designed question sets behind the public
 * registration form.
 *
 * Two rules drive the whole module:
 *
 *  - A version is immutable once published. Editing a template writes a NEW
 *    version, so a link that was shared yesterday keeps asking yesterday's
 *    questions.
 *  - A link pins a version, not a template. `FormTemplateVersionID` on the
 *    link is what the public form reads.
 *
 * Built-in questions carry `MapsToColumn`, which is how an answer still lands
 * in `Participant.Email` and friends. That keeps every existing screen and
 * report working without knowing this feature exists.
 */

/**
 * Where a form's submissions are stored.
 *
 * `registration` writes a Participant/Registration. `trainingRequest` writes a
 * core.TrainingRequest instead, so the submission shows up on the Training
 * requests screen rather than the registrations list.
 */
export type FormTemplateKind = 'registration' | 'trainingRequest';

export const FORM_KINDS: FormTemplateKind[] = ['registration', 'trainingRequest'];

export type FieldType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  /** Live type-ahead over core.Agency; stores the chosen AgencyID. */
  | 'agency'
  /**
   * The workshop's sessions, resolved per link. Stores the chosen session's
   * label so the answer survives the session being edited or deleted.
   */
  | 'session';

export interface FormQuestion {
  formQuestionId: number;
  sortOrder: number;
  questionKey: string;
  label: string;
  helpText: string | null;
  placeholder: string | null;
  fieldType: FieldType;
  isRequired: boolean;
  options: string[];
  maxLength: number | null;
  mapsToColumn: string | null;
  isBuiltIn: boolean;
  /** Shown only when this question's answer matches branchOptionValue. */
  branchOnQuestionKey: string | null;
  branchOptionValue: string | null;
  /** The page this question is asked on. Null = the page-less form. */
  pageId: number | null;
}

/** One page of a paginated form. A version with no pages is a single form. */
export interface FormPage {
  formPageId: number;
  sortOrder: number;
  title: string;
  subtitle: string | null;
}

export interface FormVersion {
  formTemplateVersionId: number;
  formTemplateId: number;
  versionNumber: number;
  publishedAt: string | null;
  publishedBy: string | null;
  questions: FormQuestion[];
  /** Ordered pages. Empty for a version that shows one continuous form. */
  pages: FormPage[];
}

export interface FormTemplateSummary {
  formTemplateId: number;
  name: string;
  description: string | null;
  isActive: boolean;
  /** Where submissions are stored. */
  kind: FormTemplateKind;
  currentVersionNumber: number | null;
  currentVersionId: number | null;
  isPublished: boolean;
  updatedAt: string | null;
  /** Retired forms are hidden from the default list and the link picker. */
  isArchived: boolean;
  archivedAt: string | null;
}

/**
 * The built-in form, matching what the public page has always rendered:
 *
 *   I am registering as  (radio: Educator / Parent-caregiver)
 *   First name, Last name, Email, Phone
 *   -- Educator branch --
 *   School or agency, How old are the students in your class?
 *   -- Parent/caregiver branch --
 *   What are the ages of your children?, Additional parent/caregiver details
 *   Anything we should know?
 *
 * The branching is expressed as data (branchOnQuestionKey + branchOptionValue)
 * rather than in the component, so staff can see and change it.
 */
const BUILT_IN_QUESTIONS: Omit<DraftQuestion, 'sortOrder'>[] = [
  {
    questionKey: 'registrantRole',
    label: 'I am registering as',
    helpText: null,
    placeholder: null,
    fieldType: 'radio',
    isRequired: true,
    options: ['Educator', 'Parent/caregiver'],
    maxLength: null,
    mapsToColumn: null,
    isBuiltIn: true,
  },
  {
    questionKey: 'firstName',
    label: 'First name',
    helpText: null,
    placeholder: null,
    fieldType: 'text',
    isRequired: true,
    options: [],
    maxLength: 30,
    mapsToColumn: 'Participant.FirstName',
    isBuiltIn: true,
  },
  {
    questionKey: 'lastName',
    label: 'Last name',
    helpText: null,
    placeholder: null,
    fieldType: 'text',
    isRequired: true,
    options: [],
    maxLength: 30,
    mapsToColumn: 'Participant.LastName',
    isBuiltIn: true,
  },
  {
    questionKey: 'email',
    label: 'Email',
    helpText: null,
    placeholder: null,
    fieldType: 'text',
    isRequired: true,
    options: [],
    maxLength: 100,
    mapsToColumn: 'Participant.Email',
    isBuiltIn: true,
  },
  {
    questionKey: 'phone',
    label: 'Phone',
    helpText: null,
    placeholder: null,
    fieldType: 'text',
    isRequired: false,
    options: [],
    maxLength: 15,
    mapsToColumn: 'Participant.HomePhone',
    isBuiltIn: true,
  },
  {
    questionKey: 'agency',
    label: 'School or agency',
    helpText: null,
    placeholder: null,
    fieldType: 'agency',
    isRequired: false,
    options: [],
    maxLength: null,
    mapsToColumn: 'Participant.AgencyID',
    isBuiltIn: true,
    branchOnQuestionKey: 'registrantRole',
    branchOptionValue: 'Educator',
  },
  {
    questionKey: 'classAges',
    label: 'How old are the students in your class?',
    helpText: null,
    placeholder: 'e.g. 3-4 year olds',
    fieldType: 'text',
    isRequired: false,
    options: [],
    maxLength: 255,
    mapsToColumn: 'Participant.GradeLevel',
    isBuiltIn: true,
    branchOnQuestionKey: 'registrantRole',
    branchOptionValue: 'Educator',
  },
  {
    questionKey: 'childrenAges',
    label: 'What are the ages of your children?',
    helpText: null,
    placeholder: 'e.g. 2 and 4',
    fieldType: 'text',
    isRequired: false,
    options: [],
    maxLength: 255,
    mapsToColumn: 'Participant.ChildrenAges',
    isBuiltIn: true,
    branchOnQuestionKey: 'registrantRole',
    branchOptionValue: 'Parent/caregiver',
  },
  {
    questionKey: 'secondCaregiver',
    label: 'Additional information for a second parent/caregiver? Please enter it below.',
    helpText: null,
    placeholder: 'Name, phone, email or anything else we should know',
    fieldType: 'longtext',
    isRequired: false,
    options: [],
    maxLength: 2000,
    mapsToColumn: 'Participant.SecondCaregiverInfo',
    isBuiltIn: true,
    branchOnQuestionKey: 'registrantRole',
    branchOptionValue: 'Parent/caregiver',
  },
  {
    questionKey: 'notes',
    label: 'Anything we should know?',
    helpText: null,
    placeholder: null,
    fieldType: 'longtext',
    isRequired: false,
    options: [],
    maxLength: 255,
    mapsToColumn: 'Registration.Notes',
    isBuiltIn: true,
  },
];

export function builtInQuestions() {
  return BUILT_IN_QUESTIONS;
}

/**
 * The questions every public registration asks, whatever the form says.
 *
 * The public page renders the registrant role and the name/email/phone/agency
 * inputs from its own hard-coded fields and skips any question with a
 * `mapsToColumn`, so a form that omits one of these would silently lose it and
 * the submission would fail validation. New templates therefore start with
 * these; the role-specific questions and Notes are the author's to add.
 */
const REQUIRED_KEYS = new Set(['registrantRole', 'firstName', 'lastName', 'email', 'phone', 'agency']);

export function requiredQuestions() {
  return BUILT_IN_QUESTIONS.filter((q) => REQUIRED_KEYS.has(q.questionKey));
}/**
 * The fields a training request asks, seeded into a new form of that kind.
 *
 * The keys are the contract with the submission handler: each maps to a column
 * on core.TrainingRequest, so a request submitted through the public form lands
 * on the Training requests screen with the right values.
 */
export function trainingRequestQuestions(): Omit<DraftQuestion, 'sortOrder'>[] {
  return [
    {
      questionKey: 'agency',
      label: 'School or agency',
      helpText: null,
      placeholder: null,
      fieldType: 'agency',
      isRequired: true,
      options: [],
      maxLength: null,
      mapsToColumn: 'TrainingRequest.AgencyID',
      isBuiltIn: true,
      branchOnQuestionKey: null,
      branchOptionValue: null,
    },
    {
      questionKey: 'requestDescription',
      label: 'Request description',
      helpText: 'What training would you like us to deliver?',
      placeholder: null,
      fieldType: 'longtext',
      isRequired: true,
      options: [],
      maxLength: null,
      mapsToColumn: 'TrainingRequest.Description',
      isBuiltIn: true,
      branchOnQuestionKey: null,
      branchOptionValue: null,
    },
    {
      questionKey: 'requestedBy',
      label: 'Requested by',
      helpText: null,
      placeholder: null,
      fieldType: 'text',
      isRequired: true,
      options: [],
      maxLength: 100,
      mapsToColumn: 'TrainingRequest.RequestedBy',
      isBuiltIn: true,
      branchOnQuestionKey: null,
      branchOptionValue: null,
    },
    {
      questionKey: 'requestedByEmail',
      label: 'Requested by email',
      helpText: null,
      placeholder: null,
      fieldType: 'text',
      isRequired: true,
      options: [],
      maxLength: 100,
      mapsToColumn: 'TrainingRequest.RequestEmail',
      isBuiltIn: true,
      branchOnQuestionKey: null,
      branchOptionValue: null,
    },
    {
      questionKey: 'requestPhone',
      label: 'Phone',
      helpText: null,
      placeholder: null,
      fieldType: 'text',
      isRequired: false,
      options: [],
      maxLength: 14,
      mapsToColumn: 'TrainingRequest.RequestPhone',
      isBuiltIn: true,
      branchOnQuestionKey: null,
      branchOptionValue: null,
    },
  ];
}

/**
 * Next free id for a non-IDENTITY table.
 *
 * The read and the write are one statement, so concurrent callers cannot both
 * read the same maximum and then collide on the primary key. `UPDLOCK` takes
 * the update lock on the row the aggregate reads; `HOLDLOCK` holds it until
 * the insert commits, which is what serialises two callers.
 *
 * `seed` supplies the table's other NOT NULL columns. They cannot be omitted
 * from the INSERT: SQL Server applies no defaults to them, so a bare id insert
 * fails with "Cannot insert the value NULL" before the caller's UPDATE runs.
 */
async function nextId(
  table: string,
  column: string,
  seed?: Record<string, SqlParam>,
): Promise<number> {
  const names = seed ? Object.keys(seed) : [];
  const placeholders = names.map((k) => `@${k}`);

  const r = await query<{ id: number }>(
    `DECLARE @id INT;
     SELECT @id = ISNULL(MAX(${column}), 0) + 1
       FROM ${table} WITH (UPDLOCK, HOLDLOCK);
     INSERT INTO ${table} (${column}${names.length ? ', ' + names.join(', ') : ''})
     OUTPUT INSERTED.${column} AS id
     VALUES (@id${placeholders.length ? ', ' + placeholders.join(', ') : ''});`,
    seed,
  );
  return r.recordset[0]!.id;
}

function parseOptions(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

export async function listTemplates(includeArchived = false): Promise<FormTemplateSummary[]> {
  const r = await query<{
    FormTemplateID: number;
    Name: string;
    Description: string | null;
    IsActive: boolean;
    Kind: FormTemplateKind;
    UpdatedAt: Date | null;
    ArchivedAt: Date | null;
    CurrentVersionID: number | null;
    CurrentVersionNumber: number | null;
    PublishedAt: Date | null;
  }>(
    `SELECT t.FormTemplateID, t.Name, t.Description, t.IsActive, t.Kind, t.UpdatedAt, t.ArchivedAt,
            v.FormTemplateVersionID AS CurrentVersionID,
            v.VersionNumber        AS CurrentVersionNumber,
            v.PublishedAt
       FROM core.FormTemplate t
       OUTER APPLY (
            SELECT TOP 1 FormTemplateVersionID, VersionNumber, PublishedAt
              FROM core.FormTemplateVersion
             WHERE FormTemplateID = t.FormTemplateID
             ORDER BY VersionNumber DESC
       ) v
      WHERE (@includeArchived = 1 OR t.ArchivedAt IS NULL)
      ORDER BY t.ArchivedAt, t.Name`,
    { includeArchived: { type: sql.Bit, value: includeArchived ? 1 : 0 } },
  );

  return r.recordset.map((x) => ({
    formTemplateId: x.FormTemplateID,
    name: x.Name,
    description: x.Description,
    isActive: x.IsActive,
    kind: x.Kind,
    currentVersionId: x.CurrentVersionID,
    currentVersionNumber: x.CurrentVersionNumber,
    isPublished: x.PublishedAt !== null,
    updatedAt: x.UpdatedAt ? x.UpdatedAt.toISOString() : null,
    isArchived: x.ArchivedAt !== null,
    archivedAt: x.ArchivedAt ? x.ArchivedAt.toISOString() : null,
  }));
}

/** Every version of one template, newest first, without questions. */
export async function listVersions(formTemplateId: number) {
  const r = await query<{
    FormTemplateVersionID: number;
    VersionNumber: number;
    PublishedAt: Date | null;
    PublishedBy: string | null;
    CreatedBy: string;
    CreatedAt: Date;
    QuestionCount: number;
  }>(
    `SELECT v.FormTemplateVersionID, v.VersionNumber, v.PublishedAt, v.PublishedBy,
            v.CreatedBy, v.CreatedAt,
            (SELECT COUNT(*) FROM core.FormQuestion q
              WHERE q.FormTemplateVersionID = v.FormTemplateVersionID AND q.IsActive = 1) AS QuestionCount
       FROM core.FormTemplateVersion v
      WHERE v.FormTemplateID = @id
      ORDER BY v.VersionNumber DESC`,
    { id: { type: sql.Int, value: formTemplateId } },
  );

  return r.recordset.map((x) => ({
    formTemplateVersionId: x.FormTemplateVersionID,
    versionNumber: x.VersionNumber,
    publishedAt: x.PublishedAt ? x.PublishedAt.toISOString() : null,
    publishedBy: x.PublishedBy,
    createdBy: x.CreatedBy,
    createdAt: x.CreatedAt.toISOString(),
    questionCount: x.QuestionCount,
  }));
}

/** One version with its questions, in display order. */
export async function getVersion(versionId: number): Promise<FormVersion | null> {
  const v = await query<{
    FormTemplateVersionID: number;
    FormTemplateID: number;
    VersionNumber: number;
    PublishedAt: Date | null;
    PublishedBy: string | null;
  }>(
    `SELECT FormTemplateVersionID, FormTemplateID, VersionNumber, PublishedAt, PublishedBy
       FROM core.FormTemplateVersion WHERE FormTemplateVersionID = @id`,
    { id: { type: sql.Int, value: versionId } },
  );

  const head = v.recordset[0];
  if (!head) return null;

  const q = await query<{
    FormQuestionID: number;
    SortOrder: number;
    QuestionKey: string;
    Label: string;
    HelpText: string | null;
    Placeholder: string | null;
    FieldType: FieldType;
    IsRequired: boolean;
    OptionsJson: string | null;
    MaxLength: number | null;
    MapsToColumn: string | null;
    IsBuiltIn: boolean;
    BranchOnQuestionID: number | null;
    BranchOptionValue: string | null;
    BranchOnKey: string | null;
    FormPageID: number | null;
  }>(
    `SELECT q.FormQuestionID, q.SortOrder, q.QuestionKey, q.Label, q.HelpText, q.Placeholder,
            q.FieldType, q.IsRequired, q.OptionsJson, q.MaxLength, q.MapsToColumn, q.IsBuiltIn,
            q.BranchOnQuestionID, q.BranchOptionValue,
            b.QuestionKey AS BranchOnKey,
            q.FormPageID
       FROM core.FormQuestion q
       LEFT JOIN core.FormQuestion b ON b.FormQuestionID = q.BranchOnQuestionID
      WHERE q.FormTemplateVersionID = @id AND q.IsActive = 1
      ORDER BY q.SortOrder, q.FormQuestionID`,
    { id: { type: sql.Int, value: versionId } },
  );

  const pages = await query<{
    FormPageID: number;
    SortOrder: number;
    Title: string;
    Subtitle: string | null;
  }>(
    `SELECT FormPageID, SortOrder, Title, Subtitle
       FROM core.FormPage
      WHERE FormTemplateVersionID = @id
      ORDER BY SortOrder, FormPageID`,
    { id: { type: sql.Int, value: versionId } },
  );

  return {
    formTemplateVersionId: head.FormTemplateVersionID,
    formTemplateId: head.FormTemplateID,
    versionNumber: head.VersionNumber,
    publishedAt: head.PublishedAt ? head.PublishedAt.toISOString() : null,
    publishedBy: head.PublishedBy,
    questions: q.recordset.map((x) => ({
      formQuestionId: x.FormQuestionID,
      sortOrder: x.SortOrder,
      questionKey: x.QuestionKey,
      label: x.Label,
      helpText: x.HelpText,
      placeholder: x.Placeholder,
      fieldType: x.FieldType,
      isRequired: x.IsRequired,
      options: parseOptions(x.OptionsJson),
      maxLength: x.MaxLength,
      mapsToColumn: x.MapsToColumn,
      isBuiltIn: x.IsBuiltIn,
      branchOnQuestionKey: x.BranchOnKey,
      branchOptionValue: x.BranchOptionValue,
      pageId: x.FormPageID,
    })),
    pages: pages.recordset.map((p) => ({
      formPageId: p.FormPageID,
      sortOrder: p.SortOrder,
      title: p.Title,
      subtitle: p.Subtitle,
    })),
  };
}

/** The version a public link is pinned to. Null when the link uses the built-in form. */
export async function getVersionForLink(linkId: number): Promise<FormVersion | null> {
  const r = await query<{ FormTemplateVersionID: number | null }>(
    `SELECT FormTemplateVersionID FROM core.WorkshopRegistrationLink WHERE RegistrationLinkID = @id`,
    { id: { type: sql.Int, value: linkId } },
  );
  const id = r.recordset[0]?.FormTemplateVersionID;
  if (!id) return null;
  return getVersion(id);
}

/**
 * Where the form pinned to a link stores its submissions.
 *
 * A link with no pinned version uses the built-in registration form, so the
 * default is `registration`.
 */
export async function getKindForLink(linkId: number): Promise<FormTemplateKind> {
  const r = await query<{ Kind: FormTemplateKind | null }>(
    `SELECT t.Kind
       FROM core.WorkshopRegistrationLink l
       JOIN core.FormTemplateVersion v ON v.FormTemplateVersionID = l.FormTemplateVersionID
       JOIN core.FormTemplate t ON t.FormTemplateID = v.FormTemplateID
      WHERE l.RegistrationLinkID = @id`,
    { id: { type: sql.Int, value: linkId } },
  );
  return r.recordset[0]?.Kind ?? 'registration';
}

/**
 * Write a training-request submission to core.TrainingRequest.
 *
 * The answers are keyed by question key, which for this form kind is the
 * contract with `trainingRequestQuestions()`. Unknown keys are ignored, so a
 * crafted payload cannot set columns the form never asked about.
 */
export async function createTrainingRequestFromAnswers(
  answers: Record<string, unknown>,
  version?: FormVersion,
): Promise<number> {
  const str = (key: string, max: number): string | null => {
    const v = answers[key];
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? null : t.slice(0, max);
  };

  const agencyRaw = answers.agency;
  const agencyId =
    typeof agencyRaw === 'number'
      ? agencyRaw
      : typeof agencyRaw === 'string' && /^\d+$/.test(agencyRaw.trim())
        ? Number(agencyRaw.trim())
        : null;

  const description = str('requestDescription', 2000);
  const requestedBy = str('requestedBy', 100);
  const requestEmail = str('requestedByEmail', 100);
  const requestPhone = str('requestPhone', 14);

  const created = await query<{ TrainingRequestID: number }>(
    `INSERT INTO core.TrainingRequest
            (TrainingRequestID, AgencyID, RequestDate, RequestedBy, RequestPhone,
             RequestEmail, Description, IsActive)
     OUTPUT INSERTED.TrainingRequestID
     SELECT ISNULL(MAX(TrainingRequestID), 0) + 1, @agency, CAST(SYSUTCDATETIME() AS DATE),
            @by, @phone, @email, @desc, 1
       FROM core.TrainingRequest WITH (UPDLOCK, HOLDLOCK)`,
    {
      agency: { type: sql.Int, value: agencyId },
      by: { type: sql.NVarChar(100), value: requestedBy },
      phone: { type: sql.NVarChar(14), value: requestPhone },
      email: { type: sql.NVarChar(100), value: requestEmail },
      desc: { type: sql.NVarChar(sql.MAX), value: description },
    },
  );

  return created.recordset[0]!.TrainingRequestID;
}

/**
 * Record every answer on a training-request form.
 *
 * Only the five mapped keys reach core.TrainingRequest; the rest would be
 * lost without this. Built-in keys are stored too, so the Form answers tab
 * shows exactly what the requester saw rather than only the extras.
 */
export async function saveTrainingRequestAnswers(
  trainingRequestId: number,
  version: FormVersion,
  answers: Record<string, unknown>,
): Promise<void> {
  const byKey = new Map(version.questions.map((q) => [q.questionKey, q]));

  for (const [key, raw] of Object.entries(answers)) {
    const q = byKey.get(key);
    if (!q) continue;

    let answerText: string | null = null;
    let answerJson: string | null = null;

    if (Array.isArray(raw)) {
      if (raw.length === 0) continue;
      const list = raw.map(String);
      answerJson = JSON.stringify(list);
      answerText = list.join(', ');
    } else if (raw === null || raw === undefined || raw === '') {
      continue;
    } else {
      answerText = String(raw);
    }

    // The agency picker stores an id; keep the id as the answer so the read
    // side can resolve the current name, exactly as registrations do.
    await query(
      `INSERT INTO core.FormAnswer (FormAnswerID, TrainingRequestID, FormQuestionID, AnswerText, AnswerJson)
       SELECT ISNULL(MAX(FormAnswerID), 0) + 1, @tr, @q, @text, @json
         FROM core.FormAnswer WITH (UPDLOCK, HOLDLOCK)`,
      {
        tr: { type: sql.Int, value: trainingRequestId },
        q: { type: sql.Int, value: q.formQuestionId },
        text: { type: sql.NVarChar(sql.MAX), value: answerText },
        json: { type: sql.NVarChar(sql.MAX), value: answerJson },
      },
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

export async function createTemplate(input: {
  name: string;
  description?: string | null;
  actor: string;
  kind?: FormTemplateKind;
}): Promise<{ formTemplateId: number; versionId: number }> {
  const kind = input.kind ?? 'registration';

  const templateId = await nextId('core.FormTemplate', 'FormTemplateID', {
    Name: { type: sql.NVarChar(100), value: input.name },
    Description: { type: sql.NVarChar(500), value: input.description ?? null },
    IsActive: { type: sql.Bit, value: 1 },
    Kind: { type: sql.NVarChar(30), value: kind },
    CreatedBy: { type: sql.NVarChar(200), value: input.actor },
  });

  // A new template starts as an unpublished v1. A registration form gets only
  // the questions the public page always asks (role, name, email, phone,
  // agency); a training request form gets the request fields instead. Either
  // way it is not a copy of whatever form was created last.
  const seed = kind === 'trainingRequest' ? trainingRequestQuestions() : requiredQuestions();

  const versionId = await insertVersion(
    templateId,
    1,
    input.actor,
    seed.map((q, i) => ({ ...q, sortOrder: i + 1 })),
    [],
  );

  return { formTemplateId: templateId, versionId };
}

async function insertVersion(
  formTemplateId: number,
  versionNumber: number,
  actor: string,
  questions: DraftQuestion[],
  pages: DraftPage[],
): Promise<number> {
  const versionId = await nextId('core.FormTemplateVersion', 'FormTemplateVersionID', {
    FormTemplateID: { type: sql.Int, value: formTemplateId },
    VersionNumber: { type: sql.Int, value: versionNumber },
    CreatedBy: { type: sql.NVarChar(200), value: actor },
  });

  await query(
    `UPDATE core.FormTemplateVersion
        SET FormTemplateID = @tpl, VersionNumber = @num, CreatedBy = @by
      WHERE FormTemplateVersionID = @id`,
    {
      id: { type: sql.Int, value: versionId },
      tpl: { type: sql.Int, value: formTemplateId },
      num: { type: sql.Int, value: versionNumber },
      by: { type: sql.NVarChar(200), value: actor },
    },
  );

  // Insert the questions directly rather than pre-allocating placeholder rows
  // and updating them: FormQuestion has UNIQUE (FormTemplateVersionID,
  // QuestionKey), so a placeholder's key would collide with the real row that
  // replaces it. One statement per question keeps the ids contiguous.
  const keyToId = new Map<string, number>();
  const startId = await nextQuestionId();
  questions.forEach((q, i) => keyToId.set(q.questionKey, startId + i));

  // Pages first: a question's FormPageID must point at a row that exists.
  const pageKeyToId = new Map<string, number>();
  for (const [i, p] of pages.entries()) {
    const pageId = await nextId('core.FormPage', 'FormPageID', {
      FormTemplateVersionID: { type: sql.Int, value: versionId },
      SortOrder: { type: sql.Int, value: i + 1 },
      Title: { type: sql.NVarChar(100), value: p.title },
    });
    await query(
      `UPDATE core.FormPage SET Subtitle = @sub WHERE FormPageID = @id`,
      {
        id: { type: sql.Int, value: pageId },
        sub: { type: sql.NVarChar(300), value: p.subtitle ?? null },
      },
    );
    pageKeyToId.set(p.key, pageId);
  }

  for (const [i, q] of questions.entries()) {
    const branchOnId = q.branchOnQuestionKey ? (keyToId.get(q.branchOnQuestionKey) ?? null) : null;
    const pageId = q.pageKey ? (pageKeyToId.get(q.pageKey) ?? null) : null;

    await query(
      `INSERT INTO core.FormQuestion
              (FormQuestionID, FormTemplateVersionID, SortOrder, QuestionKey, Label, HelpText,
               Placeholder, FieldType, IsRequired, OptionsJson, MaxLength, MapsToColumn,
               IsBuiltIn, BranchOnQuestionID, BranchOptionValue, FormPageID)
       VALUES (@id, @ver, @sort, @key, @label, @help, @ph, @type, @req, @opts, @maxLen,
               @maps, @builtIn, @branchOn, @branchVal, @page)`,
      {
        id: { type: sql.Int, value: startId + i },
        ver: { type: sql.Int, value: versionId },
        sort: { type: sql.Int, value: q.sortOrder },
        key: { type: sql.NVarChar(50), value: q.questionKey },
        label: { type: sql.NVarChar(200), value: q.label },
        help: { type: sql.NVarChar(300), value: q.helpText ?? null },
        ph: { type: sql.NVarChar(100), value: q.placeholder ?? null },
        type: { type: sql.NVarChar(20), value: q.fieldType },
        req: { type: sql.Bit, value: q.isRequired ? 1 : 0 },
        opts: { type: sql.NVarChar(sql.MAX), value: q.options.length ? JSON.stringify(q.options) : null },
        maxLen: { type: sql.Int, value: q.maxLength ?? null },
        maps: { type: sql.NVarChar(50), value: q.mapsToColumn ?? null },
        builtIn: { type: sql.Bit, value: q.isBuiltIn ? 1 : 0 },
        branchOn: { type: sql.Int, value: branchOnId },
        branchVal: { type: sql.NVarChar(100), value: branchOnId ? (q.branchOptionValue ?? null) : null },
        page: { type: sql.Int, value: pageId },
      },
    );
  }

  return versionId;
}

/**
 * First id for a block of consecutive FormQuestion rows.
 *
 * Read and insert are one statement under UPDLOCK/HOLDLOCK, so two callers
 * cannot claim the same block.
 */
async function nextQuestionId(): Promise<number> {
  const r = await query<{ id: number }>(
    `SELECT ISNULL(MAX(FormQuestionID), 0) + 1 AS id
       FROM core.FormQuestion WITH (UPDLOCK, HOLDLOCK)`,
  );
  return r.recordset[0]!.id;
}

/** A question as supplied by the editor — optional fields may be absent. */
export interface DraftQuestion {
  sortOrder: number;
  questionKey: string;
  label: string;
  helpText?: string | null;
  placeholder?: string | null;
  fieldType: FieldType;
  isRequired: boolean;
  options: string[];
  maxLength?: number | null;
  mapsToColumn?: string | null;
  isBuiltIn: boolean;
  /** Question key whose answer gates this one. Null = always shown. */
  branchOnQuestionKey?: string | null;
  branchOptionValue?: string | null;
  /** Temporary page key from the editor. Resolved to a FormPageID on insert. */
  pageKey?: string | null;
}

/** A page as supplied by the editor. `key` is a client handle, not an id. */
export interface DraftPage {
  key: string;
  title: string;
  subtitle?: string | null;
}

/**
 * Save a new draft version from a question list.
 *
 * Always creates a NEW version rather than editing the current one, because a
 * published version may already have answers pointing at its question ids.
 */
export async function saveDraft(input: {
  formTemplateId: number;
  questions: DraftQuestion[];
  pages?: DraftPage[];
  actor: string;
}): Promise<number> {
  const next = await query<{ n: number }>(
    `SELECT ISNULL(MAX(VersionNumber), 0) + 1 AS n
       FROM core.FormTemplateVersion WHERE FormTemplateID = @id`,
    { id: { type: sql.Int, value: input.formTemplateId } },
  );

  return insertVersion(
    input.formTemplateId,
    next.recordset[0]!.n,
    input.actor,
    input.questions,
    input.pages ?? [],
  );
}

export async function publishVersion(versionId: number, actor: string): Promise<void> {
  await query(
    `UPDATE core.FormTemplateVersion
        SET PublishedAt = SYSUTCDATETIME(), PublishedBy = @by
      WHERE FormTemplateVersionID = @id AND PublishedAt IS NULL`,
    {
      id: { type: sql.Int, value: versionId },
      by: { type: sql.NVarChar(200), value: actor },
    },
  );
}

export async function updateTemplate(
  formTemplateId: number,
  patch: { name?: string; description?: string | null; isActive?: boolean },
  actor: string,
): Promise<void> {
  const sets: string[] = ['UpdatedBy = @by', 'UpdatedAt = SYSUTCDATETIME()'];
  const params: Record<string, SqlParam> = {
    id: { type: sql.Int, value: formTemplateId },
    by: { type: sql.NVarChar(200), value: actor },
  };

  if (patch.name !== undefined) {
    sets.push('Name = @name');
    params.name = { type: sql.NVarChar(100), value: patch.name };
  }
  if (patch.description !== undefined) {
    sets.push('Description = @desc');
    params.desc = { type: sql.NVarChar(500), value: patch.description };
  }
  if (patch.isActive !== undefined) {
    sets.push('IsActive = @active');
    params.active = { type: sql.Bit, value: patch.isActive ? 1 : 0 };
  }

  await query(
    `UPDATE core.FormTemplate SET ${sets.join(', ')} WHERE FormTemplateID = @id`,
    params,
  );
}

/** How many links point at any version of this template. */
export async function countLinksUsingTemplate(formTemplateId: number): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM core.WorkshopRegistrationLink l
       JOIN core.FormTemplateVersion v ON v.FormTemplateVersionID = l.FormTemplateVersionID
      WHERE v.FormTemplateID = @id`,
    { id: { type: sql.Int, value: formTemplateId } },
  );
  return r.recordset[0]?.n ?? 0;
}

/**
 * Retire a form without destroying anything.
 *
 * A form that is in use by a registration link is refused: archiving it would
 * leave a live link pointing at a form staff can no longer see or edit.
 */
export async function archiveTemplate(
  formTemplateId: number,
  actor: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const inUse = await countLinksUsingTemplate(formTemplateId);
  if (inUse > 0) {
    return {
      ok: false,
      reason: `${inUse} registration link(s) use this form. Repoint them before archiving.`,
    };
  }

  await query(
    `UPDATE core.FormTemplate
        SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @by,
            UpdatedBy = @by, UpdatedAt = SYSUTCDATETIME()
      WHERE FormTemplateID = @id AND ArchivedAt IS NULL`,
    {
      id: { type: sql.Int, value: formTemplateId },
      by: { type: sql.NVarChar(200), value: actor },
    },
  );

  return { ok: true };
}

export async function restoreTemplate(formTemplateId: number, actor: string): Promise<void> {
  await query(
    `UPDATE core.FormTemplate
        SET ArchivedAt = NULL, ArchivedBy = NULL,
            UpdatedBy = @by, UpdatedAt = SYSUTCDATETIME()
      WHERE FormTemplateID = @id`,
    {
      id: { type: sql.Int, value: formTemplateId },
      by: { type: sql.NVarChar(200), value: actor },
    },
  );
}

/* ------------------------------------------------------------------ */
/*  Answers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Persist answers for one registration.
 *
 * `answers` is keyed by QuestionKey. Only questions that exist on the pinned
 * version are written, so a crafted key cannot create a row against a question
 * the registrant was never shown.
 */
export async function saveAnswers(
  registrationId: number,
  version: FormVersion,
  answers: Record<string, unknown>,
): Promise<void> {
  const byKey = new Map(version.questions.map((q) => [q.questionKey, q]));

  for (const [key, raw] of Object.entries(answers)) {
    const q = byKey.get(key);
    if (!q) continue;

    // Built-in questions are written to their real column by the caller; we
    // still record them here so the answers export is complete.
    let answerText: string | null = null;
    let answerJson: string | null = null;

    if (Array.isArray(raw)) {
      answerJson = JSON.stringify(raw.map(String));
      answerText = raw.map(String).join(', ');
    } else if (raw === null || raw === undefined || raw === '') {
      continue;
    } else {
      answerText = String(raw);
    }

    // One insert per answer: the id is only needed as the row's key, so
    // allocating it up front and then UPDATEing would be a wasted round trip.
    await query(
      `INSERT INTO core.FormAnswer (FormAnswerID, RegistrationID, FormQuestionID, AnswerText, AnswerJson)
       SELECT ISNULL(MAX(FormAnswerID), 0) + 1, @reg, @q, @text, @json
         FROM core.FormAnswer WITH (UPDLOCK, HOLDLOCK)`,
      {
        reg: { type: sql.Int, value: registrationId },
        q: { type: sql.Int, value: q.formQuestionId },
        text: { type: sql.NVarChar(sql.MAX), value: answerText },
        json: { type: sql.NVarChar(sql.MAX), value: answerJson },
      },
    );
  }
}

/**
 * Answers for one registration, plus which form the registrant actually saw.
 *
 * Built-in questions (name, email, phone, agency, notes) are stored in their
 * real columns rather than in FormAnswer, so they are read from there and
 * merged in. Without this the tab would show only the custom questions, which
 * is not the form the registrant actually completed.
 */
export async function answersForRegistration(registrationId: number) {
  // The form name comes from the link the registration came through, which
  // pins a version. A NULL version means the built-in form was used.
  const meta = await query<{
    FormName: string | null;
    VersionNumber: number | null;
    RegistrationLinkID: number | null;
    FirstName: string | null;
    LastName: string | null;
    Email: string | null;
    HomePhone: string | null;
    AgencyName: string | null;
    Notes: string | null;
    IsTeacherMailingList: boolean | null;
    IsParentMailingList: boolean | null;
    ChildrenAges: string | null;
    SecondCaregiverInfo: string | null;
    GradeLevel: string | null;
  }>(
    `SELECT t.Name AS FormName, v.VersionNumber, r.RegistrationLinkID,
            p.FirstName, p.LastName, p.Email, p.HomePhone, r.Notes,
            p.IsTeacherMailingList, p.IsParentMailingList,
            p.ChildrenAges, p.SecondCaregiverInfo, p.GradeLevel,
            ag.AgencyName
       FROM core.Registration r
       JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
       LEFT JOIN core.Agency ag ON ag.AgencyID = p.AgencyID
       LEFT JOIN core.WorkshopRegistrationLink l
              ON l.RegistrationLinkID = r.RegistrationLinkID
       LEFT JOIN core.FormTemplateVersion v
              ON v.FormTemplateVersionID = l.FormTemplateVersionID
       LEFT JOIN core.FormTemplate t
              ON t.FormTemplateID = v.FormTemplateID
      WHERE r.RegistrationID = @id`,
    { id: { type: sql.Int, value: registrationId } },
  );

  const head = meta.recordset[0];

  const r = await query<{
    QuestionKey: string;
    Label: string;
    FieldType: FieldType;
    SortOrder: number;
    AnswerText: string | null;
    AgencyName: string | null;
  }>(
    `SELECT q.QuestionKey, q.Label, q.FieldType, q.SortOrder, a.AnswerText, ag.AgencyName
       FROM core.FormAnswer a
       JOIN core.FormQuestion q ON q.FormQuestionID = a.FormQuestionID
       -- An agency answer stores the AgencyID; resolve it so staff read a
       -- school name rather than a number.
       LEFT JOIN core.Agency ag
              ON q.FieldType = 'agency'
             AND TRY_CAST(a.AnswerText AS INT) = ag.AgencyID
      WHERE a.RegistrationID = @id
      ORDER BY q.SortOrder`,
    { id: { type: sql.Int, value: registrationId } },
  );

  /**
   * The fields the built-in form has always asked, in the order it asks them.
   *
   * These are not FormAnswer rows — the public form writes them straight to
   * Participant/Registration — so they are read from those columns. The role
   * branch follows, matching how the public form branches.
   */
  const builtIn: { questionKey: string; label: string; value: string | null }[] = [];

  if (head) {
    const role =
      head.IsTeacherMailingList && !head.IsParentMailingList
        ? 'Educator'
        : head.IsParentMailingList && !head.IsTeacherMailingList
          ? 'Parent/caregiver'
          : null;

    if (role) builtIn.push({ questionKey: 'registrantRole', label: 'I am registering as', value: role });

    builtIn.push(
      { questionKey: 'firstName', label: 'First name', value: head.FirstName },
      { questionKey: 'lastName', label: 'Last name', value: head.LastName },
      { questionKey: 'email', label: 'Email', value: head.Email },
      { questionKey: 'phone', label: 'Phone', value: head.HomePhone },
      { questionKey: 'agency', label: 'School or agency', value: head.AgencyName },
    );

    // The role-specific questions, mirroring the public form's branch.
    if (role === 'Educator' && head.GradeLevel) {
      builtIn.push({
        questionKey: 'classAges',
        label: 'How old are the students in your class?',
        value: head.GradeLevel,
      });
    }
    if (role === 'Parent/caregiver') {
      if (head.ChildrenAges) {
        builtIn.push({
          questionKey: 'childrenAges',
          label: 'What are the ages of your children?',
          value: head.ChildrenAges,
        });
      }
      if (head.SecondCaregiverInfo) {
        builtIn.push({
          questionKey: 'secondCaregiver',
          label: 'Additional parent/caregiver details',
          value: head.SecondCaregiverInfo,
        });
      }
    }

    builtIn.push({ questionKey: 'notes', label: 'Anything we should know?', value: head.Notes });
  }

  // Custom answers come after the built-ins, as they do on the public form.
  const custom = r.recordset.map((x) => ({
    questionKey: x.QuestionKey,
    label: x.Label,
    value: x.FieldType === 'agency' ? (x.AgencyName ?? x.AnswerText) : x.AnswerText,
  }));

  return {
    formName: head?.FormName ?? null,
    formVersionNumber: head?.VersionNumber ?? null,
    answers: [...builtIn, ...custom],
  };
}

/**
 * The answers submitted on a training-request form, grouped by page.
 *
 * Ordered by the page the requester saw, then the question order on it, so
 * staff can read the request the way it was filled in. Requests submitted
 * before answers were recorded return an empty list rather than an error.
 */
export async function answersForTrainingRequest(trainingRequestId: number) {
  const r = await query<{
    QuestionKey: string;
    Label: string;
    FieldType: FieldType;
    PageTitle: string | null;
    PageSort: number | null;
    SortOrder: number;
    AnswerText: string | null;
    AnswerJson: string | null;
    AgencyName: string | null;
  }>(
    `SELECT q.QuestionKey, q.Label, q.FieldType, q.SortOrder,
            p.Title AS PageTitle, p.SortOrder AS PageSort,
            a.AnswerText, a.AnswerJson, ag.AgencyName
       FROM core.FormAnswer a
       JOIN core.FormQuestion q ON q.FormQuestionID = a.FormQuestionID
       LEFT JOIN core.FormPage p ON p.FormPageID = q.FormPageID
       -- An agency answer stores the AgencyID; resolve it so staff read a
       -- school name rather than a number.
       LEFT JOIN core.Agency ag
              ON q.FieldType = 'agency'
             AND TRY_CAST(a.AnswerText AS INT) = ag.AgencyID
      WHERE a.TrainingRequestID = @id
      ORDER BY ISNULL(p.SortOrder, 0), q.SortOrder, q.FormQuestionID`,
    { id: { type: sql.Int, value: trainingRequestId } },
  );

  /** Page title -> answers, in the order the rows arrived. */
  const pages: { title: string | null; answers: { label: string; value: string }[] }[] = [];

  for (const x of r.recordset) {
    const value =
      x.FieldType === 'agency' ? (x.AgencyName ?? x.AnswerText ?? '') : (x.AnswerText ?? '');
    if (!value) continue;

    const title = x.PageTitle ?? null;
    let group = pages.find((g) => g.title === title);
    if (!group) {
      group = { title, answers: [] };
      pages.push(group);
    }
    group.answers.push({ label: x.Label, value });
  }

  return pages;
}

/** Answers for every registrant on a workshop, grouped by registration. */
export async function answersForWorkshop(workshopId: number) {
  const r = await query<{
    RegistrationID: number;
    ParticipantName: string | null;
    FormQuestionID: number;
    QuestionKey: string;
    Label: string;
    FieldType: FieldType;
    SortOrder: number;
    AnswerText: string | null;
    AgencyName: string | null;
  }>(
    `SELECT r.RegistrationID,
            CONCAT(p.FirstName, ' ', p.LastName) AS ParticipantName,
            q.FormQuestionID, q.QuestionKey, q.Label, q.FieldType, q.SortOrder, a.AnswerText,
            ag.AgencyName
       FROM core.Registration r
       JOIN core.Participant p ON p.ParticipantID = r.ParticipantID
       JOIN core.FormAnswer a ON a.RegistrationID = r.RegistrationID
       JOIN core.FormQuestion q ON q.FormQuestionID = a.FormQuestionID
       -- An agency answer stores the AgencyID; resolve it so staff read a
       -- school name rather than a number.
       LEFT JOIN core.Agency ag
              ON q.FieldType = 'agency'
             AND TRY_CAST(a.AnswerText AS INT) = ag.AgencyID
      WHERE r.WorkshopID = @w
      ORDER BY r.RegistrationID, q.SortOrder`,
    { w: { type: sql.Int, value: workshopId } },
  );

  const byReg = new Map<
    number,
    { registrationId: number; participantName: string | null; answers: { questionKey: string; label: string; value: string | null }[] }
  >();

  for (const row of r.recordset) {
    let entry = byReg.get(row.RegistrationID);
    if (!entry) {
      entry = {
        registrationId: row.RegistrationID,
        participantName: row.ParticipantName,
        answers: [],
      };
      byReg.set(row.RegistrationID, entry);
    }
    entry.answers.push({
      questionKey: row.QuestionKey,
      label: row.Label,
      value: row.FieldType === 'agency' ? (row.AgencyName ?? row.AnswerText) : row.AnswerText,
    });
  }

  return [...byReg.values()];
}

/** Answers for one participant, grouped by workshop (participant detail). */
export async function answersForParticipant(participantId: number) {
  const r = await query<{
    RegistrationID: number;
    WorkshopID: number;
    WorkshopCode: string | null;
    WorkshopName: string | null;
    StartDate: Date | null;
    QuestionKey: string;
    Label: string;
    FieldType: FieldType;
    SortOrder: number;
    AnswerText: string | null;
    AgencyName: string | null;
  }>(
    `SELECT r.RegistrationID, w.WorkshopID, w.WorkshopCode, n.WorkshopName, w.StartDate,
            q.QuestionKey, q.Label, q.FieldType, q.SortOrder, a.AnswerText,
            ag.AgencyName
       FROM core.Registration r
       JOIN core.Workshop w ON w.WorkshopID = r.WorkshopID
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
       JOIN core.FormAnswer a ON a.RegistrationID = r.RegistrationID
       JOIN core.FormQuestion q ON q.FormQuestionID = a.FormQuestionID
       LEFT JOIN core.Agency ag
              ON q.FieldType = 'agency'
             AND TRY_CAST(a.AnswerText AS INT) = ag.AgencyID
      WHERE r.ParticipantID = @p
      ORDER BY w.StartDate DESC, q.SortOrder`,
    { p: { type: sql.Int, value: participantId } },
  );

  const byReg = new Map<
    number,
    {
      registrationId: number;
      workshopId: number;
      workshopCode: string | null;
      workshopName: string | null;
      startDate: string | null;
      answers: { questionKey: string; label: string; value: string | null }[];
    }
  >();

  for (const row of r.recordset) {
    let entry = byReg.get(row.RegistrationID);
    if (!entry) {
      entry = {
        registrationId: row.RegistrationID,
        workshopId: row.WorkshopID,
        workshopCode: row.WorkshopCode,
        workshopName: row.WorkshopName,
        startDate: row.StartDate ? row.StartDate.toISOString().slice(0, 10) : null,
        answers: [],
      };
      byReg.set(row.RegistrationID, entry);
    }
    entry.answers.push({
      questionKey: row.QuestionKey,
      label: row.Label,
      value: row.FieldType === 'agency' ? (row.AgencyName ?? row.AnswerText) : row.AnswerText,
    });
  }

  return [...byReg.values()];
}
