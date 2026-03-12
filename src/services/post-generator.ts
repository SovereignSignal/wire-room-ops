/**
 * AI-powered post generation for distribution channels.
 * Single Claude call generates both a tweet and Telegram message.
 */

import { getClient } from './anthropic';
import type { GeneratedPosts } from '../types/intake';
import { escapeHtml } from '../utils/html';

const MODEL = 'claude-sonnet-4-6-20250627';

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
    description: finalDesc || 'Grant opportunity — see link for details.',
    amount: cleanedAmount,
    deadline: cleanedDeadline,
    sourceUrl: entry.sourceUrl,
    bestLink,
  };
}

// --- Prompt building ---

function buildPrompt(entry: ReturnType<typeof cleanEntry>, wire: string): string {
  const context = WIRE_CONTEXT[wire] || `${wire} grants and funding`;
  const parts = [
    `Generate social media posts for a ${context} opportunity.`,
    '',
    `Name: ${entry.name}`,
    `Description: ${entry.description}`,
  ];
  if (entry.amount) parts.push(`Amount: ${entry.amount}`);
  if (entry.deadline) parts.push(`Deadline: ${entry.deadline}`);
  parts.push(`Link: ${entry.bestLink}`);
  parts.push('');
  parts.push('Return EXACTLY this JSON (no markdown fences):');
  parts.push('{"tweet":"...","telegram":"..."}');
  parts.push('');
  parts.push('Rules for tweet:');
  parts.push('- Max 270 characters (leave room for link)');
  parts.push('- Include the link at the end');
  parts.push('- Punchy, informative, no hashtags');
  parts.push('- Lead with what makes this interesting (amount, org, deadline)');
  parts.push('');
  parts.push('Rules for telegram (use Telegram HTML formatting):');
  parts.push('- Structure:');
  parts.push('  Line 1: <b>Title</b> — a clean, descriptive title (not the raw entry name)');
  parts.push('  Line 2: blank');
  parts.push('  Lines 3+: 2-3 sentence summary explaining what this is, who it\'s for, and why it matters');
  parts.push('  Line after summary: blank');
  parts.push('  Details line (if amount or deadline): e.g. "💰 $3M  |  ⏰ April 15, 2026"');
  parts.push('  Last line: 🔗 <a href="URL">Source</a>');
  parts.push('');
  parts.push('- Write in clear, direct language — like a knowledgeable analyst briefing a colleague');
  parts.push('- The summary should ADD context beyond just restating the name — explain scope, eligibility, or significance');
  parts.push('- Do NOT repeat the title/name in the summary body — the title is already on its own line above');
  parts.push('- Use <b> for the title only. Use <a href="...">Source</a> for the link');
  parts.push('- Only include 💰 and ⏰ on the details line (not scattered through text)');
  parts.push('- If no amount/deadline, skip the details line entirely');
  parts.push('- NO hashtags, NO @mentions, NO markdown, NO code blocks');

  return parts.join('\n');
}

// --- Fallback generation ---

function buildFallbackPosts(entry: ReturnType<typeof cleanEntry>): GeneratedPosts {
  // Truncate description to one sentence (first period/excl/question, or 120 chars)
  let shortDesc = entry.description;
  const sentenceEnd = shortDesc.search(/[.!?]\s/);
  if (sentenceEnd > 0 && sentenceEnd < 200) {
    shortDesc = shortDesc.substring(0, sentenceEnd + 1);
  } else if (shortDesc.length > 120) {
    // Truncate at word boundary to avoid mid-word cuts
    const truncated = shortDesc.substring(0, 120);
    const lastSpace = truncated.lastIndexOf(' ');
    shortDesc = (lastSpace > 60 ? truncated.substring(0, lastSpace) : truncated) + '…';
  }

  // Tweet
  const amount = entry.amount ? ` (${entry.amount})` : '';
  const deadline = entry.deadline ? ` — deadline ${entry.deadline}` : '';
  const tweet = `${entry.name}${amount}${deadline}: ${shortDesc} ${entry.bestLink}`.substring(0, 280);

  // Telegram — structured HTML post
  const tgParts: string[] = [];
  tgParts.push(`<b>${escapeHtml(entry.name)}</b>`);
  tgParts.push('');
  if (shortDesc !== entry.name) {
    tgParts.push(escapeHtml(shortDesc));
    tgParts.push('');
  }
  const detailBits: string[] = [];
  if (entry.amount) detailBits.push(`💰 ${escapeHtml(entry.amount)}`);
  if (entry.deadline) detailBits.push(`⏰ ${escapeHtml(entry.deadline)}`);
  if (detailBits.length > 0) {
    tgParts.push(detailBits.join('  |  '));
    tgParts.push('');
  }
  tgParts.push(`🔗 <a href="${escapeHtml(entry.bestLink)}">Source</a>`);
  const telegram = tgParts.join('\n');

  return { tweet, telegram };
}

export async function generatePosts(
  entry: EntryInput,
  wire: string
): Promise<GeneratedPosts> {
  // Clean all entry fields before generation
  const cleaned = cleanEntry(entry);

  try {
    const anthropic = getClient();
    const prompt = buildPrompt(cleaned, wire);

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text content in response');
    }

    // Parse JSON from response (strip markdown fences if present)
    const raw = textBlock.text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(raw) as { tweet?: string; telegram?: string };

    if (!parsed.tweet || !parsed.telegram) {
      throw new Error('Missing tweet or telegram in AI response');
    }

    // Ensure tweet doesn't exceed limit
    const tweet = parsed.tweet.length > 280 ? parsed.tweet.substring(0, 277) + '...' : parsed.tweet;

    return { tweet, telegram: parsed.telegram };
  } catch (error) {
    console.error('[PostGenerator] AI generation failed, using fallback:', error);
    return buildFallbackPosts(cleaned);
  }
}
