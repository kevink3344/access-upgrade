import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, sql, type SqlParam } from '../db.js';
import { env } from '../env.js';
import { checkWorkshopCapacity } from '../services/notifications.js';
import { getVersionForLink, saveAnswers, getKindForLink, createTrainingRequestFromAnswers, saveTrainingRequestAnswers } from '../services/forms.js';

/**
 * Public registration endpoints. Mounted at /api/public.
 *
 * No authentication — the link slug is the access control. Every route is
 * rate-limited and every submission is logged to audit.PublicSubmission
 * before business logic runs, so abuse is visible even when rejected.
 */
export const publicRouter = Router();

/* ------------------------------------------------------------------ */
/*  Rate limiting (in-memory; single instance)                         */
/* ------------------------------------------------------------------ */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);

  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (b.count >= max) return false;
  b.count++;
  return true;
}

// Occasionally drop expired buckets so the map does not grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

function hashIp(ip: string): Buffer {
  return crypto.createHash('sha256').update(`${env.JWT_SECRET}:${ip}`).digest();
}

function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/* ------------------------------------------------------------------ */
/*  Link resolution                                                    */
/* ------------------------------------------------------------------ */

type LinkState = 'open' | 'closed' | 'not-yet-open' | 'revoked' | 'full';

interface ResolvedLink {
  RegistrationLinkID: number;
  /** Null for a standalone form link (a training request, say). */
  WorkshopID: number | null;
  FormTemplateID: number | null;
  IsActive: boolean;
  WebSeatCap: number | null;
  OpensAt: Date | null;
  ClosesAt: Date | null;
  RevokedAt: Date | null;
  IsRegistrationOpen: boolean | null;
  IsCancelled: boolean | null;
  RedirectToPayment: boolean;
  PaymentUrl: string | null;
  WorkshopCode: string | null;
  WorkshopName: string | null;
  StartDate: Date | null;
  EndDate: Date | null;
  StartTime: string | null;
  EndTime: string | null;
  Room: number | null;
  Cost1: number | null;
  CreditPossible: string | null;
  SessionCeus: number | null;
  AgencyName: string | null;
  MaxEnrollment: number | null;
  ActiveRegs: number;
  WebTaken: number;
}

async function resolveSlug(slug: string): Promise<ResolvedLink | null> {
  // LEFT JOIN the workshop: a standalone form link has none, and an INNER
  // JOIN would make it look like the slug does not exist.
  const r = await query<ResolvedLink>(
    `SELECT l.RegistrationLinkID, l.WorkshopID, l.FormTemplateID,
            l.IsActive, l.WebSeatCap, l.OpensAt, l.ClosesAt, l.RevokedAt,
            l.RedirectToPayment, l.PaymentUrl,
            w.IsRegistrationOpen, w.IsCancelled,
            w.WorkshopCode, n.WorkshopName, w.StartDate, w.EndDate,
            CONVERT(NVARCHAR(5), w.StartTime, 108) AS StartTime,
            CONVERT(NVARCHAR(5), w.EndTime, 108)   AS EndTime,
            w.Room, w.Cost1, w.CreditPossible, w.SessionCeus, w.MaxEnrollment,
            a.AgencyName,
            (SELECT COUNT(*) FROM core.Registration r
              WHERE r.WorkshopID = w.WorkshopID AND r.IsCancelled = 0) AS ActiveRegs,
            (SELECT COUNT(*) FROM core.Registration r
              WHERE r.WorkshopID = w.WorkshopID AND r.Source = 'Web' AND r.IsCancelled = 0) AS WebTaken
       FROM core.WorkshopRegistrationLink l
       LEFT JOIN core.Workshop w ON w.WorkshopID = l.WorkshopID
       LEFT JOIN core.WorkshopName n ON n.WorkshopNameID = w.WorkshopNameID
       LEFT JOIN core.Agency a ON a.AgencyID = w.AgencyID
      WHERE l.Slug = @slug`,
    { slug: { type: sql.NVarChar(24), value: slug } },
  );
  return r.recordset[0] ?? null;
}

function linkState(l: ResolvedLink): LinkState {
  if (l.RevokedAt !== null) return 'revoked';
  if (!l.IsActive) return 'revoked';

  // A standalone form link has no workshop, so there is nothing to close,
  // cancel or fill up — the link's own switch is the whole story.
  if (l.WorkshopID === null) {
    const now = new Date();
    if (l.OpensAt && now < l.OpensAt) return 'not-yet-open';
    if (l.ClosesAt && now > l.ClosesAt) return 'closed';
    return 'open';
  }

  if (!l.IsRegistrationOpen || l.IsCancelled) return 'closed';

  const now = new Date();
  if (l.OpensAt && now < l.OpensAt) return 'not-yet-open';
  if (l.ClosesAt && now > l.ClosesAt) return 'closed';

  // Full means the workshop's own capacity is reached, not just the web cap.
  const left = seatsRemaining(l);
  if (left !== null && left <= 0) return 'full';

  return 'open';
}

/**
 * Seats left, from the real roster rather than a coarse band.
 *
 * Capacity is the workshop's own MaxEnrollment. The link's WebSeatCap, when
 * set, caps only the online share, so the effective limit is the smaller of
 * the two. A null MaxEnrollment means the workshop has no stated limit.
 *
 * Returns null when the workshop is uncapped, so the UI can omit the line
 * rather than invent a number.
 */
function seatsRemaining(l: ResolvedLink): number | null {
  // ActiveRegs already counts every non-cancelled registration, web included,
  // so it must not be added to WebTaken.
  const byWorkshop = l.MaxEnrollment === null ? null : l.MaxEnrollment - l.ActiveRegs;
  const byWeb = l.WebSeatCap === null ? null : l.WebSeatCap - l.WebTaken;

  if (byWorkshop === null && byWeb === null) return null;
  if (byWorkshop === null) return Math.max(0, byWeb!);
  if (byWeb === null) return Math.max(0, byWorkshop);
  return Math.max(0, Math.min(byWorkshop, byWeb));
}

/** One session as the public form sees it. */
export interface PublicSessionOption {
  workshopSessionId: number;
  /** The value stored as the answer, e.g. "10:00 AM – 11:00 AM". */
  label: string;
  startTime: string | null;
  endTime: string | null;
}

/**
 * The workshop's sessions, formatted for a `session` form question.
 *
 * The label is what gets stored as the answer, so it must be readable on its
 * own years later — a bare session id would be meaningless once the row is
 * edited or deleted. Sessions with no time are skipped: there is nothing to
 * choose between them and they would all read the same.
 */
async function listSessionsForPublic(workshopId: number): Promise<PublicSessionOption[]> {
  const r = await query<{
    WorkshopSessionID: number;
    SessionDate: Date | null;
    StartTime: string | null;
    EndTime: string | null;
  }>(
    `SELECT WorkshopSessionID, SessionDate,
            CONVERT(NVARCHAR(5), StartTime, 108) AS StartTime,
            CONVERT(NVARCHAR(5), EndTime, 108)   AS EndTime
       FROM core.WorkshopSession
      WHERE WorkshopID = @id AND StartTime IS NOT NULL
      ORDER BY SessionDate, StartTime`,
    { id: { type: sql.Int, value: workshopId } },
  );

  return r.recordset.map((s) => {
    const start = fmtTimeForPublic(s.StartTime);
    const end = fmtTimeForPublic(s.EndTime);
    return {
      workshopSessionId: s.WorkshopSessionID,
      label: end ? `${start} – ${end}` : start,
      startTime: s.StartTime,
      endTime: s.EndTime,
    };
  });
}

/** "13:00" -> "1:00 PM". Matches how the page renders the workshop's own time. */
function fmtTimeForPublic(time: string | null): string {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const suffix = (h ?? 0) >= 12 ? 'PM' : 'AM';
  const hour = (h ?? 0) % 12 || 12;
  return `${hour}:${String(m ?? 0).padStart(2, '0')} ${suffix}`;
}

async function logSubmission(
  linkId: number | null,
  ip: string,
  userAgent: string | null,
  outcome: string,
  reason: string | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit.PublicSubmission (RegistrationLinkID, IpHash, UserAgent, Outcome, Reason)
       VALUES (@lid, @ip, @ua, @outcome, @reason)`,
      {
        lid: { type: sql.Int, value: linkId },
        ip: { type: sql.VarBinary(32), value: hashIp(ip) },
        ua: { type: sql.NVarChar(400), value: userAgent?.slice(0, 400) ?? null },
        outcome: { type: sql.NVarChar(30), value: outcome },
        reason: { type: sql.NVarChar(200), value: reason },
      },
    );
  } catch (err) {
    console.error('[public] could not log submission:', (err as Error).message);
  }
}

/* ------------------------------------------------------------------ */
/*  Endpoints                                                          */
/* ------------------------------------------------------------------ */

/**
 * @openapi
 * /api/public/registration-links/{slug}:
 *   get:
 *     tags: [Public registration]
 *     summary: Resolve a shared link
 *     description: >
 *       Returns the workshop summary and whether registration is open.
 *       Terminal states are reported honestly — a closed workshop says so
 *       rather than returning 404, so someone who saved the link gets a
 *       clear answer.
 *     security: []
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Link state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 state:
 *                   type: string
 *                   enum: [open, closed, not-yet-open, revoked, full]
 *                 seatsRemaining:
 *                   type: integer
 *                   nullable: true
 *                   description: >
 *                     Seats left for this workshop, from the live roster.
 *                     Null when the workshop has no stated capacity.
 *                   example: 7
 *                 workshop:
 *                   type: object
 *                   properties:
 *                     title: { type: string, nullable: true }
 *                     code: { type: string, nullable: true }
 *                     startDate: { type: string, nullable: true }
 *                     endDate: { type: string, nullable: true }
 *                     startTime: { type: string, nullable: true }
 *                     endTime: { type: string, nullable: true }
 *                     location: { type: string, nullable: true }
 *                     cost: { type: number, nullable: true }
 *                     credit: { type: string, nullable: true }
 *       404: { description: Unknown slug }
 */
publicRouter.get('/registration-links/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const ip = clientIp(req);

    if (!rateLimit(`link:${ip}`, 60, 60 * 60_000)) {
      res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
      return;
    }

    const link = await resolveSlug(slug);

    if (!link) {
      res.status(404).json({ error: 'not_found', message: 'This link is not valid.' });
      return;
    }

    const state = linkState(link);

    // The pinned form version, if this link uses one. Null means the link
    // falls back to the built-in form the page has always rendered.
    const form = await getVersionForLink(link.RegistrationLinkID);

    // A `session` question renders the workshop's own sessions, so they are
    // sent only when the pinned form actually asks for one. Sessions are
    // descriptive — this does not change what the registration records
    // beyond the answer text.
    const wantsSessions = form?.questions.some((q) => q.fieldType === 'session') ?? false;
    const sessions =
      wantsSessions && link.WorkshopID !== null
        ? await listSessionsForPublic(link.WorkshopID)
        : [];

    res.json({
      state,
      kind: await getKindForLink(link.RegistrationLinkID),
      seatsRemaining: seatsRemaining(link),
      form,
      sessions,
      opensAt: link.OpensAt?.toISOString() ?? null,
      // Sent to the browser so the confirmation screen can forward the
      // registrant to payment. Only exposed while the link is actually open.
      redirectToPayment: link.RedirectToPayment,
      paymentUrl: link.PaymentUrl,
      workshop: {
        title: link.WorkshopName,
        code: link.WorkshopCode,
        startDate: link.StartDate?.toISOString().slice(0, 10) ?? null,
        endDate: link.EndDate?.toISOString().slice(0, 10) ?? null,
        startTime: link.StartTime,
        endTime: link.EndTime,
        room: link.Room,
        location: link.AgencyName,
        cost: link.Cost1,
        credit: link.CreditPossible,
        ceus: link.SessionCeus === null ? null : Math.round(link.SessionCeus * 100) / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

const registerSchema = z.object({
  // Required for a registration form; a training request form asks for its own
  // fields instead, so these are only enforced when the kind calls for them.
  firstName: z.string().max(30).optional(),
  lastName: z.string().max(30).optional(),
  email: z.string().max(100).optional(),
  registrantRole: z.enum(['Educator', 'Parent/caregiver']).optional(),
  phone: z.string().max(15).optional(),
  agencyId: z.number().int().positive().nullable().optional(),
  /** Educator only: ages of the students in the class. */
  classAges: z.string().max(255).optional(),
  /** Parent/caregiver only: ages of their children. */
  childrenAges: z.string().max(255).optional(),
  /** Parent/caregiver only: free text for a second caregiver. */
  secondCaregiverInfo: z.string().max(2000).optional(),
  paymentMethod: z.string().max(50).optional(),
  notes: z.string().max(255).optional(),
  /** Honeypot — must be empty. */
  website: z.string().optional(),
  /** Milliseconds the form was on screen. */
  elapsedMs: z.number().optional(),
  /** Custom answers keyed by QuestionKey, for links pinned to a form version. */
  answers: z.record(z.string(), z.unknown()).optional(),
});

/**
 * @openapi
 * /api/public/registration-links/{slug}/register:
 *   post:
 *     tags: [Public registration]
 *     summary: Register for a workshop
 *     description: >
 *       Creates or reuses a participant by email, then records a
 *       registration with Source = 'Web'. Re-submitting the same email for
 *       the same workshop updates rather than duplicates, and returns the
 *       same success response either way so the form does not leak whether
 *       an address is already registered.
 *     security: []
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [firstName, lastName, email, registrantRole]
 *             properties:
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               email: { type: string, format: email }
 *               registrantRole:
 *                 type: string
 *                 enum: [Educator, Parent/caregiver]
 *                 description: >
 *                   Who the registrant is. Sets the participant's mailing-list
 *                   flag; it never clears the other one.
 *               phone: { type: string }
 *               agencyId: { type: integer, nullable: true }
 *               classAges:
 *                 type: string
 *                 description: Educator only — ages of the students in the class.
 *               childrenAges:
 *                 type: string
 *                 description: Parent/caregiver only — ages of the registrant's children.
 *               secondCaregiverInfo:
 *                 type: string
 *                 description: Parent/caregiver only — details for a second caregiver.
 *               paymentMethod: { type: string }
 *               notes: { type: string }
 *               website: { type: string, description: Honeypot — leave empty }
 *               elapsedMs: { type: number }
 *     responses:
 *       201: { description: Registered }
 *       409: { description: Registration closed or full }
 *       422: { description: Validation failed }
 *       429: { description: Rate limited }
 */
publicRouter.post('/registration-links/:slug/register', async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const ip = clientIp(req);
    const ua = req.get('user-agent') ?? null;

    // Three rate limits, checked before anything else.
    if (!rateLimit(`submit:${ip}`, 10, 60 * 60_000)) {
      await logSubmission(null, ip, ua, 'RateLimited', 'per-ip');
      res.status(429).json({ error: 'rate_limited', message: 'Too many submissions. Try again later.' });
      return;
    }

    const link = await resolveSlug(slug);

    if (!link) {
      res.status(404).json({ error: 'not_found', message: 'This link is not valid.' });
      return;
    }

    if (!rateLimit(`link:${link.RegistrationLinkID}`, 200, 60 * 60_000)) {
      await logSubmission(link.RegistrationLinkID, ip, ua, 'RateLimited', 'per-link');
      res.status(429).json({ error: 'rate_limited', message: 'Too many submissions. Try again later.' });
      return;
    }

    const parsed = registerSchema.safeParse(req.body);

    if (!parsed.success) {
      await logSubmission(link.RegistrationLinkID, ip, ua, 'Rejected', 'validation');
      res.status(422).json({
        error: 'validation_failed',
        message: 'Please check the form',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const data = parsed.data;

    // A training request form has no registrant to identify, so the email
    // rate-limit bucket and the registration fields below only apply to the
    // registration kind.
    const formKind = await getKindForLink(link.RegistrationLinkID);

    if (formKind === 'registration') {
      const missingReg: string[] = [];
      if (!data.firstName?.trim()) missingReg.push('firstName');
      if (!data.lastName?.trim()) missingReg.push('lastName');
      if (!data.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) {
        missingReg.push('email');
      }
      if (!data.registrantRole) missingReg.push('registrantRole');

      if (missingReg.length > 0) {
        await logSubmission(link.RegistrationLinkID, ip, ua, 'Rejected', 'validation');
        res.status(422).json({
          error: 'validation_failed',
          message: 'Please check the form',
          details: missingReg.map((path) => ({ path, message: 'This field is required' })),
        });
        return;
      }
    }

    const email = data.email?.trim().toLowerCase() ?? '';

    // Honeypot: a real person never fills a hidden field.
    if (data.website && data.website.trim() !== '') {
      await logSubmission(link.RegistrationLinkID, ip, ua, 'Honeypot', null);
      res.status(422).json({ error: 'rejected', message: 'Submission rejected.' });
      return;
    }

    // Timing check: humans take more than 3 seconds.
    if (typeof data.elapsedMs === 'number' && data.elapsedMs < 3000) {
      await logSubmission(link.RegistrationLinkID, ip, ua, 'Rejected', 'too-fast');
      res.status(422).json({ error: 'rejected', message: 'Submission rejected.' });
      return;
    }

    if (!rateLimit(`email:${email}`, 5, 60 * 60_000)) {
      await logSubmission(link.RegistrationLinkID, ip, ua, 'RateLimited', 'per-email');
      res.status(429).json({ error: 'rate_limited', message: 'Too many submissions. Try again later.' });
      return;
    }

    const state = linkState(link);

    if (state !== 'open') {
      await logSubmission(link.RegistrationLinkID, ip, ua, 'Rejected', `state:${state}`);
      res.status(409).json({
        error: 'registration_closed',
        message:
          state === 'full'
            ? 'This workshop is full.'
            : state === 'not-yet-open'
              ? 'Registration has not opened yet.'
              : 'Registration is closed for this workshop.',
      });
      return;
    }

    // ---- custom questions: validate against the pinned version ----
    // The form the registrant saw is the only one their answers can be judged
    // against. A required question that is blank is a hard error here, not
    // just in the browser.
    const formVersion = await getVersionForLink(link.RegistrationLinkID);

    if (formVersion) {
      const supplied = data.answers ?? {};
      const missing: string[] = [];

      for (const q of formVersion.questions) {
        if (!q.isRequired || q.mapsToColumn) continue; // built-ins validated below
        // A branched question that is not visible is not required.
        if (q.branchOnQuestionKey) {
          const gate = supplied[q.branchOnQuestionKey];
          if (typeof gate !== 'string' || gate !== q.branchOptionValue) continue;
        }
        const v = supplied[q.questionKey];
        const blank =
          v === undefined ||
          v === null ||
          (typeof v === 'string' && v.trim() === '') ||
          (Array.isArray(v) && v.length === 0);
        if (blank) missing.push(q.label);
      }

      if (missing.length > 0) {
        await logSubmission(link.RegistrationLinkID, ip, ua, 'Rejected', 'missing-required');
        res.status(422).json({
          error: 'validation_failed',
          message: `Please answer: ${missing.join(', ')}`,
          fields: missing,
        });
        return;
      }
    }

    // ---- branch on where this form stores its submissions ----
    // A training request form is not a workshop registration: it writes a
    // core.TrainingRequest row and stops, so it never touches Participant or
    // Registration and never consumes a seat.
    if (formKind === 'trainingRequest') {
      const trainingRequestId = await createTrainingRequestFromAnswers(
        data.answers ?? {},
        formVersion ?? undefined,
      );
      // Keep every answer, not just the five that map to columns, so the
      // request's Form answers tab shows what the agency actually submitted.
      if (formVersion) {
        await saveTrainingRequestAnswers(trainingRequestId, formVersion, data.answers ?? {});
      }
      await logSubmission(link.RegistrationLinkID, ip, ua, 'Accepted', 'training-request');

      res.status(201).json({
        registered: true,
        trainingRequestId,
        message: 'Your training request has been submitted. We will be in touch.',
      });
      return;
    }

    // ---- participant: match on email, else create ----
    const existing = await query<{ ParticipantID: number }>(
      `SELECT TOP 1 ParticipantID FROM core.Participant
        WHERE LOWER(Email) = @email
        ORDER BY ParticipantID`,
      { email: { type: sql.NVarChar(100), value: email } },
    );

    const isEducator = data.registrantRole === 'Educator';

    // Only the questions the chosen role actually asked are stored, so a
    // stale or crafted field for the other branch cannot leak into the record.
    const classAges = isEducator ? (data.classAges?.trim() || null) : null;
    const childrenAges = isEducator ? null : (data.childrenAges?.trim() || null);
    const secondCaregiverInfo = isEducator ? null : (data.secondCaregiverInfo?.trim() || null);

    let participantId: number;

    if (existing.recordset[0]) {
      participantId = existing.recordset[0].ParticipantID;

      // Add the audience flag without ever clearing the other one: a person
      // can be on both lists, and a returning registrant answering the form
      // differently must not lose their earlier opt-in. Role answers are only
      // written when supplied, so a blank field never erases an earlier answer.
      await query(
        `UPDATE core.Participant
            SET ${isEducator ? 'IsTeacherMailingList' : 'IsParentMailingList'} = 1,
                GradeLevel          = COALESCE(@classAges, GradeLevel),
                ChildrenAges        = COALESCE(@childrenAges, ChildrenAges),
                SecondCaregiverInfo = COALESCE(@secondCaregiver, SecondCaregiverInfo),
                UpdatedAt = SYSUTCDATETIME()
          WHERE ParticipantID = @id`,
        {
          id: { type: sql.Int, value: participantId },
          classAges: { type: sql.NVarChar(255), value: classAges },
          childrenAges: { type: sql.NVarChar(255), value: childrenAges },
          secondCaregiver: { type: sql.NVarChar(sql.MAX), value: secondCaregiverInfo },
        },
      );
    } else {
      const created = await query<{ ParticipantID: number }>(
        // ParticipantID is IDENTITY (migration 025): the database allocates
        // it, so the id is omitted.
        `INSERT INTO core.Participant
                (FirstName, LastName, Email, HomePhone, AgencyID, GradeLevel,
                 ChildrenAges, SecondCaregiverInfo,
                 IsTeacherMailingList, IsParentMailingList, DateOfEntry)
         OUTPUT INSERTED.ParticipantID
         VALUES (@fn, @ln, @email, @phone, @agency, @classAges,
                 @childrenAges, @secondCaregiver,
                 @teacher, @parent, SYSUTCDATETIME())`,
        {
          fn: { type: sql.NVarChar(30), value: data.firstName!.trim() },
          ln: { type: sql.NVarChar(30), value: data.lastName!.trim() },
          email: { type: sql.NVarChar(100), value: email },
          phone: { type: sql.NVarChar(15), value: data.phone ?? null },
          agency: { type: sql.Int, value: data.agencyId ?? null },
          classAges: { type: sql.NVarChar(255), value: classAges },
          childrenAges: { type: sql.NVarChar(255), value: childrenAges },
          secondCaregiver: { type: sql.NVarChar(sql.MAX), value: secondCaregiverInfo },
          teacher: { type: sql.Bit, value: isEducator ? 1 : 0 },
          parent: { type: sql.Bit, value: isEducator ? 0 : 1 },
        },
      );
      participantId = created.recordset[0]!.ParticipantID;
    }

    // ---- registration: update rather than duplicate ----
    const dupe = await query<{ RegistrationID: number }>(
      `SELECT TOP 1 RegistrationID FROM core.Registration
        WHERE ParticipantID = @pid AND WorkshopID = @wid AND IsCancelled = 0`,
      {
        pid: { type: sql.Int, value: participantId },
        wid: { type: sql.Int, value: link.WorkshopID },
      },
    );

    const token = crypto.randomUUID();
    let registrationId: number;

    if (dupe.recordset[0]) {
      registrationId = dupe.recordset[0].RegistrationID;
      await query(
        `UPDATE core.Registration
            SET RegistrationLinkID = @lid, ConfirmationToken = @token, UpdatedAt = SYSUTCDATETIME()
          WHERE RegistrationID = @id`,
        {
          id: { type: sql.Int, value: registrationId },
          lid: { type: sql.Int, value: link.RegistrationLinkID },
          token: { type: sql.UniqueIdentifier, value: token },
        },
      );
      await logSubmission(link.RegistrationLinkID, ip, ua, 'Duplicate', null);
    } else {
      const params: Record<string, SqlParam> = {
        pid: { type: sql.Int, value: participantId },
        wid: { type: sql.Int, value: link.WorkshopID },
        lid: { type: sql.Int, value: link.RegistrationLinkID },
        token: { type: sql.UniqueIdentifier, value: token },
        notes: { type: sql.NVarChar(255), value: data.notes ?? null },
      };

      const created = await query<{ RegistrationID: number }>(
        // RegistrationID is IDENTITY (migration 025): omit it.
        `INSERT INTO core.Registration
                (ParticipantID, WorkshopID, RegistrationDate, IsCancelled,
                 Attended, EmailConfirmation, Source, RegistrationLinkID, ConfirmationToken, Notes)
         OUTPUT INSERTED.RegistrationID
         VALUES (@pid, @wid, CAST(SYSUTCDATETIME() AS DATE), 0, 0, 0, 'Web', @lid, @token, @notes)`,
        params,
      );
      registrationId = created.recordset[0]!.RegistrationID;
      await logSubmission(link.RegistrationLinkID, ip, ua, 'Accepted', null);

      // Raise the capacity alert if this registration crossed the threshold.
      // Safe to call on a duplicate submission too: the fired flag makes it
      // a no-op once the alert has gone out.
      await checkWorkshopCapacity(link.WorkshopID!);
    }

    // Custom answers. Written after the registration exists so the FK holds,
    // and only for questions on the pinned version — saveAnswers drops any
    // key the registrant was never shown.
    if (formVersion && data.answers && Object.keys(data.answers).length > 0) {
      await saveAnswers(registrationId, formVersion, data.answers);
    }

    // Identical response for new and duplicate submissions — the form must
    // not leak whether an address was already registered.
    res.status(201).json({
      registered: true,
      registrationId,
      confirmationToken: token,
      message: "You're registered. Check your email for confirmation.",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/public/agencies:
 *   get:
 *     tags: [Public registration]
 *     summary: Agency picker for the public form
 *     description: Search only — the public form cannot create agencies.
 *     security: []
 *     parameters:
 *       - { in: query, name: q, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Matching agencies
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       label: { type: string }
 */
publicRouter.get('/agencies', async (req, res, next) => {
  try {
    const ip = clientIp(req);
    if (!rateLimit(`agencies:${ip}`, 120, 60 * 60_000)) {
      res.status(429).json({ error: 'rate_limited', message: 'Too many requests.' });
      return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (q.length < 2) {
      res.json({ data: [] });
      return;
    }

    const r = await query<{ id: number; label: string }>(
      `SELECT TOP 20 AgencyID AS id, AgencyName AS label
         FROM core.Agency
        WHERE IsOutOfBusiness = 0 AND AgencyName LIKE @q
        ORDER BY AgencyName`,
      { q: { type: sql.NVarChar(260), value: `%${q}%` } },
    );

    res.json({ data: r.recordset });
  } catch (err) {
    next(err);
  }
});
