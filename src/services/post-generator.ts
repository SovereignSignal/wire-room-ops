/**
 * AI-powered post generation for distribution channels.
 * One Ollama call generates both a tweet and Telegram message.
 * Primary model, then the fallback model, then the local template.
 */

import { config } from '../config';
import type { GeneratedPosts } from '../types/intake';
import { escapeHtml } from '../utils/html';
import { checkFaithfulness, type FaithfulnessCheck } from './post-faithfulness';
import { ollamaComplete } from './ollama';

const WIRE_CONTEXT: Record<string, string> = {
  crypto: 'crypto/blockchain grants and funding',
  ai: 'AI/ML grants and funding',
  oss: 'open source grants and funding',
};

// --- Input cleaning utilities ---

/**
 * Strip emoji characters from text (keeps basic punctuation).
 */
function stripEmojis(text: string): string {
  return text.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FA9F}\u{1FB00}-\u{1FBFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '').trim();
}

/**
 * Strip hashtags from text (e.g. #AI #crypto → AI crypto).
 */
function stripHashtags(text: string): string {
  return text.replace(/#(\w+)/g, '$1');
}

/**
 * Strip "via quote in post:NN" artifacts.
 */
function stripViaQuote(text: string): string {
  return text.replace(/\s*\(via quote in post:\d+\)/gi, '').trim();
}

/**
 * Clean markdown link artifacts: [text](url) → text
 */
function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/**
 * Strip X handle prefix patterns like "PRSGlobalOpen](https://x.com/...)" from names.
 * Also handles partial markdown link artifacts at the start of names.
 */
function stripXHandlePrefix(text: string): string {
  // Pattern: "HandleName](https://x.com/..." or "HandleName](https://twitter.com/..."
  let cleaned = text.replace(/^[A-Za-z0-9_]+\]\(https?:\/\/(x\.com|twitter\.com)[^)]*\)\s*[-—]?\s*/i, '');
  // Pattern: leftover "](" artifacts
  cleaned = cleaned.replace(/\]\([^)]*\)/g, '');
  // Pattern: leading "[" without closing
  cleaned = cleaned.replace(/^\[/, '');
  return cleaned.trim();
}

/**
 * Strip numbered prefixes like "14. Name" → "Name"
 */
function stripNumberedPrefix(text: string): string {
  return text.replace(/^\d+\.\s+/, '').trim();
}

/**
 * Extract non-X/Twitter URLs from text. Returns the first non-X URL found.
 */
function extractNonXUrl(text: string): string | null {
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/g;
  const matches = text.match(urlPattern);
  if (!matches) return null;
  for (const url of matches) {
    const cleaned = url.replace(/[.,;:!?]+$/, '');
    if (!cleaned.match(/^https?:\/\/(x\.com|twitter\.com)\//i)) {
      return cleaned;
    }
  }
  return null;
}

/**
 * Strip raw URLs from text body.
 */
function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"')\]]+/g, '').trim();
}

/**
 * Clean a grant name: strip all artifacts and noise.
 */
function cleanName(name: string): string {
  let cleaned = name;
  cleaned = stripXHandlePrefix(cleaned);
  cleaned = stripMarkdownLinks(cleaned);
  cleaned = stripNumberedPrefix(cleaned);
  cleaned = stripEmojis(cleaned);
  // Remove trailing " —" or " -" left from stripping
  cleaned = cleaned.replace(/\s*[-—]+\s*$/, '');
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Clean a description: strip hashtags, emojis, quote artifacts, URLs, timestamps.
 */
function cleanDescription(desc: string): string {
  let cleaned = desc;
  cleaned = stripViaQuote(cleaned);
  cleaned = stripHashtags(cleaned);
  cleaned = stripEmojis(cleaned);
  cleaned = stripMarkdownLinks(cleaned);
  // Strip bare timestamps like "Fri, 06 Mar 2026 14:00:01 GMT"
  cleaned = cleaned.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+\w{3}\s+\d{4}\s+[\d:]+\s*\w*\b/g, '');
  // Strip "Details" footer
  cleaned = cleaned.replace(/\bDetails\s*$/i, '');
  // Strip stray numbered prefixes (e.g. "16." on its own or at start of line)
  cleaned = cleaned.replace(/(?:^|\n)\s*\d{1,3}\.\s*(?:\n|$)/g, '\n');
  cleaned = cleaned.replace(/^\d{1,3}\.\s+/, '');
  // Strip "Total: N results..." footer lines from batch intake
  cleaned = cleaned.replace(/\bTotal:\s*\d+\s*results?\b[^\n]*/gi, '');
  // Strip URLs (we'll add the link separately)
  cleaned = stripUrls(cleaned);
  // Collapse whitespace and newlines
  cleaned = cleaned.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Choose the best link: prefer non-X URLs found in description, fall back to sourceUrl.
 */
function chooseBestLink(description: string, sourceUrl: string): string {
  const nonXUrl = extractNonXUrl(description);
  return nonXUrl || sourceUrl;
}

interface EntryInput {
  name: string;
  description: string;
  amount?: string | null;
  deadline?: string | null;
  sourceUrl: string;
  /** 1–6 or out. Apply path and deadline are included only for area 3. */
  wireArea?: string | null;
}

/**
 * Clean all entry fields before prompt or fallback generation.
 */
function cleanEntry(entry: EntryInput): EntryInput & { bestLink: string } {
  const cleanedName = cleanName(entry.name);
  const bestLink = chooseBestLink(entry.description, entry.sourceUrl);
  const cleanedDesc = cleanDescription(entry.description);
  const cleanedDeadline = entry.deadline && entry.deadline.toLowerCase() !== 'none listed'
    ? entry.deadline
    : null;
  const cleanedAmount = entry.amount && entry.amount.toLowerCase() !== 'none listed'
    ? entry.amount
    : null;

  // Strip the name from the start of the description to avoid duplication in posts
  let finalDesc = cleanedDesc;
  if (cleanedName && finalDesc) {
    // Case-insensitive check: if description starts with the name (possibly followed by punctuation)
    const namePattern = cleanedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    finalDesc = finalDesc.replace(new RegExp(`^${namePattern}[:\\s—–-]*`, 'i'), '').trim();
  }

  return {
    name: cleanedName || entry.name,
    description: finalDesc,
    amount: cleanedAmount,
    deadline: cleanedDeadline,
    sourceUrl: entry.sourceUrl,
    bestLink,
    wireArea: entry.wireArea ?? null,
  };
}

// --- Prompt building ---

export function buildPostPrompt(entry: ReturnType<typeof cleanEntry>, wire: string): string {
  const context = WIRE_CONTEXT[wire] || `${wire} grants and funding`;
  const thin = !entry.description;
  const parts = [
    `Write social posts for a ${context} item.`,
    'Use only facts that appear in the fields below. If a detail is not written there, leave it out.',
    'If the fields are thin, write one sentence or a headline only. Never add filler.',
    'Keep the funder\'s own verb. Use opens, launches, new, or relaunch only when the fields say so.',
    'For a program that is already running, use neutral wording such as "is accepting applications".',
    'Say rolling or no deadline only when the fields state it.',
    'Do not add opinion or hype (rare, one of the, notable, signals, worth exploring, major, significant, largest, groundbreaking, exciting, or similar praise).',
    'Copy amounts and other numbers exactly as written. Do not add, round, or combine them.',
    "Match the item's area: award/result posts name the funder, recipients and amounts as stated; governance posts state the decision, vote result and capital moved. Attributed commentary must be quoted or framed as the named person's view ('X argues…'), never stated as fact. Do not compute or add up totals, averages, counts or percentages that the source doesn't state in exactly those words.",
    entry.wireArea === '3' || entry.wireArea == null
      ? 'When the fields include an apply path or a deadline, include it.'
      : 'Do not include an apply path or an application deadline. This item is not an open call.',
    '',
    `Name: ${entry.name}`,
    `Description: ${entry.description || '(none)'}`,
  ];
  if (entry.amount) parts.push(`Amount: ${entry.amount}`);
  if (entry.deadline) parts.push(`Deadline: ${entry.deadline}`);
  parts.push(`Link: ${entry.bestLink}`);
  parts.push('');
  parts.push('Return EXACTLY this JSON (no markdown fences):');
  parts.push('{"tweet":"...","telegram":"..."}');
  parts.push('');
  parts.push('Rules for tweet:');
  parts.push('- Max 270 characters (leave room for the link)');
  parts.push('- Include the link at the end');
  parts.push('- No hashtags, no @mentions');
  parts.push('- Only facts from the fields above');
  parts.push('');
  parts.push('Rules for telegram (Telegram HTML):');
  parts.push('- Line 1: <b>headline using only the fields above</b>');
  parts.push('- Then a blank line');
  parts.push(thin
    ? '- Do not add a summary sentence. The headline and the link are enough.'
    : '- Then one sentence that says what the funding is for, copied from the description, before eligibility or how to apply. Then eligibility and the apply path when the description states them.');
  if (!thin) {
    parts.push('- Do not stop after eligibility or how to apply when the description also says what the money is for. Keep a partner, research topic, or publication type that belongs to that purpose sentence.');
  }
  parts.push('- Then a blank line');
  parts.push('- Then 🔗 <a href="URL">Source</a> using the link above');
  parts.push('- Use <b> for the headline only, and <a href="..."> for the link');
  parts.push('- No hashtags, no @mentions, no markdown, no code blocks');
  return parts.join('\n');
}

// --- Body selection ---
//
// The October 2026 wires dropped the "what it's for" line because the prompt
// allowed one body sentence and this fallback kept whichever sentence came
// first. Eligibility and the apply path were what survived. Nothing here
// removes a sentence for naming a partner or for reading like a summary.

const APPLY_CUE = /\b(expression of interest|\bEOI\b|how to apply|submitted through|submit(?:s|ted|ting)?|applications? (?:are|open|close)|grants portal|apply (?:at|via|through|by|with))\b/i;
const ELIGIBILITY_CUE = /\b(only for|open to|eligible|eligibility|applicants?\b|based in|restricted to|must be|residents|anyone can)\b/i;
const PURPOSE_CUE = /\b(funds?|funding|supports?|supporting|covers?|covering|builds?|building|develops?|developing|creates?|creating|publishes?|publishing|improves?|improving|enables?|enabling|produces?|producing|research(?:es|ing)|research\s+(?:on|into)|topics?|multimedia|publications?)\b/i;

const BODY_CHAR_BUDGET = 900;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
}

function sentenceKind(sentence: string): 'purpose' | 'eligibility' | 'apply' | 'other' {
  if (PURPOSE_CUE.test(sentence)) return 'purpose';
  if (ELIGIBILITY_CUE.test(sentence)) return 'eligibility';
  if (APPLY_CUE.test(sentence)) return 'apply';
  return 'other';
}

function purposeRank(sentence: string): number {
  let score = 0;
  if (/\bresearch(?:es|ing)?\s+(?:on|into)\b|\btopics?\b/i.test(sentence)) score += 4;
  if (/\b(funds?|funding|supports?|supporting)\b/i.test(sentence)) score += 3;
  if (/\b(builds?|develops?|creates?|publishes?|multimedia|publications?)\b/i.test(sentence)) score += 3;
  if (/\bcovers?\b/i.test(sentence)) score += 1;
  if (ELIGIBILITY_CUE.test(sentence) || APPLY_CUE.test(sentence)) score -= 2;
  return score;
}

function clipSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const truncated = text.substring(0, max);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? truncated.substring(0, lastSpace) : truncated) + '…';
}

/**
 * Sentences the wire body must keep, in post order: what the funding is for,
 * one supporting fact, then eligibility and the apply path.
 */
export function wireBodySentences(description: string): string[] {
  const tagged = splitSentences(description).map((sentence, index) => ({
    sentence,
    index,
    kind: sentenceKind(sentence),
  }));
  const purposes = tagged
    .filter(item => item.kind === 'purpose')
    .sort((a, b) => purposeRank(b.sentence) - purposeRank(a.sentence) || a.index - b.index)
    .map(item => item.sentence);
  const others = tagged.filter(item => item.kind === 'other').map(item => item.sentence);
  const eligibility = tagged.find(item => item.kind === 'eligibility')?.sentence ?? null;
  const apply = tagged.find(item => item.kind === 'apply')?.sentence ?? null;
  const lead = purposes[0] ?? others[0] ?? null;
  const extra = purposes.find(sentence => sentence !== lead) ?? null;
  const substantive = [lead, extra].filter((sentence): sentence is string => !!sentence);
  const process = [eligibility, apply].filter((sentence): sentence is string => !!sentence);
  let lines = [...substantive, ...process];
  const seen = new Set<string>();
  lines = lines.filter(sentence => {
    const key = sentence.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (extra && lines.join(' ').length > BODY_CHAR_BUDGET) {
    lines = lines.filter(sentence => sentence !== extra);
  }
  if (lines[0] && lines[0].length > 700) lines[0] = clipSentence(lines[0], 700);
  return lines;
}

function plainPost(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[’]/g, "'")
    .toLowerCase();
}

const COVERAGE_STOP = new Set([
  'which', 'their', 'there', 'about', 'through', 'these', 'those', 'where', 'while',
  'after', 'before', 'under', 'other', 'would', 'could', 'should', 'being', 'using',
  'based', 'with', 'from', 'that', 'this', 'into', 'only', 'open', 'than', 'then',
]);

/** A draft keeps a required sentence when half of its distinctive words are present. */
export function coversSentence(draft: string, sentence: string): boolean {
  const words = plainPost(sentence).match(/\b[a-z0-9][a-z0-9'+-]{3,}\b/g) ?? [];
  const distinctive = [...new Set(words.filter(word => !COVERAGE_STOP.has(word) && !/^\d+$/.test(word)))];
  if (!distinctive.length) return true;
  const hay = plainPost(draft);
  const hits = distinctive.filter(word => hay.includes(word));
  const need = distinctive.length <= 2 ? distinctive.length : Math.ceil(distinctive.length * 0.5);
  return hits.length >= need;
}

// --- Fallback generation ---

function headline(entry: ReturnType<typeof cleanEntry>): string {
  let title = escapeHtml(entry.name);
  if (entry.amount) title += ` — ${escapeHtml(entry.amount)}`;
  if (entry.deadline) title += entry.amount ? `, deadline ${escapeHtml(entry.deadline)}` : ` — deadline ${escapeHtml(entry.deadline)}`;
  return `<b>${title}</b>`;
}

function buildFallbackPosts(entry: ReturnType<typeof cleanEntry>): GeneratedPosts {
  const body = wireBodySentences(entry.description).filter(sentence => sentence !== entry.name);
  const lead = body[0] ?? '';
  const shortLead = lead ? clipSentence(lead, 120) : '';

  const amount = entry.amount ? ` (${entry.amount})` : '';
  const deadline = entry.deadline ? ` — deadline ${entry.deadline}` : '';
  const tweet = `${entry.name}${amount}${deadline}: ${shortLead} ${entry.bestLink}`.replace(/\s+/g, ' ').trim().substring(0, 280);

  const tgParts: string[] = [headline(entry), ''];
  if (body.length) {
    tgParts.push(escapeHtml(body.join(' ')));
    tgParts.push('');
  }
  tgParts.push(`🔗 <a href="${escapeHtml(entry.bestLink)}">Source</a>`);
  return { tweet, telegram: tgParts.join('\n') };
}

export function templatePosts(entry: EntryInput): GeneratedPosts {
  return buildFallbackPosts(cleanEntry(entry));
}

export interface VerifierResult {
  ok: boolean;
  model: string | null;
  unsupported: string[];
  error: string | null;
}

export interface PostCheckResult extends FaithfulnessCheck {
  source: 'model' | 'template';
  attempts: number;
  rejected: string[];
}

export interface GeneratedPostRecord extends GeneratedPosts {
  model: string | null;
  checkResult: PostCheckResult;
  verifierResult: VerifierResult;
}

/** POST_GEN_MODEL, otherwise the summary primary. Read at call time. */
export function postGenerationModel(): string {
  return (process.env.POST_GEN_MODEL || config.apis.ollama.defaultModel).trim();
}

/** POST_VERIFY_MODEL, otherwise the summary primary. Read at call time. */
export function postVerificationModel(): string {
  return (process.env.POST_VERIFY_MODEL || config.apis.ollama.defaultModel).trim();
}

function postModels(primary: string): string[] {
  const fallback = config.apis.ollama.fallbackModel.trim();
  if (fallback && fallback !== primary) return [primary, fallback];
  return primary ? [primary] : [];
}

function inputText(entry: EntryInput): string {
  return [entry.name, entry.description, entry.amount, entry.deadline, entry.sourceUrl]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join('\n');
}

function parsePostJson(text: string): { tweet: string; telegram: string } | null {
  const raw = text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { tweet?: string; telegram?: string };
    if (!parsed.tweet || !parsed.telegram) return null;
    const tweet = parsed.tweet.length > 280 ? `${parsed.tweet.substring(0, 277)}...` : parsed.tweet;
    return { tweet, telegram: parsed.telegram };
  } catch {
    return null;
  }
}

function parseUnsupported(text: string): string[] | null {
  const raw = text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { unsupported?: unknown };
    if (!Array.isArray(parsed.unsupported)) return null;
    return parsed.unsupported
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map(item => item.trim());
  } catch {
    return null;
  }
}

async function completeWith(prompt: string, purpose: string, primary: string, wire: string, temperature: number, numPredict: number): Promise<{ model: string; text: string }> {
  let lastError: Error | null = null;
  for (const model of postModels(primary)) {
    try {
      return await ollamaComplete({ prompt, purpose, model, wire, numPredict, temperature });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error(`${purpose} failed`);
}

export function buildVerifierPrompt(input: string, draft: string): string {
  return [
    'You check whether a draft Telegram post adds anything the source fields do not support.',
    'Compare the draft only to the source fields. A claim is unsupported when the fields do not state it,',
    'including combined or rounded amounts, extra eligibility, a news verb the fields do not use, a deadline the fields do not state, and opinion or hype.',
    'FAIL if an opinion is stated as fact without attribution, or if any number is derived or added up rather than quoted from the source.',
    'Return EXACTLY this JSON and nothing else: {"unsupported":["short claim", "..."]}',
    'Use an empty array when every claim in the draft is supported.',
    '',
    'Source fields:',
    input || '(none)',
    '',
    'Draft:',
    draft,
  ].join('\n');
}

export function localVerifierFailures(input: string, draft: string): string[] {
  const html = /<[^>]+>/.test(draft);
  const faith = checkFaithfulness(input, draft, { html });
  return faith.violations
    .filter(violation => violation.startsWith('amount ') || violation.startsWith('number ') || violation.startsWith('unattributed opinion'))
    .map(violation => violation.startsWith('unattributed opinion') ? violation : `derived number: ${violation}`);
}

export async function verifyPostClaims(input: string, draft: string, wire: string): Promise<VerifierResult> {
  const local = localVerifierFailures(input, draft);
  try {
    const { model, text } = await completeWith(
      buildVerifierPrompt(input, draft),
      'post-verify',
      postVerificationModel(),
      wire,
      0,
      1024,
    );
    const unsupported = parseUnsupported(text);
    if (!unsupported) {
      return { ok: false, model, unsupported: local, error: local.length ? null : 'verifier returned unreadable JSON' };
    }
    const combined = [...local, ...unsupported];
    return { ok: combined.length === 0, model, unsupported: combined, error: null };
  } catch (error) {
    if (local.length) {
      return { ok: false, model: postVerificationModel() || null, unsupported: local, error: null };
    }
    return {
      ok: false,
      model: postVerificationModel() || null,
      unsupported: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function retryPrompt(basePrompt: string, rejected: string[]): string {
  const omitted = rejected.filter(item => item.startsWith('omitted: ')).map(item => item.slice('omitted: '.length));
  const problems = rejected.filter(item => !item.startsWith('omitted: '));
  if (!omitted.length) {
    return `${basePrompt}\n\nThe previous draft was rejected. Rewrite it so none of these remain:\n${problems.map(item => `- ${item}`).join('\n')}`;
  }
  const lines = ['The previous draft was rejected.'];
  if (problems.length) lines.push('Rewrite it so none of these remain:', ...problems.map(item => `- ${item}`));
  lines.push('Include these sentences from the description:', ...omitted.map(item => `- ${item}`));
  return `${basePrompt}\n\n${lines.join('\n')}`;
}

function gateViolations(input: string, telegram: string, verifier: VerifierResult): string[] {
  const violations = [...checkFaithfulness(input, telegram, { html: true }).violations];
  if (!verifier.ok) {
    if (verifier.unsupported.length) {
      violations.push(...verifier.unsupported.map(item => `unsupported: ${item}`));
    } else if (verifier.error) {
      violations.push(`verifier: ${verifier.error}`);
    } else {
      violations.push('verifier rejected the draft');
    }
  }
  return violations.slice(0, 12);
}

export async function generatePosts(entry: EntryInput, wire: string): Promise<GeneratedPostRecord> {
  const cleaned = cleanEntry(entry);
  const facts = inputText(entry);
  const basePrompt = buildPostPrompt(cleaned, wire);
  const rejected: string[] = [];
  let lastVerifier: VerifierResult | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? basePrompt : retryPrompt(basePrompt, rejected);
    let drafted: { tweet: string; telegram: string; model: string };
    try {
      const completed = await completeWith(prompt, 'post-gen', postGenerationModel(), wire, 0.1, 4096);
      const parsed = parsePostJson(completed.text);
      if (!parsed) throw new Error('Missing tweet or telegram in AI response');
      drafted = { ...parsed, model: completed.model };
    } catch (error) {
      console.error('[PostGenerator] AI generation failed, using fallback:', error);
      break;
    }
    const verifier = await verifyPostClaims(facts, drafted.telegram, wire);
    lastVerifier = verifier;
    const violations = gateViolations(facts, drafted.telegram, verifier);
    const omitted = wireBodySentences(cleaned.description)
      .filter(sentence => !coversSentence(drafted.telegram, sentence))
      .slice(0, 4)
      .map(sentence => `omitted: ${sentence.slice(0, 180)}`);
    if (omitted.length) violations.unshift(...omitted);
    if (violations.length === 0) {
      const tweetCheck = checkFaithfulness(facts, drafted.tweet, { html: false });
      const telegramCheck = checkFaithfulness(facts, drafted.telegram, { html: true });
      return {
        tweet: tweetCheck.ok ? drafted.tweet : buildFallbackPosts(cleaned).tweet,
        telegram: drafted.telegram,
        model: drafted.model,
        checkResult: { ...telegramCheck, source: 'model', attempts: attempt + 1, rejected: [...rejected] },
        verifierResult: verifier,
      };
    }
    rejected.splice(0, rejected.length, ...violations);
  }

  const fallback = buildFallbackPosts(cleaned);
  const check = checkFaithfulness(facts, fallback.telegram, { html: true });
  return {
    ...fallback,
    model: 'template',
    checkResult: { ...check, source: 'template', attempts: rejected.length ? 2 : 0, rejected: [...rejected] },
    verifierResult: lastVerifier ?? { ok: false, model: null, unsupported: [], error: 'not run', },
  };
}
