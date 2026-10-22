/**
 * API Provider Management — DB-backed credentials with env var fallback.
 *
 * getCachedProvider() is synchronous (reads from in-memory cache).
 * Any DB row takes precedence over env vars, including disabled rows and rows
 * with an empty key. This makes the dashboard's disable switch a real kill
 * switch instead of allowing callers to fall through to an environment key.
 */

import { getPool } from '../db';
import { config } from '../config';
import { thinkControl } from './ollama-think';

// ---- Types ----

export interface ProviderRow {
  id: string;
  provider: string;
  display_name: string;
  api_key: string;
  base_url: string | null;
  default_model: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProviderConfig {
  provider: string;
  display_name: string;
  api_key: string;
  base_url: string | null;
  default_model: string | null;
  enabled: boolean;
  source: 'db' | 'env';
}

// ---- Known providers + env-var fallback mapping ----

/**
 * Providers this process must never call, even when api_providers still holds
 * an enabled row and a key. The row is dropped from the cache and cannot be
 * upserted back into service.
 */
export const RETIRED_PROVIDERS = new Set(['anthropic']);

const PROVIDER_DEFAULTS: Record<string, { displayName: string; envKey: () => string; baseUrl: () => string | null; defaultModel: string | null }> = {
  grok: {
    displayName: 'Grok (xAI)',
    envKey: () => config.apis.grok.apiKey,
    baseUrl: () => config.apis.grok.baseUrl,
    defaultModel: 'grok-4.20-beta-0309-non-reasoning',
  },
  ollama: {
    displayName: 'Ollama Cloud',
    envKey: () => config.apis.ollama.apiKey,
    baseUrl: () => config.apis.ollama.baseUrl,
    defaultModel: config.apis.ollama.defaultModel,
  },
  firecrawl: {
    displayName: 'Firecrawl',
    envKey: () => config.apis.firecrawl.apiKey,
    baseUrl: () => config.apis.firecrawl.baseUrl,
    defaultModel: null,
  },
  perplexity: {
    displayName: 'Perplexity',
    envKey: () => process.env.PERPLEXITY_API_KEY || '',
    baseUrl: () => 'https://api.perplexity.ai',
    defaultModel: 'sonar-pro',
  },
  parallel: {
    displayName: 'Parallel (Search)',
    envKey: () => process.env.PARALLEL_API_KEY || '',
    baseUrl: () => 'https://api.parallel.ai',
    defaultModel: 'search',
  },
  resend: {
    displayName: 'Resend',
    envKey: () => config.email.resendApiKey,
    baseUrl: () => null,
    defaultModel: null,
  },
  telegram: {
    displayName: 'Telegram (Distribution)',
    envKey: () => config.telegram.botToken,
    baseUrl: () => null,
    defaultModel: null,
  },
  'telegram-intake': {
    displayName: 'Telegram (Intake)',
    envKey: () => config.telegramIntake.botToken,
    baseUrl: () => null,
    defaultModel: null,
  },
};

// ---- In-memory cache ----

function buildEnvProviderCache(): Map<string, ProviderConfig> {
  const cache = new Map<string, ProviderConfig>();

  for (const [key, def] of Object.entries(PROVIDER_DEFAULTS)) {
    if (RETIRED_PROVIDERS.has(key)) continue;
    cache.set(key, {
      provider: key,
      display_name: def.displayName,
      api_key: def.envKey(),
      base_url: def.baseUrl(),
      default_model: def.defaultModel,
      enabled: true,
      source: 'env',
    });
  }

  return cache;
}

// Seed from env immediately so synchronous callers are safe before the async
// startup refresh completes. A DB refresh replaces these entries atomically.
let providerCache: Map<string, ProviderConfig> = buildEnvProviderCache();

/** Return the raw cached state, including disabled providers, for settings UI. */
export function getProviderState(provider: string): ProviderConfig | null {
  if (RETIRED_PROVIDERS.has(provider)) return null;
  return providerCache.get(provider) || null;
}

/** True only when a DB row explicitly disables this provider. */
export function isProviderExplicitlyDisabled(provider: string): boolean {
  const cached = getProviderState(provider);
  return cached?.source === 'db' && !cached.enabled;
}

export function getCachedProvider(provider: string): ProviderConfig | null {
  if (provider === 'grok') {
    const override = llmProviderOverride();
    if (override) return override;
  }
  const cached = getProviderState(provider);
  return cached?.enabled ? cached : null;
}

/**
 * LLM_PROVIDER=ollama reroutes every caller of the 'grok' chat slot (classify,
 * decided-recheck, tag backfill, qualifiers) to Ollama Cloud's OpenAI-compatible
 * endpoint, ahead of the api_providers row. Default (unset or 'grok') changes
 * nothing. Key: WRO_OLLAMA_API_KEY. Model: LLM_OLLAMA_MODEL. Base URL:
 * LLM_OLLAMA_BASE_URL. Grok-only features (x_search / web_search Responses
 * calls) are not served by Ollama and will fail on this slot while it is set.
 */
export function llmProviderOverride(env: NodeJS.ProcessEnv = process.env): ProviderConfig | null {
  if ((env.LLM_PROVIDER || 'grok').trim().toLowerCase() !== 'ollama') return null;
  const apiKey = (env.WRO_OLLAMA_API_KEY || '').trim();
  if (!apiKey) return null;
  return {
    provider: 'grok',
    display_name: 'Ollama Cloud (LLM_PROVIDER=ollama)',
    api_key: apiKey,
    base_url: (env.LLM_OLLAMA_BASE_URL || 'https://ollama.com/v1').replace(/\/$/, ''),
    default_model: env.LLM_OLLAMA_MODEL || 'deepseek-v4.1-flash',
    enabled: true,
    source: 'env',
  };
}

export async function refreshProviderCache(): Promise<void> {
  const next = buildEnvProviderCache();

  // Overlay every DB row. Disabled or empty-key rows deliberately mask env.
  try {
    const pool = getPool();
    const { rows } = await pool.query<ProviderRow>(
      'SELECT id, provider, display_name, api_key, base_url, default_model, enabled, created_at, updated_at FROM api_providers'
    );

    for (const row of rows) {
      if (RETIRED_PROVIDERS.has(row.provider)) continue;
      next.set(row.provider, {
        provider: row.provider,
        display_name: row.display_name,
        api_key: row.api_key,
        base_url: row.base_url,
        default_model: row.default_model,
        enabled: row.enabled,
        source: 'db',
      });
    }
  } catch (err) {
    // Keep the last known cache. Rebuilding from env here could silently undo a
    // previously loaded DB kill switch during a transient database failure.
    console.error('[ApiProvider] Failed to load providers from DB (keeping cached state):', err);
    return;
  }

  providerCache = next;
}

// ---- Table setup ----

export async function ensureApiProviderTables(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_providers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      base_url TEXT,
      default_model TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // updated_at trigger
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'api_providers_updated_at'
      ) THEN
        CREATE OR REPLACE FUNCTION update_api_providers_updated_at()
        RETURNS TRIGGER AS $fn$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;

        CREATE TRIGGER api_providers_updated_at
          BEFORE UPDATE ON api_providers
          FOR EACH ROW
          EXECUTE FUNCTION update_api_providers_updated_at();
      END IF;
    END $$;
  `);
}

// ---- CRUD ----

export async function getAllProviders(): Promise<ProviderConfig[]> {
  // Force fresh load
  await refreshProviderCache();
  return Array.from(providerCache.values());
}

/** Blank, null, or a masked key means "leave the stored key alone". */
export function cleanProviderApiKey(apiKey: unknown): string {
  if (typeof apiKey !== 'string') return '';
  const trimmed = apiKey.trim();
  if (!trimmed || trimmed.startsWith('****')) return '';
  return trimmed;
}

/** Undefined, null, or blank means the column was omitted from the update. */
function omittedText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function upsertProvider(
  provider: string,
  data: { api_key?: string; base_url?: string | null; default_model?: string | null; enabled?: boolean; display_name?: string }
): Promise<ProviderConfig> {
  if (RETIRED_PROVIDERS.has(provider)) {
    throw new Error(`Provider ${provider} is retired and cannot be enabled`);
  }
  const pool = getPool();
  const defaults = PROVIDER_DEFAULTS[provider];
  const displayName = data.display_name || defaults?.displayName || provider;
  // Null parameters keep the stored row on update. A first insert still
  // receives the code default, because there is no stored value to keep.
  const baseUrl = omittedText(data.base_url);
  const defaultModel = omittedText(data.default_model);
  const enabled = typeof data.enabled === 'boolean' ? data.enabled : null;

  await pool.query(
    `INSERT INTO api_providers (provider, display_name, api_key, base_url, default_model, enabled)
     VALUES ($1, $2, $3, COALESCE($4, $7), COALESCE($5, $8), COALESCE($6, true))
     ON CONFLICT (provider) DO UPDATE SET
       display_name = COALESCE(NULLIF($2, ''), api_providers.display_name),
       api_key = CASE WHEN $3 = '' THEN api_providers.api_key ELSE $3 END,
       base_url = COALESCE($4, api_providers.base_url),
       default_model = COALESCE($5, api_providers.default_model),
       enabled = COALESCE($6, api_providers.enabled)`,
    [
      provider,
      displayName,
      cleanProviderApiKey(data.api_key),
      baseUrl,
      defaultModel,
      enabled,
      defaults?.baseUrl() ?? null,
      defaults?.defaultModel ?? null,
    ]
  );

  await refreshProviderCache();
  const updated = getProviderState(provider);
  if (!updated) throw new Error(`Provider cache missing after upsert: ${provider}`);
  return updated;
}

function isOllamaBase(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'ollama.com' || host.endsWith('.ollama.com');
  } catch {
    return false;
  }
}

/**
 * xAI exposes GET /v1/api-key. An Ollama base (the grok slot sometimes points
 * at ollama.com) has no such route. Probe the same OpenAI-compatible
 * /chat/completions path classification uses, with a one-token prompt.
 */
async function fetchGrokProbe(baseUrl: string, apiKey: string, model: string | null): Promise<Response> {
  if (isOllamaBase(baseUrl)) {
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'glm-5.2',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });
  }
  const root = baseUrl.replace(/\/v1$/, '');
  return fetch(`${root}/v1/api-key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

// ---- Connection test ----

export async function testProviderConnection(provider: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  if (RETIRED_PROVIDERS.has(provider)) {
    return { success: false, latencyMs: 0, error: 'Provider is disabled' };
  }
  const cached = getCachedProvider(provider);
  if (!cached || !cached.api_key) {
    return {
      success: false,
      latencyMs: 0,
      error: isProviderExplicitlyDisabled(provider) ? 'Provider is disabled' : 'No API key configured',
    };
  }

  const start = Date.now();

  try {
    switch (provider) {
      case 'grok': {
        const configured = (cached.base_url || 'https://api.x.ai/v1').replace(/\/$/, '');
        const res = await fetchGrokProbe(configured, cached.api_key, cached.default_model);
        if (res.status === 401 || res.status === 403) throw new Error('Invalid API key');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { success: true, latencyMs: Date.now() - start };
      }

      case 'firecrawl': {
        const baseUrl = cached.base_url || 'https://api.firecrawl.dev/v1';
        // Simple health check — scrape endpoint returns 402/400 without a URL, but proves auth
        const res = await fetch(`${baseUrl}/scrape`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cached.api_key}`,
          },
          body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }),
        });
        // 200 or 402 (credits exhausted) both prove the key is valid
        if (res.status === 401 || res.status === 403) throw new Error('Invalid API key');
        return { success: true, latencyMs: Date.now() - start };
      }

      case 'perplexity': {
        const res = await fetch('https://api.perplexity.ai/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cached.api_key}`,
          },
          body: JSON.stringify({
            model: 'sonar',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
        });
        if (res.status === 401 || res.status === 403) throw new Error('Invalid API key');
        return { success: true, latencyMs: Date.now() - start };
      }

      case 'resend': {
        const res = await fetch('https://api.resend.com/domains', {
          headers: { 'Authorization': `Bearer ${cached.api_key}` },
        });
        if (res.status === 401 || res.status === 403) throw new Error('Invalid API key');
        return { success: true, latencyMs: Date.now() - start };
      }

      case 'ollama': {
        const ollamaBase = cached.base_url || 'https://ollama.com/api';
        const res = await fetch(`${ollamaBase}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cached.api_key}`,
          },
          body: JSON.stringify({
            model: config.apis.ollama.defaultModel,
            messages: [{ role: 'user', content: 'Reply with the word pong.' }],
            stream: false,
            ...thinkControl(config.apis.ollama.defaultModel),
            options: { num_predict: 64 },
          }),
        });
        if (res.status === 401 || res.status === 403) throw new Error('Invalid API key');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { success: true, latencyMs: Date.now() - start };
      }

      case 'telegram':
      case 'telegram-intake': {
        const res = await fetch(`https://api.telegram.org/bot${cached.api_key}/getMe`);
        const data = await res.json() as { ok: boolean; description?: string };
        if (!data.ok) throw new Error(data.description || 'Invalid bot token');
        return { success: true, latencyMs: Date.now() - start };
      }

      default:
        return { success: false, latencyMs: 0, error: `Unknown provider: ${provider}` };
    }
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Connection failed',
    };
  }
}
