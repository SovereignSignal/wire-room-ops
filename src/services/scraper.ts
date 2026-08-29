import { sleep } from '../utils/async';
import { isSafeHttpUrl, safePublicFetch } from '../utils/ssrf';
import { logApiUsage } from './api-usage';
import { getCachedProvider, isProviderExplicitlyDisabled } from './api-provider';

const SHORTENER_UA = 'Mozilla/5.0 (compatible; WireRoomOps/1.0)';

export interface ScrapeResult {
  success: boolean;
  content: string;
  title?: string;
  url: string;
  resolvedUrl?: string;
  error?: string;
}

interface FirecrawlResponse {
  success: boolean;
  data?: {
    markdown?: string;
    content?: string;
    metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
    };
  };
  error?: string;
}

const RETRY_DELAYS = [1000, 2000, 4000];

// Common URL shorteners that need resolution
const URL_SHORTENERS = [
  't.co',
  'bit.ly',
  'tinyurl.com',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'short.link',
  'rb.gy',
];

// Check if URL is a shortened URL that needs resolution
export function isShortUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return URL_SHORTENERS.some(shortener => hostname === shortener || hostname.endsWith('.' + shortener));
  } catch {
    return false;
  }
}

// Resolve shortened URL to final destination. Every hop goes through
// safePublicFetch so a shortener cannot bounce into loopback/metadata.
export async function resolveUrl(url: string): Promise<string> {
  if (!isShortUrl(url)) {
    return url;
  }
  if (!isSafeHttpUrl(url)) {
    console.log(`    Blocked unsafe shortener URL: ${url}`);
    return url;
  }

  try {
    console.log(`    Resolving shortened URL: ${url}`);
    const response = await safePublicFetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': SHORTENER_UA },
    });
    if (!response) {
      console.log(`    Blocked SSRF hop resolving: ${url}`);
      return url;
    }
    if (response.url && response.url !== url) {
      console.log(`    Resolved to: ${response.url}`);
      return response.url;
    }
    return url;
  } catch {
    try {
      const response = await safePublicFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': SHORTENER_UA },
      });
      if (!response) {
        console.log(`    Blocked SSRF hop resolving: ${url}`);
        return url;
      }
      if (response.url && response.url !== url) {
        console.log(`    Resolved to: ${response.url}`);
        return response.url;
      }
    } catch {
      // Ignore secondary error
    }

    console.log(`    Could not resolve URL, using original: ${url}`);
    return url;
  }
}

// Extract and resolve all URLs from text content
export async function extractAndResolveUrls(text: string): Promise<Map<string, string>> {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const matches = text.match(urlRegex) || [];
  const urlMap = new Map<string, string>();

  for (const url of matches) {
    // Clean URL (remove trailing punctuation)
    const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
    if (!urlMap.has(cleanUrl)) {
      const resolved = await resolveUrl(cleanUrl);
      urlMap.set(cleanUrl, resolved);
    }
  }

  return urlMap;
}

export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  if (!isSafeHttpUrl(url)) {
    return {
      success: false,
      content: '',
      url,
      error: 'URL is not a safe public HTTP(S) target',
    };
  }

  const provider = getCachedProvider('firecrawl');
  if (!provider?.api_key) {
    return {
      success: false,
      content: '',
      url,
      error: isProviderExplicitlyDisabled('firecrawl')
        ? 'Firecrawl provider is disabled'
        : 'Firecrawl API key not configured',
    };
  }

  let lastError: string | null = null;

  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    try {
      const result = await scrapeWithFirecrawl(url);
      if (result.success) {
        return result;
      }
      lastError = result.error || 'Unknown error';
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';
    }

    if (attempt < RETRY_DELAYS.length - 1) {
      console.log(`  Scrape attempt ${attempt + 1} failed for ${url}, retrying...`);
      await sleep(RETRY_DELAYS[attempt]);
    }
  }

  return {
    success: false,
    content: '',
    url,
    error: lastError || 'All scrape attempts failed',
  };
}

async function scrapeWithFirecrawl(url: string): Promise<ScrapeResult> {
  if (!isSafeHttpUrl(url)) {
    return {
      success: false,
      content: '',
      url,
      error: 'URL is not a safe public HTTP(S) target',
    };
  }
  const provider = getCachedProvider('firecrawl');
  if (!provider?.api_key) throw new Error('Firecrawl provider unavailable');
  const apiKey = provider.api_key;
  const baseUrl = provider.base_url || 'https://api.firecrawl.dev/v1';
  const start = Date.now();

  const response = await fetch(`${baseUrl}/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 30000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logApiUsage({ provider: 'firecrawl', model: 'scrape', purpose: 'scrape', duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
    throw new Error(`Firecrawl API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as FirecrawlResponse;

  if (!data.success) {
    logApiUsage({ provider: 'firecrawl', model: 'scrape', purpose: 'scrape', duration_ms: Date.now() - start, success: false, error_message: data.error || 'unsuccessful' });
    return {
      success: false,
      content: '',
      url,
      error: data.error || 'Firecrawl returned unsuccessful response',
    };
  }

  const content = data.data?.markdown || data.data?.content || '';

  if (!content || content.trim().length < 50) {
    logApiUsage({ provider: 'firecrawl', model: 'scrape', purpose: 'scrape', duration_ms: Date.now() - start, success: false, error_message: 'empty content' });
    return {
      success: false,
      content: '',
      url,
      error: 'Firecrawl returned empty or insufficient content',
    };
  }

  logApiUsage({ provider: 'firecrawl', model: 'scrape', purpose: 'scrape', duration_ms: Date.now() - start });

  return {
    success: true,
    content: content.trim(),
    title: data.data?.metadata?.title,
    url: data.data?.metadata?.sourceURL || url,
  };
}

// Check if URL is likely to be scrapable (not behind auth, etc.)
export function isScrapableUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();

  // Skip URLs that typically require auth or are not scrapable
  const skipPatterns = [
    'linkedin.com/in/',
    'linkedin.com/posts/',
    'facebook.com/',
    'instagram.com/',
    'discord.gg/',
    'discord.com/invite/',
    't.me/',
    'telegram.me/',
  ];

  return !skipPatterns.some(pattern => lowerUrl.includes(pattern));
}

// Truncate content to fit within token limits (rough estimate: 4 chars per token)
export function truncateContent(content: string, maxTokens: number = 8000): string {
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) {
    return content;
  }

  // Try to cut at a paragraph boundary
  const truncated = content.slice(0, maxChars);
  const lastParagraph = truncated.lastIndexOf('\n\n');

  if (lastParagraph > maxChars * 0.8) {
    return truncated.slice(0, lastParagraph) + '\n\n[Content truncated...]';
  }

  return truncated + '\n\n[Content truncated...]';
}
