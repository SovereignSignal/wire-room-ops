import { classifySourceLink } from './source-filter';

/**
 * Pre-approval validation guard.
 * Catches data-quality issues before an entry is approved for publication.
 */

export interface ApprovalValidation {
  valid: boolean;
  errors: string[];   // blocking issues
  warnings: string[]; // non-blocking but flagged
}

export function validateForApproval(entry: {
  id: number;
  name: string;
  description: string | null;
  source_url: string;
  classification: string | null;
  quality_score: number | null;
  deadline: string | null;
}): ApprovalValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Blocking errors ---

  if (!entry.description || entry.description.trim().length < 10) {
    errors.push('Missing or empty description');
  }

  if (!entry.source_url || entry.source_url.trim() === '') {
    errors.push('Missing source URL');
  } else {
    const url = entry.source_url.trim();
    const sourceClass = classifySourceLink(url);
    if (sourceClass === 'placeholder') {
      errors.push('Source URL is an internal placeholder — no real source link was submitted');
    } else if (sourceClass === 'invalid') {
      errors.push('Source URL is invalid — use an HTTP or HTTPS source');
    } else if (sourceClass === 'shortener') {
      errors.push('Source URL is an unresolved shortener — resolve to the real page first');
    } else if (sourceClass === 'tweet-only') {
      warnings.push('Source is a tweet link only — consider finding the primary program page before publishing');
    }
  }

  // --- Non-blocking warnings ---

  if (entry.classification === 'EXPIRED') {
    warnings.push('Entry classified as EXPIRED — verify before publishing');
  }

  if (entry.name && entry.name.length > 120) {
    warnings.push('Name exceeds 120 characters (possible parser leakage)');
  }

  if (entry.deadline) {
    if (entry.deadline.includes(';') || entry.deadline.includes(')') || entry.deadline.length > 50) {
      warnings.push('Deadline field may contain junk data');
    }
  }

  if (!entry.classification || entry.classification === 'UNCHECKED') {
    warnings.push('Entry has not been classified');
  }

  if (entry.quality_score === null || entry.quality_score === 0) {
    warnings.push('Entry has no quality score');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
