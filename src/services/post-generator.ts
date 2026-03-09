/**
 * AI-powered post generation for distribution channels.
 * Single Claude call generates both a tweet and Telegram message.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import type { GeneratedPosts } from '../types/intake';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.apis.anthropic.apiKey });
  }
  return client;
}

const MODEL = 'claude-sonnet-4-5-20250514';

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

  return {
    name: cleanedName || entry.name,
    description: cleanedDesc || 'Grant opportunity — see link for details.',
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
  parts.push('Rules for telegram:');
  parts.push('- Plain text (NOT HTML). Use Unicode for emphasis if needed.');
  parts.push('- Format EXACTLY like this:');
  parts.push('');
  parts.push('  <emoji> <Name>');
  parts.push('');
  parts.push('  <1-2 sentence description>');
  parts.push('');
  parts.push('  Amount: <amount>        ← only if amount is provided');
  parts.push('  Deadline: <deadline>    ← only if deadline is provided');
  parts.push('');
  parts.push('  Learn more → <link>');
  parts.push('');
  parts.push('- Start with a relevant emoji (💰🔬🛠️🏗️🎯🌐 etc.)');
  parts.push('- Name should be clean — no org handles, no brackets, no markdown');
  parts.push('- Description: 1-2 sentences max, plain language, no hashtags');
  parts.push('- Skip Amount/Deadline lines entirely if not provided');
  parts.push('- End with "Learn more →" or "Apply →" followed by the link');
  parts.push('- NO hashtags, NO HTML tags, NO timestamps, NO "Details" text');
  parts.push('- NO raw tweet text — write a clean human summary');

  return parts.join('\n');
}

// --- Fallback generation ---

function buildFallbackPosts(entry: ReturnType<typeof cleanEntry>): GeneratedPosts {
  const desc = entry.description.length > 150
    ? entry.description.substring(0, 150) + '...'
    : entry.description;

  // Tweet
  const amount = entry.amount ? ` (${entry.amount})` : '';
  const tweet = `${entry.name}${amount}: ${desc} ${entry.bestLink}`.substring(0, 280);

  // Telegram — clean, scannable format
  const tgLines: string[] = [];
  tgLines.push(`💰 ${entry.name}`);
  tgLines.push('');
  tgLines.push(desc);
  tgLines.push('');
  if (entry.amount) tgLines.push(`Amount: ${entry.amount}`);
  if (entry.deadline) tgLines.push(`Deadline: ${entry.deadline}`);
  if (entry.amount || entry.deadline) tgLines.push('');
  tgLines.push(`Learn more → ${entry.bestLink}`);

  return { tweet, telegram: tgLines.join('\n') };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Main export ---

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
