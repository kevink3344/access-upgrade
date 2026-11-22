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

export type FieldType =
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
  fieldType: FieldType;
  isRequired: boolean;
  options: string[];
  maxLength: number | null;
  mapsToColumn: string | null;
  isBuiltIn: boolean;
}

export interface FormVersion {
  formTemplateVersionId: number;
  formTemplateId: number;
  versionNumber: number;
  publishedAt: string | null;
  publishedBy: string | null;
  questions: FormQuestion[];
}

export interface FormTemplateSummary {
  formTemplateId: number;
  name: string;
  description: string | null;
  isActive: boolean;
  currentVersionNumber: number | null;
  currentVersionId: number | null;
  isPublished: boolean;
  updatedAt: string | null;
}

/** The six fields the built-in form has always had. Seeded into every new template. */
const BUILT_IN_QUESTIONS: Omit<DraftQuestion, 'sortOrder'>[] = [
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

/** Next free id for a non-IDENTITY table. */
async function nextId(table: string, column: string): Promise<number> {
  const r = await query<{ id: number }>(
    `SELECT ISNULL(MAX(${column}), 0) + 1 AS id FROM ${table}`,
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

export async function listTemplates(): Promise<FormTemplateSummary[]> {
  const r = await query<{
    FormTemplateID: number;
    Name: string;
    Description: string | null;
    IsActive: boolean;
    UpdatedAt: Date | null;
    CurrentVersionID: number | null;
    CurrentVersionNumber: number | null;
    PublishedAt: Date | null;
  }>(
    `SELECT t.FormTemplateID, t.Name, t.Description, t.IsActive, t.UpdatedAt,
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
      ORDER BY t.Name`,
  );

  return r.recordset.map((x) => ({
    formTemplateId: x.FormTemplateID,
    name: x.Name,
    description: x.Description,
    isActive: x.IsActive,
    currentVersionId: x.CurrentVersionID,
    currentVersionNumber: x.CurrentVersionNumber,
    isPublished: x.PublishedAt !== null,
    updatedAt: x.UpdatedAt ? x.UpdatedAt.toISOString() : null,
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
  }>(
    `SELECT FormQuestionID, SortOrder, QuestionKey, Label, HelpText, Placeholder,
            FieldType, IsRequired, OptionsJson, MaxLength, MapsToColumn, IsBuiltIn
       FROM core.FormQuestion
      WHERE FormTemplateVersionID = @id AND IsActive = 1
      ORDER BY SortOrder, FormQuestionID`,
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

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

export async function createTemplate(input: {
  name: string;
  description?: string | null;
  actor: string;
}): Promise<{ formTemplateId: number; versionId: number }> {
  const templateId = await nextId('core.FormTemplate', 'FormTemplateID');

  await query(
    `INSERT INTO core.FormTemplate (FormTemplateID, Name, Description, IsActive, CreatedBy)
     VALUES (@id, @name, @desc, 1, @by)`,
    {
      id: { type: sql.Int, value: templateId },
      name: { type: sql.NVarChar(100), value: input.name },
      desc: { type: sql.NVarChar(500), value: input.description ?? null },
      by: { type: sql.NVarChar(200), value: input.actor },
    },
  );

  // A new template starts as an unpublished v1 carrying the built-in form,
  // so staff edit a working form rather than an empty page.
  const versionId = await insertVersion(
    templateId,
    1,
    input.actor,
    builtInQuestions().map((q, i) => ({ ...q, sortOrder: i + 1 })),
  );

  return { formTemplateId: templateId, versionId };
}

async function insertVersion(
  formTemplateId: number,
  versionNumber: number,
  actor: string,
  questions: DraftQuestion[],
): Promise<number> {
  const versionId = await nextId('core.FormTemplateVersion', 'FormTemplateVersionID');

  await query(
    `INSERT INTO core.FormTemplateVersion (FormTemplateVersionID, FormTemplateID, VersionNumber, CreatedBy)
     VALUES (@id, @tpl, @num, @by)`,
    {
      id: { type: sql.Int, value: versionId },
      tpl: { type: sql.Int, value: formTemplateId },
      num: { type: sql.Int, value: versionNumber },
      by: { type: sql.NVarChar(200), value: actor },
    },
  );

  let questionId = await nextId('core.FormQuestion', 'FormQuestionID');

  for (const q of questions) {
    await query(
      `INSERT INTO core.FormQuestion
              (FormQuestionID, FormTemplateVersionID, SortOrder, QuestionKey, Label, HelpText,
               Placeholder, FieldType, IsRequired, OptionsJson, MaxLength, MapsToColumn, IsBuiltIn)
       VALUES (@id, @ver, @sort, @key, @label, @help, @ph, @type, @req, @opts, @maxLen, @maps, @builtIn)`,
      {
        id: { type: sql.Int, value: questionId },
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
      },
    );
    questionId++;
  }

  return versionId;
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
  actor: string;
}): Promise<number> {
  const next = await query<{ n: number }>(
    `SELECT ISNULL(MAX(VersionNumber), 0) + 1 AS n
       FROM core.FormTemplateVersion WHERE FormTemplateID = @id`,
    { id: { type: sql.Int, value: input.formTemplateId } },
  );

  return insertVersion(input.formTemplateId, next.recordset[0]!.n, input.actor, input.questions);
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

export async function deleteTemplate(formTemplateId: number): Promise<void> {
  await query(
    `DELETE q FROM core.FormQuestion q
       JOIN core.FormTemplateVersion v ON v.FormTemplateVersionID = q.FormTemplateVersionID
      WHERE v.FormTemplateID = @id`,
    { id: { type: sql.Int, value: formTemplateId } },
  );
  await query(
    `DELETE FROM core.FormTemplateVersion WHERE FormTemplateID = @id`,
    { id: { type: sql.Int, value: formTemplateId } },
  );
  await query(`DELETE FROM core.FormTemplate WHERE FormTemplateID = @id`, {
    id: { type: sql.Int, value: formTemplateId },
  });
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
  let answerId = await nextId('core.FormAnswer', 'FormAnswerID');

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

    await query(
      `INSERT INTO core.FormAnswer (FormAnswerID, RegistrationID, FormQuestionID, AnswerText, AnswerJson)
       VALUES (@id, @reg, @q, @text, @json)`,
      {
        id: { type: sql.BigInt, value: answerId },
        reg: { type: sql.Int, value: registrationId },
        q: { type: sql.Int, value: q.formQuestionId },
        text: { type: sql.NVarChar(sql.MAX), value: answerText },
        json: { type: sql.NVarChar(sql.MAX), value: answerJson },
      },
    );
    answerId++;
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
