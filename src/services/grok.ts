import { config } from '../config';
import { DatabaseEntry } from '../types';

const GROK_PROMPT = `You have access to X.com posts. Access and summarize this X.com/Twitter post for the Crypto Grant Wire newsletter.

URL: {url}

Reference summary (may be outdated): {existing_summary}

Write a CONCISE newsletter entry following this exact format:

**[Organization/Project Name]** announced/launched/opened [what happened], [key details with numbers]. [One more sentence with timeline, eligibility, or how to apply if relevant].

RULES:
- Keep it to 2-3 sentences MAX, around 50-75 words total
- Lead with an action verb (announced, launched, opened, unveiled, allocated, distributed)
- Include specific numbers inline (funding amounts, token quantities, deadlines)
- No bullet points, no separate sections
- No flowery language or filler words
- If there's a deadline or application link, include it naturally in the text
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

EXAMPLE OUTPUT:
**Stellar Community Fund** opened Round 20 applications, offering up to $100K per project for ecosystem development. Applications close February 5, 2026, with results announced in March.`;

interface GrokResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

// Default model if none specified
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

export function isXcomUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('x.com') || lowerUrl.includes('twitter.com');
}
