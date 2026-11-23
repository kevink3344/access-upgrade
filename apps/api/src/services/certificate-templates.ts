/**
 * Decisions about certificate templates that do not need a database.
 *
 * Kept separate so the rules that govern "several templates per year and
 * type" can be unit-tested without a live SQL Server — the case that matters
 * most (a second template of the same type is allowed) is otherwise only
 * provable by running the migration.
 */

export type CertificateTypeName = 'CEU' | 'CHC';

/**
 * The name a new template gets.
 *
 * Staff can name it themselves; that wins. Otherwise it is numbered from the
 * count already present, so several unnamed templates are still
 * distinguishable in the picker rather than all reading "CEU".
 */
export function deriveTemplateName(
  supplied: string | null | undefined,
  certificateType: CertificateTypeName,
  existingCount: number,
): string {
  const trimmed = supplied?.trim();
  if (trimmed) return trimmed;
  return `${certificateType} ${existingCount + 1}`;
}

/**
 * Which template a certificate should print from.
 *
 * An explicit id wins. Otherwise the *oldest* template for the year and type
 * is used — the one that existed before a year could hold several — so
 * issuing behaves exactly as it did before multiple templates were allowed.
 *
 * Returns null when an explicit id was asked for but is not among the
 * candidates, which is a mismatch the caller must not silently paper over by
 * falling back to a different template.
 */
export function pickTemplate<T extends { CertificateTemplateID: number }>(
  candidates: T[],
  requestedId: number | null | undefined,
): T | null {
  if (requestedId !== null && requestedId !== undefined) {
    return candidates.find((c) => c.CertificateTemplateID === requestedId) ?? null;
  }

  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.CertificateTemplateID - b.CertificateTemplateID)[0]!;
}
