import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { DatabaseEntry } from '../types';
import { scrapeUrl, isScrapableUrl, truncateContent } from './scraper';

// Prompt when we have scraped content
const SCRAPED_CONTENT_PROMPT = `Summarize this web page for the Crypto Grant Wire newsletter.

URL: {url}

Page Content:
{scraped_content}

Reference summary (may be outdated): {existing_summary}

Write a CONCISE newsletter entry following this exact format:

**[Organization/Project Name]** announced/launched/opened [what happened], [key details with numbers]. [One more sentence with timeline, eligibility, or how to apply if relevant].

RULES:
- Keep it to 2-3 sentences MAX, around 50-75 words total
- Lead with an action verb (announced, launched, opened, unveiled, allocated, distributed, published, released)
- Include specific numbers inline (funding amounts, token quantities, deadlines, dates)
- No bullet points, no separate sections for "Key numbers" or "Actionable details"
- No flowery language or filler words
- Exclude: committee member names, historical background, mechanism explanations
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

EXAMPLE OUTPUT:
**Optimism Grants Council** published its Season 8 impact analysis, showing 1.8M OP distributed to 12 projects generated $3.0M in TVL uplift with $1.7 ROI per OP token. Top performers include Truemarkets ($4.8/OP ROI) and Morpho (+$11.5M TVL).`;

// Fallback prompt when scraping fails
const FALLBACK_PROMPT = `Refine this summary for the Crypto Grant Wire newsletter.

URL: {url}
Existing summary: {existing_summary}

Write a CONCISE newsletter entry following this exact format:

**[Organization/Project Name]** announced/launched/opened [what happened], [key details with numbers]. [One more sentence with timeline, eligibility, or how to apply if relevant].

RULES:
- Keep it to 2-3 sentences MAX, around 50-75 words total
- Lead with an action verb (announced, launched, opened, unveiled, allocated, distributed, published, released)
- Include specific numbers inline (funding amounts, token quantities, deadlines, dates)
- No bullet points, no separate sections
- No flowery language or filler words
- Work with the information provided - do not say "unable to access"
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

EXAMPLE OUTPUT:
**Stellar Community Fund** opened Round 20 applications, offering up to $100K per project for ecosystem development. Applications close February 5, 2026, with results announced in March.`;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: config.apis.anthropic.apiKey,
    });
  }
  return client;
}

// Default model if none specified
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

export async function summarizeWithOpus(entry: DatabaseEntry, model?: string): Promise<string> {
  let prompt: string;
  let scrapedSuccessfully = false;

  // Try to scrape the URL if it's scrapable
  if (isScrapableUrl(entry.url)) {
    console.log(`    Scraping ${entry.url}...`);
    const scrapeResult = await scrapeUrl(entry.url);

    if (scrapeResult.success) {
      console.log(`    Scraped ${scrapeResult.content.length} chars`);
      const truncatedContent = truncateContent(scrapeResult.content);
      prompt = SCRAPED_CONTENT_PROMPT
        .replace('{url}', entry.url)
        .replace('{scraped_content}', truncatedContent)
        .replace('{existing_summary}', entry.quick_summary);
      scrapedSuccessfully = true;
    } else {
      console.log(`    Scrape failed: ${scrapeResult.error}`);
      prompt = FALLBACK_PROMPT
        .replace('{url}', entry.url)
        .replace('{existing_summary}', entry.quick_summary);
    }
  } else {
    console.log(`    Skipping scrape for non-scrapable URL: ${entry.url}`);
    prompt = FALLBACK_PROMPT
      .replace('{url}', entry.url)
      .replace('{existing_summary}', entry.quick_summary);
  }

  const anthropic = getClient();

  const message = await anthropic.messages.create({
    model: model || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const textContent = message.content.find(block => block.type === 'text');

  if (!textContent || textContent.type !== 'text') {
    throw new Error('Anthropic API returned no text content');
  }

  let result = textContent.text.trim();

  // Add a note if we couldn't scrape the content
  if (!scrapedSuccessfully) {
    result = result + '\n\n*[Summary based on cached data - original source could not be accessed]*';
  }

  return result;
}
