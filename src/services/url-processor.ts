/**
 * URL Processor Service
 *
 * Shared logic for scraping a URL and extracting structured grant information
 * using AI. Used by both Telegram bot and email inbound handlers.
 *
 * Routes:
 * - X.com/Twitter URLs → Grok chat completions (native access)
 * - All other URLs → Firecrawl scrape + Claude Sonnet extraction
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { isXcomUrl } from './grok';
import { resolveUrl, scrapeUrl, isScrapableUrl, truncateContent } from './scraper';
import { withRetry } from './processor';
import type { RawScanResult } from '../types/intake';

// Claude Sonnet for extraction — cheaper than Opus, sufficient for structured work
const EXTRACTION_MODEL = 'claude-sonnet-4-5-20250514';

const EXTRACTION_PROMPT = `You are extracting grant/funding opportunity information from a web page.

URL: {url}

Page Content:
{content}

Extract the following fields as JSON. If a field is not found, use null.

{
  "name": "Program or opportunity name",
  "description": "1-2 sentence description of what this grant/opportunity is",
  "amount": "Dollar amount if mentioned (e.g. '$50K', '$3M', 'Up to $100,000')",
  "deadline": "Application deadline if mentioned (e.g. 'March 15, 2026', 'Rolling', null)",
  "wire": "Best category: 'crypto', 'ai', or 'oss' (open source). Use null if unclear."
}

IMPORTANT:
- Return ONLY the JSON object, no markdown fences, no explanation
- For "name", use the official program/grant name
- For "description", focus on what applicants can get and who is eligible
- For "wire", choose based on the primary domain of the opportunity
- If this page is NOT about a grant/funding opportunity, still extract what you can`;

const GROK_EXTRACTION_PROMPT = `You have access to X.com posts. Read this post and extract grant/funding opportunity information.

URL: {url}

Extract the following fields as JSON. If a field is not found, use null.

{
  "name": "Program or opportunity name",
  "description": "1-2 sentence description of what this grant/opportunity is",
  "amount": "Dollar amount if mentioned (e.g. '$50K', '$3M', 'Up to $100,000')",
  "deadline": "Application deadline if mentioned (e.g. 'March 15, 2026', 'Rolling', null)",
  "wire": "Best category: 'crypto', 'ai', or 'oss' (open source). Use null if unclear."
}

IMPORTANT:
- Return ONLY the JSON object, no markdown fences, no explanation
- If the post mentions or links to a grant/funding program, extract its details
- If it's not about grants/funding, still extract what you can from the post`;

export interface ProcessUrlResult {
  result: RawScanResult;
  detectedWire: string | null;
}

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.apis.anthropic.apiKey });
  }
  return anthropicClient;
}

/**
 * Process a single URL: scrape and extract structured grant info using AI.
 */
export async function processUrl(url: string): Promise<ProcessUrlResult> {
  // 1. Resolve shortened URLs
  const resolvedUrl = await resolveUrl(url);
  console.log(`[URLProcessor] Processing: ${resolvedUrl}`);

  // 2. Route based on URL type
  if (isXcomUrl(resolvedUrl)) {
    return processXcomUrl(resolvedUrl);
  }
  return processWebUrl(resolvedUrl);
}

/**
 * Process an X.com URL using Grok chat completions.
 */
async function processXcomUrl(url: string): Promise<ProcessUrlResult> {
  const prompt = GROK_EXTRACTION_PROMPT.replace('{url}', url);

  const responseData = await withRetry(async () => {
    const response = await fetch(`${config.apis.grok.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apis.grok.apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3-mini-fast',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Grok API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<{ choices: Array<{ message: { content: string } }> }>;
  }, 2);

  const content = responseData.choices?.[0]?.message?.content || '';
  return parseExtractionResult(content, url);
}

/**
 * Process a non-X.com URL using Firecrawl + Claude Sonnet.
 */
async function processWebUrl(url: string): Promise<ProcessUrlResult> {
  let pageContent = '';

  // Try to scrape if the URL is scrapable
  if (isScrapableUrl(url)) {
    console.log(`[URLProcessor] Scraping: ${url}`);
    const scrapeResult = await scrapeUrl(url);
    if (scrapeResult.success) {
      pageContent = truncateContent(scrapeResult.content, 6000);
      console.log(`[URLProcessor] Scraped ${scrapeResult.content.length} chars`);
    } else {
      console.log(`[URLProcessor] Scrape failed: ${scrapeResult.error}`);
    }
  }

  // If scraping failed or wasn't possible, return minimal result
  if (!pageContent) {
    console.log(`[URLProcessor] No content for ${url}, returning minimal result`);
    return {
      result: {
        name: extractDomainName(url),
        description: `Submitted URL: ${url}`,
        amount: null,
        deadline: null,
        sourceUrl: url,
      },
      detectedWire: null,
    };
  }

  const prompt = EXTRACTION_PROMPT
    .replace('{url}', url)
    .replace('{content}', pageContent);

  const extracted = await withRetry(async () => {
    const client = getAnthropicClient();
    const message = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude returned no text content');
    }
    return textBlock.text.trim();
  }, 2);

  return parseExtractionResult(extracted, url);
}

/**
 * Parse the JSON extraction result from either AI provider.
 */
function parseExtractionResult(raw: string, url: string): ProcessUrlResult {
  try {
    // Strip markdown fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(cleaned);

    return {
      result: {
        name: parsed.name || extractDomainName(url),
        description: parsed.description || `Submitted URL: ${url}`,
        amount: parsed.amount || null,
        deadline: parsed.deadline || null,
        sourceUrl: url,
      },
      detectedWire: parsed.wire || null,
    };
  } catch (e) {
    console.warn(`[URLProcessor] Failed to parse AI response: ${e}`);
    // Return minimal result on parse failure
    return {
      result: {
        name: extractDomainName(url),
        description: `Submitted URL: ${url}`,
        amount: null,
        deadline: null,
        sourceUrl: url,
      },
      detectedWire: null,
    };
  }
}

/**
 * Extract a readable name from a URL's domain.
 */
function extractDomainName(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // Remove www. and .com/.org/etc
    return hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    return 'Unknown';
  }
}
