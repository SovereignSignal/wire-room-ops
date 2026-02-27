/**
 * AI-powered post generation for distribution channels.
 *
 * Single Claude call generates both a tweet (<=270 chars) and a Telegram HTML message.
 * Falls back to template-based formatting if the AI response is malformed.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { escapeHtml } from '../utils/html';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.apis.anthropic.apiKey });
  }
  return client;
}

export interface PostContent {
  tweet: string;
  telegram: string;
}

interface EntryData {
  name: string;
  description: string;
  amount: string | null;
  deadline: string | null;
  sourceUrl: string;
  wire: string;
}

const WIRE_CONTEXT: Record<string, string> = {
  crypto: 'cryptocurrency and blockchain grants',
  ai: 'AI and machine learning grants',
  oss: 'open source software grants',
};

function buildPrompt(entry: EntryData): string {
  const wireDesc = WIRE_CONTEXT[entry.wire] || `${entry.wire} grants`;

  return `You are a social media writer for a ${wireDesc} newsletter. Generate two posts for the same grant opportunity.

ENTRY:
Name: ${entry.name}
Description: ${entry.description}
${entry.amount ? `Amount: ${entry.amount}` : ''}
${entry.deadline ? `Deadline: ${entry.deadline}` : ''}
URL: ${entry.sourceUrl}

INSTRUCTIONS:
1. TWEET: Max 270 characters (leave room for the URL which will be appended). Punchy, informative, no hashtags. Include the key detail (amount or deadline) if space allows.
2. TELEGRAM: HTML-formatted message for a Telegram channel post. Use <b> for the name, include all details, and end with the URL as a clickable link. 2-4 sentences max.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:
TWEET:
[your tweet text here]
TELEGRAM:
[your telegram HTML here]`;
}

function parseResponse(text: string): PostContent | null {
  const tweetMatch = text.match(/TWEET:\s*\n([\s\S]*?)(?=\nTELEGRAM:)/);
  const telegramMatch = text.match(/TELEGRAM:\s*\n([\s\S]*?)$/);

  if (!tweetMatch || !telegramMatch) return null;

  const tweet = tweetMatch[1].trim();
  const telegram = telegramMatch[1].trim();

  if (!tweet || !telegram) return null;
  if (tweet.length > 255) return null; // 255 + \n + 23 (t.co URL) = 279 chars max

  return { tweet, telegram };
}

function generateFallback(entry: EntryData): PostContent {
  const details: string[] = [];
  if (entry.amount) details.push(entry.amount);
  if (entry.deadline && entry.deadline !== 'Rolling' && entry.deadline !== 'None listed') {
    details.push(`Deadline: ${entry.deadline}`);
  }
  const detailStr = details.length > 0 ? ` (${details.join(' | ')})` : '';

  // Tweet: truncate description to fit (max 256 chars — leaves room for \n + 23-char t.co URL = 280)
  const MAX_TWEET_TEXT = 256;
  const prefix = `${entry.name}${detailStr}`;
  const maxDescLen = MAX_TWEET_TEXT - prefix.length - 3; // 3 for " - "
  let tweet: string;
  if (maxDescLen > 20) {
    const desc = entry.description.length > maxDescLen
      ? entry.description.substring(0, maxDescLen - 1) + '\u2026'
      : entry.description;
    tweet = `${prefix} - ${desc}`;
  } else {
    tweet = prefix.substring(0, MAX_TWEET_TEXT);
  }

  // Telegram: structured HTML
  let telegram = `<b>${escapeHtml(entry.name)}</b>\n\n`;
  telegram += escapeHtml(entry.description);
  if (entry.amount) telegram += `\n\nAmount: ${escapeHtml(entry.amount)}`;
  if (entry.deadline) telegram += `\nDeadline: ${escapeHtml(entry.deadline)}`;
  telegram += `\n\n<a href="${escapeHtml(entry.sourceUrl)}">Source</a>`;

  return { tweet, telegram };
}

export async function generatePosts(entry: EntryData): Promise<PostContent> {
  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: buildPrompt(entry) }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = parseResponse(text);

    if (parsed) {
      console.log(`[PostGen] AI-generated posts for "${entry.name}" (tweet: ${parsed.tweet.length} chars)`);
      return parsed;
    }

    console.warn(`[PostGen] AI response malformed for "${entry.name}", using template fallback`);
    return generateFallback(entry);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[PostGen] AI generation failed for "${entry.name}": ${msg}, using template fallback`);
    return generateFallback(entry);
  }
}
