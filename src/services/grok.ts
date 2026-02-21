import { config } from '../config';
import { DatabaseEntry } from '../types';
import type { ToolType } from '../types/intake';

const GROK_PROMPT = `You have access to X.com posts. Access and summarize this X.com/Twitter post for the Crypto Grant Wire newsletter.

URL: {url}

Reference summary (may be outdated): {existing_summary}

Write a newsletter entry that is INFORMATIVE yet CONCISE. Format:

**[Organization/Project Name]** [action verb] [what happened with key details]. [Additional context, numbers, or requirements]. [Deadline/application info if available].

REQUIREMENTS:
- 3-5 sentences, roughly 75-150 words
- Lead with a strong action verb (announced, launched, opened, unveiled, allocated, distributed, published, released)
- Include ALL specific numbers: funding amounts, token quantities, number of recipients, ROI metrics, dates
- Include deadlines, eligibility requirements, and how to apply when mentioned
- Provide enough context that a reader understands WHY this matters for grant seekers
- No bullet points - write in flowing paragraphs
- No flowery language, but DO include substantive details
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

GOOD EXAMPLE:
**Optimism Grants Council** published its Season 8 impact analysis, reporting that 1.8M OP distributed to 12 projects generated $3.0M in attribution-adjusted TVL uplift with an ROI of $1.7 per OP token over a 56-day observation period. The full program approved 6.3M OP (~$2.2M) to 23 projects, with recipients mobilizing $1.6M in co-incentives. Top performers include Truemarkets ($4.8/OP ROI), Morpho (+$11.5M TVL), and PancakeSwap (+$6.9M TVL with $1.1M CAKE co-incentives).

BAD EXAMPLE (too vague):
**Optimism** released a grants report showing positive results. Several projects received funding and showed growth. More details available in the post.`;

interface GrokResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

// Default model if none specified - using reasoning variant for highest quality
const DEFAULT_GROK_MODEL = 'grok-4-1-fast-reasoning';

export async function summarizeWithGrok(entry: DatabaseEntry, model?: string): Promise<string> {
  const prompt = GROK_PROMPT
    .replace('{existing_summary}', entry.quick_summary)
    .replace('{url}', entry.url);

  const response = await fetch(`${config.apis.grok.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apis.grok.apiKey}`,
    },
    body: JSON.stringify({
      model: model || DEFAULT_GROK_MODEL,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grok API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as GrokResponse;
  
  if (!data.choices?.[0]?.message?.content) {
    throw new Error('Grok API returned empty response');
  }

  return data.choices[0].message.content.trim();
}

// Default model for scan prompts — uses Responses API with x_search tool
const DEFAULT_SCAN_MODEL = 'grok-4-1-fast';

// Response format for the /v1/responses endpoint
interface ResponsesAPIOutput {
  type: string;
  id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface ResponsesAPIResponse {
  id: string;
  output: ResponsesAPIOutput[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

export async function executeScanPrompt(
  promptText: string,
  options?: { model?: string; responseFormat?: string | null; toolType?: ToolType }
): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const model = options?.model || DEFAULT_SCAN_MODEL;

  let fullPrompt = promptText;
  if (options?.responseFormat) {
    fullPrompt += `\n\nRespond using this format:\n${options.responseFormat}`;
  }

  // Use the Responses API with x_search tool for real-time X.com scanning
  const baseUrl = config.apis.grok.baseUrl.replace(/\/v1$/, '');
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apis.grok.apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: fullPrompt }],
      tools: [{ type: options?.toolType || 'x_search' }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grok API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as ResponsesAPIResponse;

  // Extract text from the Responses API output
  let textContent = '';
  for (const item of data.output || []) {
    if (item.type === 'message' && item.content) {
      for (const block of item.content) {
        if (block.type === 'output_text' && block.text) {
          textContent += block.text;
        }
      }
    }
  }

  if (!textContent) {
    throw new Error('Grok Responses API returned empty text content');
  }

  const totalTokens = data.usage
    ? (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
    : undefined;

  return {
    content: textContent.trim(),
    model,
    tokensUsed: totalTokens,
  };
}

export function isXcomUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'x.com' || hostname === 'twitter.com'
      || hostname.endsWith('.x.com') || hostname.endsWith('.twitter.com');
  } catch {
    return false;
  }
}
