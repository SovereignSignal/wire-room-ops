import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { DatabaseEntry } from '../types';
import { scrapeUrl, isScrapableUrl, truncateContent } from './scraper';

// Prompt when we have scraped content
const SCRAPED_CONTENT_PROMPT = `Summarize the following web page content for a crypto grants newsletter.

URL: {url}

Page Content:
{scraped_content}

For additional context, here is a preliminary summary (may be outdated):
{existing_summary}

Provide:
- Start with the organization or project name as a clear identifier
- 2-3 sentence factual summary (no flowery language)
- Key numbers (funding amounts, allocations, deadlines)
- Actionable details (how to apply, eligibility, timeline)

Keep tone neutral and factual.

Exclude: committee member names, historical background, process descriptions, mechanism explanations.

Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive.
Always lead with the organization name, not a disclaimer.`;

// Fallback prompt when scraping fails
const FALLBACK_PROMPT = `Refine the following summary for a crypto grants newsletter. The content is from: {url}

Note: Unable to access the original URL content directly. Working from existing summary only.

Existing summary to improve:
{existing_summary}

Based on this information, provide:
- Start with the organization or project name as a clear identifier
- 2-3 sentence factual summary (no flowery language)
- Key numbers (funding amounts, allocations, deadlines)
- Actionable details (how to apply, eligibility, timeline)

Keep tone neutral and factual.

Exclude: committee member names, historical background, process descriptions, mechanism explanations.

Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive.
Always lead with the organization name, not a disclaimer.`;

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
