import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { DatabaseEntry } from '../types';

const OPUS_PROMPT = `Refine the following summary for a crypto grants newsletter. The content is from: {url}

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
Do not start with "I cannot" or "Unable" - work with the provided summary content.
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

export async function summarizeWithOpus(entry: DatabaseEntry): Promise<string> {
  const prompt = OPUS_PROMPT
    .replace('{existing_summary}', entry.quick_summary)
    .replace('{url}', entry.url);

  const anthropic = getClient();
  
  const message = await anthropic.messages.create({
    model: 'claude-opus-4-5-20251101',
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

  return textContent.text.trim();
}
