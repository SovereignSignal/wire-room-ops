/**
 * Intake Service
 *
 * Parses structured scan results (from Grok X-scan prompts or web searches)
 * into normalized ScanEntry records and inserts them into the database.
 *
 * Handles two input formats:
 * 1. Structured text output from our Grok prompts (the ** format)
 * 2. JSON array of results (for programmatic web search intake)
 */

import type {
  PromptVariant,
  ScanSource,
  RawScanResult,
  ScanSubmission,
} from '../types/intake';

// ============================================================
// Text Parser: Structured Grok Output -> RawScanResult[]
// ============================================================

/**
 * Parses the structured output format our Grok prompts produce:
 *
 * **[Program Name]** â [Description]
 * Deadline: [date or "Rolling" or "None listed"]
 * Link: [URL]
 */
export function parseStructuredOutput(text: string): RawScanResult[] {
  const results: RawScanResult[] = [];

  // Split on numbered entries (1. **..., 2. **..., etc.)
  const entryPattern = /\d+\.\s+\*\*(.+?)\*\*\s*[â\-â]\s*(.+?)(?:\n|$)/g;
  const lines = text.split('\n');

  let currentEntry: Partial<RawScanResult> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match entry header: "1. **Program Name** â Description"
    const headerMatch = line.match(
      /^\d+\.\s+\*\*(.+?)\*\*\s*[â\-â]\s*(.+)/
    );
    if (headerMatch) {
      // Save previous entry if exists
      if (currentEntry && currentEntry.name && currentEntry.sourceUrl) {
        results.push(currentEntry as RawScanResult);
      }

      const name = headerMatch[1].trim();
      const description = headerMatch[2].trim();

      // Extract amount from description if present
      const amount = extractAmount(description);

      currentEntry = {
        name,
        description,
        amount,
        deadline: null,
        sourceUrl: '',
      };
      continue;
    }

    // Match deadline line
    const deadlineMatch = line.match(/^Deadline:\s*(.+)/i);
    if (deadlineMatch && currentEntry) {
      const raw = deadlineMatch[1].trim();
      currentEntry.deadline = normalizeDeadline(raw);
      continue;
    }

    // Match link line
    const linkMatch = line.match(/^Link:\s*(https?:\/\/\S+)/i);
    if (linkMatch && currentEntry) {
      currentEntry.sourceUrl = linkMatch[1].trim();
      continue;
    }

    // Match "Total: X results" line (end of output)
    if (line.match(/^Total:\s*\d+\s*results/i)) {
      // Save last entry
      if (currentEntry && currentEntry.name && currentEntry.sourceUrl) {
        results.push(currentEntry as RawScanResult);
      }
      currentEntry = null;
    }
  }

  // Catch trailing entry if no Total line
  if (currentEntry && currentEntry.name && currentEntry.sourceUrl) {
    results.push(currentEntry as RawScanResult);
  }

  return results;
}

/**
 * Extract dollar/currency amounts from a description string.
 * Handles formats like: $50K, $3M, â¬125M, Â£4.5M, â¹500K, $5,000, etc.
 */
export function extractAmount(text: string): string | null {
  // Match currency symbol + number + optional multiplier
  const patterns = [
    // $50,000 or $50K or $3M or $3.5M
    /(\$[\d,]+(?:\.\d+)?(?:\s*[KkMmBb](?:illion)?)?)/,
    // â¬125M or Â£4.5M
    /((?:[â¬Â£â¹]|EUR|GBP|INR)\s*[\d,]+(?:\.\d+)?(?:\s*[KkMmBb](?:illion)?)?)/i,
    // "Up to $X" or "up to â¬X"
    /(up\s+to\s+(?:[\$â¬Â£â¹]|USD|EUR|GBP|INR)\s*[\d,]+(?:\.\d+)?(?:\s*[KkMmBb](?:illion)?)?)/i,
    // "$5,000 to $350,000" ranges
    /([\$â¬Â£â¹][\d,]+(?:\.\d+)?(?:\s*[KkMm])?\s*(?:to|[-â])\s*[\$â¬Â£â¹]?[\d,]+(?:\.\d+)?(?:\s*[KkMm])?)/i,
    // "X million" or "X billion"
    /([\d,]+(?:\.\d+)?\s*(?:million|billion|mil|M|B)\s*(?:dollars|USD|EUR)?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Parse a raw amount string into a numeric USD value and currency code.
 * Returns { numeric, currency } or null if unparseable.
 */
export function parseAmount(
  raw: string | null
): { numeric: number; currency: string } | null {
  if (!raw) return null;

  let currency = 'USD';
  let text = raw.trim();

  // Detect currency
  if (text.match(/[â¬]|EUR/i)) currency = 'EUR';
  else if (text.match(/[Â£]|GBP/i)) currency = 'GBP';
  else if (text.match(/[â¹]|INR/i)) currency = 'INR';
  else if (text.match(/NGN|4b¦/i)) currency = 'NGN';
  else if (text.match(/N\$/)) currency = 'NAD';
  else if (text.match(/SOL/i)) currency = 'SOL';
  else if (text.match(/STX/i)) currency = 'STX';
  else if (text.match(/ENS/i)) currency = 'ENS';
  else if (text.match(/USDT|USDC/i)) currency = 'USD';

  // Strip currency symbols and words
  text = text.replace(/[\$â¬Â£â¹â¦]/g, '');
  text = text.replace(
    /\b(USD|EUR|GBP|INR|NGN|SOL|STX|ENS|USDT|USDC|up\s+to|per\s+award|total|pool|prizes?|credits?|stipend|matching|varies|free)\b/gi,
    ''
  );
  text = text.trim();

  // Handle ranges: take the higher number
  const rangeMatch = text.match(
    /([\d,]+(?:\.\d+)?)\s*[KkMm]?\s*(?:to|[-â])\s*([\d,]+(?:\.\d+)?)\s*([KkMmBb])?/
  );
  if (rangeMatch) {
    text = rangeMatch[2] + (rangeMatch[3] || '');
  }

  // Extract number and multiplier
  const numMatch = text.match(/([\d,]+(?:\.\d+)?)\s*([KkMmBb](?:illion)?)?/);
  if (!numMatch) return null;

  let numeric = parseFloat(numMatch[1].replace(/,/g, ''));
  const multiplier = (numMatch[2] || '').toLowerCase();

  if (multiplier === 'k') numeric *= 1_000;
  else if (multiplier === 'm' || multiplier === 'million' || multiplier === 'mil')
    numeric *= 1_000_000;
  else if (multiplier === 'b' || multiplier === 'billion')
    numeric *= 1_000_000_000;

  // Rough USD conversion for comparison purposes
  const fxRates: Record<string, number> = {
    USD: 1,
    EUR: 1.08,
    GBP: 1.26,
    INR: 0.012,
    NGN: 0.00063,
    NAD: 0.054,
    SOL: 150, // approximate, volatile
    STX: 1.5,
    ENS: 25,
  };

  const rate = fxRates[currency] || 1;
  const usdEquivalent = numeric * rate;

  return { numeric: Math.round(usdEquivalent), currency };
}

/**
 * Normalize deadline strings into consistent format.
 */
function normalizeDeadline(raw: string): string | null {
  const lower = raw.toLowerCase().trim();

  if (
    lower === 'none listed' ||
    lower === 'none' ||
    lower === 'n/a' ||
    lower === 'not specified' ||
    lower === ''
  ) {
    return null;
  }

  if (lower === 'rolling') return 'Rolling';
  if (lower === 'awarded') return null; // Already awarded, no deadline

  // Return the raw string for date parsing downstream
  return raw.trim();
}

/**
 * Try to parse a deadline string into a Date object.
 * Handles formats like "March 8, 2026", "8 March 2026", "2026-03-08", etc.
 */
export function parseDeadline(deadline: string | null): Date | null {
  if (!deadline || deadline === 'Rolling') return null;

  // Try direct parse first
  const d = new Date(deadline);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2024) return d;

  // Try common formats
  // "March 8, 2026" or "Mar 8 2026"
  const monthFirst = deadline.match(
    /(\w+)\s+(\d{1,2}),?\s*(\d{4})/
  );
  if (monthFirst) {
    const attempt = new Date(`${monthFirst[1]} ${monthFirst[2]}, ${monthFirst[3]}`);
    if (!isNaN(attempt.getTime())) return attempt;
  }

  // "8 March 2026"
  const dayFirst = deadline.match(
    /(\d{1,2})\s+(\w+),?\s*(\d{4})/
  );
  if (dayFirst) {
    const attempt = new Date(`${dayFirst[2]} ${dayFirst[1]}, ${dayFirst[3]}`);
    if (!isNaN(attempt.getTime())) return attempt;
  }

  // "Feb 28" (assume current year)
  const monthDay = deadline.match(/(\w+)\s+(\d{1,2})$/);
  if (monthDay) {
    const year = new Date().getFullYear();
    const attempt = new Date(`${monthDay[1]} ${monthDay[2]}, ${year}`);
    if (!isNaN(attempt.getTime())) return attempt;
  }

  return null;
}

// ============================================================
// Submission Builder
// ============================================================

/**
 * Build a ScanSubmission from raw text input and metadata.
 * This is the main entry point for the dashboard paste-in flow.
 */
export function buildSubmission(
  rawText: string,
  wire: string,
  promptVariant: PromptVariant,
  scanDate: string,
  source: ScanSource = 'x-scan'
): ScanSubmission {
  const results = parseStructuredOutput(rawText);

  return {
    wire,
    promptVariant,
    scanDate,
    source,
    results,
  };
}

/**
 * Build multiple submissions from a batch paste (all 3 prompts for a wire).
 * Expects sections labeled like "OSS Prompt A", "OSS Prompt B", etc.
 */
export function buildBatchSubmission(
  rawText: string,
  wire: string,
  scanDate: string,
  source: ScanSource = 'x-scan'
): ScanSubmission[] {
  const submissions: ScanSubmission[] = [];

  // Split on prompt headers
  const sectionPattern =
    /(?:^|\n)(?:#{1,3}\s*)?(?:(?:AI|Crypto|OSS)\s+)?Prompt\s+([ABC])\b/gi;
  const sections: Array<{ variant: PromptVariant; text: string }> = [];

  let lastIndex = 0;
  let lastVariant: PromptVariant | null = null;
  let match;

  // Reset regex
  sectionPattern.lastIndex = 0;

  while ((match = sectionPattern.exec(rawText)) !== null) {
    if (lastVariant !== null) {
      sections.push({
        variant: lastVariant,
        text: rawText.substring(lastIndex, match.index),
      });
    }
    lastVariant = match[1].toUpperCase() as PromptVariant;
    lastIndex = match.index;
  }

  // Capture last section
  if (lastVariant !== null) {
    sections.push({
      variant: lastVariant,
      text: rawText.substring(lastIndex),
    });
  }

  for (const section of sections) {
    const results = parseStructuredOutput(section.text);
    if (results.length > 0) {
      submissions.push({
        wire,
        promptVariant: section.variant,
        scanDate,
        source,
        results,
      });
    }
  }

  return submissions;
}

// ============================================================
// URL Normalization
// ============================================================

/**
 * Normalize a URL for dedup comparison.
 * Strips tracking params, normalizes x.com/twitter.com, lowercases.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);

    // Normalize twitter.com to x.com
    if (u.hostname === 'twitter.com' || u.hostname === 'www.twitter.com') {
      u.hostname = 'x.com';
    }
    if (u.hostname === 'www.x.com') {
      u.hostname = 'x.com';
    }

    // Remove common tracking params
    const trackingParams = [
      's',
      't',
      'ref',
      'ref_src',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
      'fbclid',
      'gclid',
    ];
    for (const param of trackingParams) {
      u.searchParams.delete(param);
    }

    // Remove trailing slashes
    let normalized = u.toString().replace(/\/+$/, '');

    return normalized.toLowerCase();
  } catch {
    // If URL parsing fails, just lowercase and trim
    return url.toLowerCase().trim();
  }
}

// ============================================================
// Name Normalization (for fuzzy matching)
// ============================================================

// Common words to strip for name comparison
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'of',
  'in',
  'to',
  'by',
  'with',
  'on',
  'at',
  'from',
  'program',
  'programme',
  'grant',
  'grants',
  'fund',
  'funding',
  'initiative',
  'fellowship',
  'hackathon',
  'bounty',
  'challenge',
  'competition',
  'scholarship',
  'accelerator',
  'incubator',
  'cohort',
  'season',
  'phase',
  'round',
  'wave',
  'new',
  '2025',
  '2026',
  '2027',
]);

/**
 * Normalize a program name for fuzzy matching.
 * Strips common words, lowercases, removes special characters.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .sort()
    .join(' ')
    .trim();
}

/**
 * Extract significant tokens from a name for GIN index matching.
 */
export function extractNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}
