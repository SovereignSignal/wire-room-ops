import { getCachedProvider } from './api-provider';

export interface ModelInfo {
  id: string;
  displayName: string;
  created: Date;
  provider: string;
}

interface GrokModelResponse {
  data: Array<{
    id: string;
    created: number;
    object: string;
    owned_by: string;
  }>;
}

interface AnthropicModelResponse {
  data: Array<{
    type: string;
    id: string;
    display_name: string;
    created_at: string;
  }>;
}

// Cache models for 1 hour
let grokModelsCache: { models: ModelInfo[]; fetchedAt: number } | null = null;
let anthropicModelsCache: { models: ModelInfo[]; fetchedAt: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function getGrokModels(): Promise<ModelInfo[]> {
  // Return cached if fresh
  if (grokModelsCache && Date.now() - grokModelsCache.fetchedAt < CACHE_TTL) {
    return grokModelsCache.models;
  }

  try {
    const provider = getCachedProvider('grok');
    const apiKey = provider?.api_key;
    if (!apiKey) return getDefaultGrokModels();
    const baseUrl = provider?.base_url || 'https://api.x.ai/v1';

    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch Grok models:', response.status);
      return grokModelsCache?.models || getDefaultGrokModels();
    }

    const data = await response.json() as GrokModelResponse;

    // Filter to text models only (exclude image/video generation models)
    const textModels = data.data
      .filter(m => !m.id.includes('image') && !m.id.includes('video') && !m.id.includes('vision'))
      .map(m => ({
        id: m.id,
        displayName: formatGrokModelName(m.id),
        created: new Date(m.created * 1000),
        provider: 'grok' as const,
      }))
      .sort((a, b) => b.created.getTime() - a.created.getTime());

    // Return top 5 most recent
    const topModels = textModels.slice(0, 5);

    grokModelsCache = { models: topModels, fetchedAt: Date.now() };
    return topModels;
  } catch (error) {
    console.error('Error fetching Grok models:', error);
    return grokModelsCache?.models || getDefaultGrokModels();
  }
}

export async function getAnthropicModels(): Promise<ModelInfo[]> {
  // Return cached if fresh
  if (anthropicModelsCache && Date.now() - anthropicModelsCache.fetchedAt < CACHE_TTL) {
    return anthropicModelsCache.models;
  }

  try {
    const provider = getCachedProvider('anthropic');
    const apiKey = provider?.api_key;
    if (!apiKey) return getDefaultAnthropicModels();

    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch Anthropic models:', response.status);
      return anthropicModelsCache?.models || getDefaultAnthropicModels();
    }

    const data = await response.json() as AnthropicModelResponse;

    const models = data.data
      .map(m => ({
        id: m.id,
        displayName: m.display_name,
        created: new Date(m.created_at),
        provider: 'anthropic' as const,
      }))
      .sort((a, b) => b.created.getTime() - a.created.getTime());

    // Return top 5 most recent
    const topModels = models.slice(0, 5);

    anthropicModelsCache = { models: topModels, fetchedAt: Date.now() };
    return topModels;
  } catch (error) {
    console.error('Error fetching Anthropic models:', error);
    return anthropicModelsCache?.models || getDefaultAnthropicModels();
  }
}

function formatGrokModelName(id: string): string {
  // Convert model ID to display name
  // e.g., "grok-4-1-fast-reasoning"        -> "Grok 4.1 Fast (Reasoning)"
  // e.g., "grok-4.20-beta-0309-non-reasoning" -> "Grok 4.20 Beta (Non-Reasoning)"
  const withoutPrefix = id.replace('grok-', '');
  const parts = withoutPrefix.split('-');

  let version = '';
  let suffix = '';
  let isBeta = false;

  for (const part of parts) {
    if (/^\d+\.\d+$/.test(part)) {
      // Dotted version like "4.20"
      version = part;
    } else if (/^\d+$/.test(part)) {
      version += (version ? '.' : '') + part;
    } else if (part === 'beta') {
      isBeta = true;
    } else if (part === 'fast') {
      suffix += ' Fast';
    } else if (part === 'mini') {
      suffix += ' Mini';
    } else if (part === 'reasoning') {
      suffix += ' (Reasoning)';
    } else if (part === 'non') {
      // Skip, handled with next part
    } else if (part === 'code') {
      suffix += ' Code';
    }
    // skip date stamps like "0309"
  }

  if (id.includes('non-reasoning')) {
    suffix = suffix.replace(' (Reasoning)', '') + ' (Non-Reasoning)';
  }
  if (isBeta) {
    suffix = ' Beta' + suffix;
  }

  return `Grok ${version}${suffix}`.trim();
}

function getDefaultGrokModels(): ModelInfo[] {
  return [
    { id: 'grok-4.20-beta-0309-non-reasoning', displayName: 'Grok 4.20 Beta (Non-Reasoning)', created: new Date(), provider: 'grok' },
    { id: 'grok-4.20-beta-0309-reasoning', displayName: 'Grok 4.20 Beta (Reasoning)', created: new Date(), provider: 'grok' },
    { id: 'grok-4-1-fast-reasoning', displayName: 'Grok 4.1 Fast (Reasoning)', created: new Date(), provider: 'grok' },
    { id: 'grok-4-1-fast-non-reasoning', displayName: 'Grok 4.1 Fast (Non-Reasoning)', created: new Date(), provider: 'grok' },
    { id: 'grok-3', displayName: 'Grok 3', created: new Date(), provider: 'grok' },
  ];
}

function getDefaultAnthropicModels(): ModelInfo[] {
  return [
    { id: 'claude-opus-4-1-20250805', displayName: 'Claude Opus 4.1', created: new Date(), provider: 'anthropic' },
    { id: 'claude-opus-4-20250514', displayName: 'Claude Opus 4', created: new Date(), provider: 'anthropic' },
    { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', created: new Date(), provider: 'anthropic' },
    { id: 'claude-haiku-3-5-20241022', displayName: 'Claude Haiku 3.5', created: new Date(), provider: 'anthropic' },
  ];
}

function getPerplexityModels(): ModelInfo[] {
  return [
    { id: 'sonar-deep-research', displayName: 'Sonar Deep Research', created: new Date('2025-02-01'), provider: 'perplexity' },
    { id: 'sonar-reasoning-pro', displayName: 'Sonar Reasoning Pro', created: new Date('2025-01-15'), provider: 'perplexity' },
    { id: 'sonar-pro', displayName: 'Sonar Pro', created: new Date('2025-01-01'), provider: 'perplexity' },
    { id: 'sonar', displayName: 'Sonar', created: new Date('2024-12-01'), provider: 'perplexity' },
  ];
}

function getOllamaModels(): ModelInfo[] {
  const provider = getCachedProvider('ollama');
  if (!provider?.api_key) return [];

  return [
    { id: 'kimi-k2.5:cloud', displayName: 'Kimi K2.5 (Cloud)', created: new Date('2025-07-01'), provider: 'ollama' },
    { id: 'qwen3:32b', displayName: 'Qwen3 32B (Cloud)', created: new Date('2025-05-01'), provider: 'ollama' },
    { id: 'llama4:scout', displayName: 'Llama 4 Scout (Cloud)', created: new Date('2025-04-01'), provider: 'ollama' },
  ];
}

export async function getAllModels(): Promise<Record<string, ModelInfo[]>> {
  const [grok, anthropic] = await Promise.all([
    getGrokModels(),
    getAnthropicModels(),
  ]);

  return { grok, anthropic, perplexity: getPerplexityModels(), ollama: getOllamaModels() };
}
