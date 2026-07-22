import Anthropic from '@anthropic-ai/sdk';
import { getBrand } from '../config/brand';
import { DatabaseEntry } from '../types';
import { scrapeUrl, isScrapableUrl, truncateContent } from './scraper';
import type { RawScanResult, ToolType } from '../types/intake';
import { getAnthropicModels } from './models';
import { logApiUsage } from './api-usage';
import { getCachedProvider, isProviderExplicitlyDisabled } from './api-provider';

// Prompt builders — read brand at call time so env var overrides work without restart

function buildScrapedContentPrompt(): string {
  const brand = getBrand();
  return `Summarize this web page for the ${brand.name} newsletter.

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
- Provide enough context that a reader understands the significance for ${brand.audience}
- No bullet points - write in flowing paragraphs
- Exclude: committee member names, lengthy historical background, detailed mechanism explanations
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

GOOD EXAMPLE:
**Cornaro Labs** released an analysis of the EU's nearly €600M commitment to crypto grants via the Digital Europe Programme. The first funded cohort selected 9 projects from 173 applications, distributing €29.5M total. Eligibility requires consortia of at least 3 independent entities from EU member states with demonstrated blockchain expertise. The next call focuses on DeFi infrastructure, with applications due September 25, 2025 via the EU Funding & Tenders Portal.

BAD EXAMPLE (too vague):
**Cornaro Labs** published a report on EU crypto funding. The report covers funded projects and how to apply. More details in the linked analysis.`;
}

function buildFallbackPrompt(): string {
  const brand = getBrand();
  return `Refine this summary for the ${brand.name} newsletter.

URL: {url}
Existing summary: {existing_summary}

Write a newsletter entry that is INFORMATIVE yet CONCISE. Format:

**[Organization/Project Name]** [action verb] [what happened with key details]. [Additional context, numbers, or requirements]. [Deadline/application info if available].

REQUIREMENTS:
- 3-5 sentences, roughly 75-150 words
- Lead with a strong action verb (announced, launched, opened, unveiled, allocated, distributed, published, released)
- Include ALL specific numbers mentioned: funding amounts, token quantities, deadlines, dates
- Include deadlines, eligibility requirements, and how to apply when available
- Provide useful context for ${brand.audience}
- No bullet points - write in flowing paragraphs
- Work with the information provided - do not say "unable to access"
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

GOOD EXAMPLE:
**Stellar Community Fund** opened Round 20 applications, offering grants up to $100K per project for ecosystem development tools and infrastructure. The program targets developers building on Stellar with working prototypes or established projects seeking expansion funding. Applications close February 5, 2026, with funding decisions announced in March. Apply via stellar.org/community-fund.

BAD EXAMPLE (too vague):
**Stellar** announced new grants are available. Developers can apply for funding. Check the website for details.`;
}

let client: Anthropic | null = null;
let clientApiKey: string = '';

export function getClient(): Anthropic {
  const provider = getCachedProvider('anthropic');
  if (!provider?.api_key) {
    throw new Error(isProviderExplicitlyDisabled('anthropic')
      ? 'Anthropic provider is disabled'
      : 'Anthropic API key not configured');
  }
  const apiKey = provider.api_key;

  // Recreate client if key changed (e.g. switched from env to DB)
  if (!client || apiKey !== clientApiKey) {
    client = new Anthropic({ apiKey });
    clientApiKey = apiKey;
  }
  return client;
}

// Default model if none specified
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-1-20250805';
const PROMPT_REVIEW_MODEL_CANDIDATES = [
  'claude-opus-4-1-20250805',
  'claude-opus-4-1',
  'claude-opus-4-20250514',
  'claude-opus-4',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4',
  'claude-opus-4-5-20251101',
];

export interface PromptReviewResult {
  model: string;
  summary: string;
  overallScore: number;
  strengths: string[];
  risks: string[];
  suggestions: string[];
  revisedPromptText: string;
  revisedResponseFormat: string | null;
  expectedImprovements: string[];
}

function extractTextContent(message: Anthropic.Messages.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

function normalizeReviewResult(raw: Record<string, unknown>, model: string): PromptReviewResult {
  return {
    model,
    summary: typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim()
      : 'Claude did not provide a summary.',
    overallScore: Math.max(0, Math.min(100, Number(raw.overallScore) || 0)),
    strengths: normalizeStringList(raw.strengths),
    risks: normalizeStringList(raw.risks),
    suggestions: normalizeStringList(raw.suggestions),
    revisedPromptText: typeof raw.revisedPromptText === 'string' ? raw.revisedPromptText.trim() : '',
    revisedResponseFormat: typeof raw.revisedResponseFormat === 'string'
      ? (raw.revisedResponseFormat.trim() || null)
      : null,
    expectedImprovements: normalizeStringList(raw.expectedImprovements),
  };
}

async function resolvePreferredAnthropicModel(explicitModel?: string): Promise<string[]> {
  const ordered = explicitModel
    ? [explicitModel, ...PROMPT_REVIEW_MODEL_CANDIDATES.filter(model => model !== explicitModel)]
    : [...PROMPT_REVIEW_MODEL_CANDIDATES];

  try {
    const available = await getAnthropicModels();
    if (!available.length) return ordered;

    const availableIds = available.map(model => model.id);
    const preferredAvailable = ordered.filter(model => availableIds.includes(model));
    const fallbackAvailable = availableIds.filter(model => !preferredAvailable.includes(model));
    return [...preferredAvailable, ...fallbackAvailable];
  } catch {
    return ordered;
  }
}

export async function createMessageWithFallback(
  content: string,
  options?: { model?: string; maxTokens?: number; purpose?: string }
): Promise<{ model: string; text: string; usage?: { input_tokens: number; output_tokens: number } }> {
  const anthropic = getClient();
  const candidateModels = await resolvePreferredAnthropicModel(options?.model);
  const maxTokens = options?.maxTokens || 1200;
  const purpose = options?.purpose || 'summarize';
  let lastError: unknown;

  for (const model of candidateModels) {
    const start = Date.now();
    try {
      const message = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      });

      const text = extractTextContent(message);
      if (!text) {
        throw new Error('Anthropic API returned no text content');
      }

      const usage = message.usage ? { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens } : undefined;
      logApiUsage({
        provider: 'anthropic', model: message.model || model, purpose,
        duration_ms: Date.now() - start,
        tokens_in: usage?.input_tokens, tokens_out: usage?.output_tokens,
      });

      return { model: message.model || model, text, usage };
    } catch (error) {
      logApiUsage({
        provider: 'anthropic', model, purpose,
        duration_ms: Date.now() - start, success: false,
        error_message: error instanceof Error ? error.message : String(error),
      });
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('model') ||
        message.includes('not found') ||
        message.includes('invalid_request_error')
      ) {
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Anthropic API call failed');
}

function buildPromptReviewRequest(params: {
  wire?: string;
  label?: string;
  toolType: ToolType;
  promptText: string;
  responseFormat?: string | null;
  testOutput?: string | null;
  parsedResults?: RawScanResult[];
}): string {
  const parsedPreview = (params.parsedResults || [])
    .slice(0, 8)
    .map((result, index) => ({
      index: index + 1,
      name: result.name,
      amount: result.amount,
      deadline: result.deadline,
      sourceUrl: result.sourceUrl,
      description: result.description,
    }));

  const brand = getBrand();
  return `You are reviewing a ${brand.name} scan prompt used to discover high-signal ${brand.contentType}.

Your job:
1. Evaluate whether the prompt is likely to return actionable, current, high-quality opportunities.
2. Evaluate whether the output is easy to parse into structured entries with fields like name, description, amount, deadline, and source URL.
3. If test output is provided, judge the actual yield, not just the prompt wording.
4. Recommend a sharper version of the prompt and response format.

Evaluation criteria:
- High signal over noise
- Actionable opportunities over general news
- Strong inclusion and exclusion guidance
- Good fit for the selected tool
- Parseable, structured output
- Avoid duplicate-prone vague searches
- Avoid under-specified prompts that miss deadlines, amounts, or application details

Selected feed: ${params.wire || 'unknown'}
Prompt label: ${params.label || 'Untitled'}
Tool type: ${params.toolType}

Current prompt text:
${params.promptText}

Current response format:
${params.responseFormat || '(none)'}

Latest test output:
${params.testOutput || '(no test output supplied)'}

Parsed results preview:
${parsedPreview.length ? JSON.stringify(parsedPreview, null, 2) : '[]'}

Return strict JSON with exactly these keys:
{
  "summary": "one short paragraph",
  "overallScore": 0,
  "strengths": ["..."],
  "risks": ["..."],
  "suggestions": ["..."],
  "revisedPromptText": "full improved prompt text",
  "revisedResponseFormat": "full improved response format or empty string if not needed",
  "expectedImprovements": ["..."]
}

Rules:
- Keep overallScore between 0 and 100.
- revisedPromptText must be production-ready, not commentary.
- Suggestions must be concrete and specific to this prompt.
- If the current response format is good, you may keep it with minor edits.
- Do not wrap the JSON in markdown fences.`;
}

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
      prompt = buildScrapedContentPrompt()
        .replace('{url}', entry.url)
        .replace('{scraped_content}', truncatedContent)
        .replace('{existing_summary}', entry.quick_summary);
      scrapedSuccessfully = true;
    } else {
      console.log(`    Scrape failed: ${scrapeResult.error}`);
      prompt = buildFallbackPrompt()
        .replace('{url}', entry.url)
        .replace('{existing_summary}', entry.quick_summary);
    }
  } else {
    console.log(`    Skipping scrape for non-scrapable URL: ${entry.url}`);
    prompt = buildFallbackPrompt()
      .replace('{url}', entry.url)
      .replace('{existing_summary}', entry.quick_summary);
  }

  const anthropicProvider = getCachedProvider('anthropic');
  const { text } = await createMessageWithFallback(prompt, {
    model: model || anthropicProvider?.default_model || DEFAULT_ANTHROPIC_MODEL,
    maxTokens: 500,
    purpose: 'summarize',
  });

  let result = text;

  // Add a note if we couldn't scrape the content
  if (!scrapedSuccessfully) {
    result = result + '\n\n*[Summary based on cached data - original source could not be accessed]*';
  }

  return result;
}

export async function reviewScanPrompt(params: {
  wire?: string;
  label?: string;
  toolType: ToolType;
  promptText: string;
  responseFormat?: string | null;
  testOutput?: string | null;
  parsedResults?: RawScanResult[];
  model?: string;
}): Promise<PromptReviewResult> {
  const request = buildPromptReviewRequest(params);
  const { model, text } = await createMessageWithFallback(request, {
    model: params.model,
    maxTokens: 1800,
    purpose: 'prompt-review',
  });

  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error('Claude review returned an invalid response');
  }

  return normalizeReviewResult(parsed, model);
}
