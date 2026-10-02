/**
 * Summary output guard — rejects model output that is reasoning or draft notes
 * rather than a finished summary.
 *
 * Reasoning models on Ollama Cloud (gpt-oss, glm) return their chain of thought
 * in `message.thinking` / `message.reasoning`. When the token budget runs out
 * before the answer, `content` is empty or a fragment, and any code that falls
 * back to the reasoning text stores lines like "We need to produce a concise
 * opportunity summary... Must be 2-4 sentences". The same detector drives the
 * write-time guard and the backfill, so both agree on what counts as leaked.
 */

export interface SummaryLeakMatch {
  rule: string;
  excerpt: string;
}

const START_RULES: Array<[string, RegExp]> = [
  ['starts-we-need', /^(?:we|i)\s+(?:need|must|should|have|will|want|can)\b/i],
  // "Now accepting..." and "First cohort..." are real ledes, so only pure fillers here.
  ['starts-filler', /^(?:okay|ok|alright|hmm+|let me|let's)\b[\s,.:]/i],
  ['starts-the-user', /^the\s+(?:user|prompt|task|instructions?)\b/i],
  ['starts-field-question', /^[a-z][a-z /-]{1,40}\?/],
];

const ANYWHERE_RULES: Array<[string, RegExp]> = [
  ['we-need-to-write', /\b(?:we|i)\s+(?:need|have|must|should|want)\s+to\s+(?:produce|write|craft|create|generate|draft|output|summari[sz]e|provide|include|lead|mention|make|keep|ensure|avoid|count|check|add|start|respond|answer)\b/i],
  ['sentence-count-instruction', /\b(?:must be|should be|in|exactly|write)?\s*\d+\s*(?:-|–|to)\s*\d+\s+sentences?\b/i],
  ['word-limit-instruction', /\b(?:max(?:imum)?|under|at most|no more than|within|limit(?:ed)? to)\s+\d+\s+words\b/i],
  ['prompt-echo-summary', /\b(?:opportunity|newsletter)\s+summary\b/i],
  ['prompt-echo-action-verb', /\b(?:strong\s+)?action\s+verb\b/i],
  ['prompt-echo-style', /\b(?:no\s+(?:bullet\s+points|fluff|hype\s+words|markdown(?:\s+formatting)?)|plain\s+prose)\b/i],
  ['prompt-echo-user', /\bthe\s+(?:user|prompt|instructions?)\s+(?:says|said|wants|asks|asked|requires|specif(?:y|ies))\b/i],
  ['lets-draft', /\blet'?s\s+(?:draft|craft|write|produce|count|check|compose|try|finalize|output|see|think|summari[sz]e|do)\b/i],
  ['meta-answer', /\b(?:final\s+answer|word\s+count|sentence\s+count|draft\s*:|final\s*:|output\s*:)/i],
  ['missing-field-speculation', /\?\s*(?:not\s+(?:given|provided|specified|mentioned|stated|listed|clear)|unknown|none\s+given|no\s+info|unclear|n\/a|could\s+(?:infer|say|mention|assume)|maybe|probably|possibly)\b/i],
  ['could-infer', /\bcould\s+infer\b|\bnot\s+given\b/i],
];

const PROMPT_FIELD_LABELS = /\b(grant name|amount|deadline|source|description|eligibility)\s*:/gi;

function excerptAround(text: string, index: number): string {
  const start = Math.max(0, index - 20);
  return text.slice(start, start + 100).replace(/\s+/g, ' ').trim();
}

/** Returns the first rule the text trips, or null when it reads as a finished summary. */
export function findSummaryLeak(text: string | null | undefined): SummaryLeakMatch | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  for (const [rule, pattern] of START_RULES) {
    if (pattern.test(trimmed)) return { rule, excerpt: excerptAround(trimmed, 0) };
  }
  for (const [rule, pattern] of ANYWHERE_RULES) {
    const match = pattern.exec(trimmed);
    if (match) return { rule, excerpt: excerptAround(trimmed, match.index) };
  }

  const labels = new Set((trimmed.match(PROMPT_FIELD_LABELS) || []).map(label => label.toLowerCase().replace(/\s*:$/, '')));
  if (labels.size >= 2) return { rule: 'prompt-field-echo', excerpt: excerptAround(trimmed, 0) };

  if ((trimmed.match(/\?/g) || []).length >= 3) {
    return { rule: 'many-questions', excerpt: excerptAround(trimmed, trimmed.indexOf('?')) };
  }
  return null;
}

export function isLeakedSummary(text: string | null | undefined): boolean {
  return findSummaryLeak(text) !== null;
}
