/**
 * API Provider Management — DB-backed credentials with env var fallback.
 *
 * getCachedProvider() is synchronous (reads from in-memory cache).
 * If a DB row exists with a non-empty api_key, it takes precedence over env vars.
 */

import { getPool } from '../db';
import { config } from '../config';

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

const PROVIDER_DEFAULTS: Record<string, { displayName: string; envKey: () => string; baseUrl: () => string | null; defaultModel: string | null }> = {
  grok: {
    displayName: 'Grok (xAI)',
    envKey: () => config.apis.grok.apiKey,
    baseUrl: () => config.apis.grok.baseUrl,
    defaultModel: 'grok-4.20-beta-0309-non-reasoning',
  },
  anthropic: {
    displayName: 'Claude (Anthropic)',
    envKey: () => config.apis.anthropic.apiKey,
    baseUrl: () => null,
    defaultModel: 'claude-opus-4-1-20250805',
  },
  ollama: {
    displayName: 'Ollama Cloud',
    envKey: () => config.apis.ollama.apiKey,
    baseUrl: () => config.apis.ollama.baseUrl,
    defaultModel: 'kimi-k2.5:cloud',
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

let providerCache: Map<string, ProviderConfig> = new Map();

export function getCachedProvider(provider: string): ProviderConfig | null {
  return providerCache.get(provider) || null;
}

export async function refreshProviderCache(): Promise<void> {
  const next = new Map<string, ProviderConfig>();

  // Start with env var defaults for all known providers
  for (const [key, def] of Object.entries(PROVIDER_DEFAULTS)) {
    next.set(key, {
      provider: key,
      display_name: def.displayName,
      api_key: def.envKey(),
      base_url: def.baseUrl(),
      default_model: def.defaultModel,
      enabled: true,
      source: 'env',
    });
  }

  // Overlay DB rows (non-empty api_key wins)
  try {
    const pool = getPool();
    const { rows } = await pool.query<ProviderRow>(
      'SELECT id, provider, display_name, api_key, base_url, default_model, enabled, created_at, updated_at FROM api_providers'
    );

    for (const row of rows) {
      if (row.api_key) {
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
    }
  } catch (err) {
    console.error('[ApiProvider] Failed to load providers from DB (using env vars):', err);
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

export async function upsertProvider(
  provider: string,
  data: { api_key?: string; base_url?: string | null; default_model?: string | null; enabled?: boolean; display_name?: string }
): Promise<ProviderConfig> {
  const pool = getPool();
  const defaults = PROVIDER_DEFAULTS[provider];
  const displayName = data.display_name || defaults?.displayName || provider;

  await pool.query(
    `INSERT INTO api_providers (provider, display_name, api_key, base_url, default_model, enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider) DO UPDATE SET
       display_name = COALESCE(NULLIF($2, ''), api_providers.display_name),
       api_key = CASE WHEN $3 = '' THEN api_providers.api_key ELSE $3 END,
       base_url = COALESCE($4, api_providers.base_url),
       default_model = COALESCE($5, api_providers.default_model),
       enabled = $6`,
    [
      provider,
      displayName,
      data.api_key || '',
      data.base_url ?? defaults?.baseUrl() ?? null,
      data.default_model ?? defaults?.defaultModel ?? null,
      data.enabled ?? true,
    ]
  );

  await refreshProviderCache();
  return providerCache.get(provider)!;
}

// ---- Connection test ----

export async function testProviderConnection(provider: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const cached = getCachedProvider(provider);
  if (!cached || !cached.api_key) {
    return { success: false, latencyMs: 0, error: 'No API key configured' };
  }

  const start = Date.now();

  try {
    switch (provider) {
      case 'grok': {
        const baseUrl = (cached.base_url || 'https://api.x.ai/v1').replace(/\/v1$/, '');
        const res = await fetch(`${baseUrl}/v1/api-key`, {
          headers: { 'Authorization': `Bearer ${cached.api_key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { success: true, latencyMs: Date.now() - start };
      }

      case 'anthropic': {
        // Lightweight models list call
        const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
          headers: {
            'x-api-key': cached.api_key,
            'anthropic-version': '2023-06-01',
          },
        });
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
            model: cached.default_model || 'kimi-k2.5:cloud',
            messages: [{ role: 'user', content: 'ping' }],
            stream: false,
            options: { num_predict: 1 },
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
