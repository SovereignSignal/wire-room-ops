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

Write a newsletter entry that is INFORMATIVE yet CONCISE. Format:

**[Organization/Project Name]** [action verb] [what happened with key details]. [Additional context, numbers, or requirements]. [Deadline/application info if available].

REQUIREMENTS:
- 3-5 sentences, roughly 75-150 words
- Lead with a strong action verb (announced, launched, opened, unveiled, allocated, distributed, published, released)
- Include ALL specific numbers from the content: funding amounts, token quantities, number of recipients/applicants, ROI metrics, percentages, dates
- Include deadlines, eligibility requirements, and how to apply when mentioned
- Provide enough context that a reader understands the significance for grant seekers
- No bullet points - write in flowing paragraphs
- Exclude: committee member names, lengthy historical background, detailed mechanism explanations
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

GOOD EXAMPLE:
**Cornaro Labs** released an analysis of the EU's nearly €600M commitment to crypto grants via the Digital Europe Programme. The first funded cohort selected 9 projects from 173 applications, distributing €29.5M total. Eligibility requires consortia of at least 3 independent entities from EU member states with demonstrated blockchain expertise. The next call focuses on DeFi infrastructure, with applications due September 25, 2025 via the EU Funding & Tenders Portal.

BAD EXAMPLE (too vague):
**Cornaro Labs** published a report on EU crypto funding. The report covers funded projects and how to apply. More details in the linked analysis.`;

// Fallback prompt when scraping fails
const FALLBACK_PROMPT = `Refine this summary for the Crypto Grant Wire newsletter.

URL: {url}
Existing summary: {existing_summary}

Write a newsletter entry that is INFORMATIVE yet CONCISE. Format:

**[Organization/Project Name]** [action verb] [what happened with key details]. [Additional context, numbers, or requirements]. [Deadline/application info if available].

REQUIREMENTS:
- 3-5 sentences, roughly 75-150 words
- Lead with a strong action verb (announced, launched, opened, unveiled, allocated, distributed, published, released)
- Include ALL specific numbers mentioned: funding amounts, token quantities, deadlines, dates
- Include deadlines, eligibility requirements, and how to apply when available
- Provide useful context for grant seekers
- No bullet points - write in flowing paragraphs
- Work with the information provided - do not say "unable to access"
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

GOOD EXAMPLE:
**Stellar Community Fund** opened Round 20 applications, offering grants up to $100K per project for ecosystem development tools and infrastructure. The program targets developers building on Stellar with working prototypes or established projects seeking expansion funding. Applications close February 5, 2026, with funding decisions announced in March. Apply via stellar.org/community-fund.

BAD EXAMPLE (too vague):
**Stellar** announced new grants are available. Developers can apply for funding. Check the website for details.`;

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
