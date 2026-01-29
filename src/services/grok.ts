import { config } from '../config';
import { DatabaseEntry } from '../types';

const GROK_PROMPT = `Summarize this X.com post for a crypto grants newsletter.

Provide:
- 2-3 sentence factual summary (no flowery language)
- Key numbers (funding amounts, dates, deadlines)
- Organization/project names mentioned
- Any actionable details (applications, eligibility)

Keep tone neutral and factual. 
Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive.

Context from existing summary: {existing_summary}

URL: {url}`;

interface GrokResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export async function summarizeWithGrok(entry: DatabaseEntry): Promise<string> {
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
      model: 'grok-2-latest',
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
