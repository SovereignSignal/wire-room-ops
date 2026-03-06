/**
 * AI-powered post generation for distribution channels.
 * Single Claude call generates both a tweet and Telegram HTML message.
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

function buildPrompt(entry: { name: string; description: string; amount?: string | null; deadline?: string | null; sourceUrl: string }, wire: string): string {
  const context = WIRE_CONTEXT[wire] || `${wire} grants and funding`;
  const parts = [
    `Generate social media posts for a ${context} opportunity.`,
    '',
    `Name: ${entry.name}`,
    `Description: ${entry.description}`,
  ];
  if (entry.amount) parts.push(`Amount: ${entry.amount}`);
  if (entry.deadline) parts.push(`Deadline: ${entry.deadline}`);
  parts.push(`Link: ${entry.sourceUrl}`);
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
  parts.push('- HTML format (<b>, <i>, <a href="...">)');
  parts.push('- 2-4 sentences, more detail than tweet');
  parts.push('- Include amount, deadline, and link');
  parts.push('- Professional but accessible tone');

  return parts.join('\n');
}

function buildFallbackPosts(entry: { name: string; description: string; amount?: string | null; deadline?: string | null; sourceUrl: string }): GeneratedPosts {
  const desc = entry.description.length > 100
    ? entry.description.substring(0, 100) + '...'
    : entry.description;
  const amount = entry.amount ? ` (${entry.amount})` : '';

  const tweet = `${entry.name}${amount}: ${desc} ${entry.sourceUrl}`.substring(0, 280);

  const tgParts = [`<b>${escapeHtml(entry.name)}</b>`];
  if (entry.amount) tgParts.push(`Amount: ${escapeHtml(entry.amount)}`);
  if (entry.deadline) tgParts.push(`Deadline: ${escapeHtml(entry.deadline)}`);
  tgParts.push(escapeHtml(entry.description));
  tgParts.push(`<a href="${escapeHtml(entry.sourceUrl)}">Details</a>`);

  return { tweet, telegram: tgParts.join('\n') };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function generatePosts(
  entry: { name: string; description: string; amount?: string | null; deadline?: string | null; sourceUrl: string },
  wire: string
): Promise<GeneratedPosts> {
  try {
    const anthropic = getClient();
    const prompt = buildPrompt(entry, wire);

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
    return buildFallbackPosts(entry);
  }
}
