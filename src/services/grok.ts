import { config } from '../config';
import { DatabaseEntry } from '../types';

const GROK_PROMPT = `You have access to X.com posts. Please access and summarize the following X.com/Twitter post for a crypto grants newsletter.

URL to access: {url}

For reference, here is a preliminary summary that may be incomplete or outdated:
{existing_summary}

Please access the actual post and provide:
- The organization or project name as a clear title
- 2-3 sentence factual summary of the actual post content (no flowery language)
- Key numbers (funding amounts, dates, deadlines)
- Any actionable details (how to apply, eligibility, timeline)

Keep tone neutral and factual.
Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive.
Do not start with "Unable" or "I cannot" - always provide the organization name first.`;

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
