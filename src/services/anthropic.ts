import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { DatabaseEntry } from '../types';

const OPUS_PROMPT = `Summarize this webpage for a crypto grants newsletter.

Extract:
- Organization/project making the announcement
- What action or announcement is being made
- Key numbers (funding amounts, allocations, deadlines)
- Actionable details (how to apply, eligibility, timeline)

Provide a 2-3 sentence summary in factual, neutral tone.

Exclude:
- Committee member names
- Historical background
- Process descriptions
- Mechanism explanations

Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive.

Context from existing summary: {existing_summary}

URL: {url}`;

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
    model: 'claude-sonnet-4-20250514',
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
