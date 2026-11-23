import { describe, expect, it } from 'vitest';
import { deriveTemplateName, pickTemplate } from '../src/services/certificate-templates.js';

/**
 * The rules behind "several certificate templates per school year".
 *
 * Pure, so they run without a database — which matters because the bug this
 * replaced (a year could hold only one CEU and one CHC) was only observable
 * by attempting a second insert.
 */

describe('deriveTemplateName', () => {
  it('uses the name staff supplied', () => {
    expect(deriveTemplateName('Director certificate', 'CEU', 2)).toBe('Director certificate');
  });

  it('trims surrounding whitespace', () => {
    expect(deriveTemplateName('  Teacher certificate  ', 'CHC', 0)).toBe('Teacher certificate');
  });

  it('numbers an unnamed template from the count already present', () => {
    expect(deriveTemplateName(null, 'CEU', 0)).toBe('CEU 1');
    expect(deriveTemplateName(null, 'CEU', 1)).toBe('CEU 2');
    expect(deriveTemplateName(undefined, 'CHC', 3)).toBe('CHC 4');
  });

  it('treats a blank name as unnamed rather than storing whitespace', () => {
    expect(deriveTemplateName('   ', 'CEU', 0)).toBe('CEU 1');
    expect(deriveTemplateName('', 'CEU', 1)).toBe('CEU 2');
  });

  it('never returns the same name for consecutive unnamed templates', () => {
    const first = deriveTemplateName(null, 'CEU', 0);
    const second = deriveTemplateName(null, 'CEU', 1);
    expect(first).not.toBe(second);
  });
});

describe('pickTemplate', () => {
  const templates = [
    { CertificateTemplateID: 30, Name: 'newest' },
    { CertificateTemplateID: 10, Name: 'oldest' },
    { CertificateTemplateID: 20, Name: 'middle' },
  ];

  it('uses the explicit id when one is asked for', () => {
    expect(pickTemplate(templates, 20)?.Name).toBe('middle');
    expect(pickTemplate(templates, 30)?.Name).toBe('newest');
  });

  it('falls back to the oldest template when no id is given', () => {
    // The oldest is the one that existed before a year could hold several,
    // so issuing keeps behaving as it did.
    expect(pickTemplate(templates, null)?.Name).toBe('oldest');
    expect(pickTemplate(templates, undefined)?.Name).toBe('oldest');
  });

  it('does not depend on the order rows came back in', () => {
    const shuffled = [templates[1]!, templates[2]!, templates[0]!];
    expect(pickTemplate(shuffled, null)?.Name).toBe('oldest');
  });

  it('returns null when an explicit id is not among the candidates', () => {
    // Falling back to a different template here would print the wrong
    // certificate, so a mismatch must surface rather than be papered over.
    expect(pickTemplate(templates, 999)).toBeNull();
  });

  it('returns null when the year has no templates at all', () => {
    expect(pickTemplate([], null)).toBeNull();
  });

  it('handles a single template, which is the pre-migration case', () => {
    expect(pickTemplate([{ CertificateTemplateID: 7 }], null)?.CertificateTemplateID).toBe(7);
    expect(pickTemplate([{ CertificateTemplateID: 7 }], 7)?.CertificateTemplateID).toBe(7);
  });
});
