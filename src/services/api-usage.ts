/**
 * API Usage Tracking — append-only call log + query functions.
 *
 * logApiUsage() is fire-and-forget: callers do NOT await it.
 * Pricing is cached in-memory, refreshed on update.
 */

import { getPool } from '../db';

// ---- Types ----

export interface UsageLogParams {
  provider: string;
  model?: string;
  purpose: string;
  tokens_in?: number;
  tokens_out?: number;
  wire?: string;
  entry_id?: number;
  duration_ms: number;
  success?: boolean;
  error_message?: string;
}

export interface UsageSummaryRow {
  models: (string | null)[];
  provider: string;
  purpose: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  errors: number;
  unpriced_calls: number;
}

export interface UsageTimelineRow {
  bucket: string;
  provider: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
}

export interface ModelPricingRow {
  id: number;
  provider: string;
  model: string;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
  per_request_cost: number | null;
  updated_at: string;
}

// ---- In-memory pricing cache ----

let pricingCache: Map<string, { inputPer1M: number; outputPer1M: number; perRequest: number | null }> = new Map();

function pricingKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export async function refreshPricingCache(): Promise<void> {
  try {
    const pool = getPool();
    const { rows } = await pool.query('SELECT provider, model, input_cost_per_1m, output_cost_per_1m, per_request_cost FROM model_pricing');
    const next = new Map<string, { inputPer1M: number; outputPer1M: number; perRequest: number | null }>();
    for (const r of rows) {
      next.set(pricingKey(r.provider, r.model), {
        inputPer1M: parseFloat(r.input_cost_per_1m) || 0,
        outputPer1M: parseFloat(r.output_cost_per_1m) || 0,
        perRequest: r.per_request_cost != null ? parseFloat(r.per_request_cost) : null,
      });
    }
    pricingCache = next;
  } catch (err) {
    console.error('[ApiUsage] Failed to refresh pricing cache:', err);
  }
}

export function estimateCost(provider: string, model: string | undefined, tokensIn?: number, tokensOut?: number): number | null {
  if (!model) return null;
  const pricing = pricingCache.get(pricingKey(provider, model));
  if (!pricing) return null;

  if (pricing.perRequest != null) {
    return pricing.perRequest;
  }

  if (tokensIn == null && tokensOut == null) return null;
  const inCost = (tokensIn || 0) / 1_000_000 * pricing.inputPer1M;
  const outCost = (tokensOut || 0) / 1_000_000 * pricing.outputPer1M;
  return inCost + outCost;
}

// ---- Table setup ----

export async function ensureApiUsageTables(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_usage_log (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT,
      purpose TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      estimated_cost_usd NUMERIC(10,6),
      wire TEXT,
      entry_id INTEGER,
      duration_ms INTEGER NOT NULL,
      success BOOLEAN NOT NULL DEFAULT true,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Indexes (IF NOT EXISTS isn't supported for CREATE INDEX on all PG versions, use DO block)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_api_usage_provider_created') THEN
        CREATE INDEX idx_api_usage_provider_created ON api_usage_log(provider, created_at);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_api_usage_purpose') THEN
        CREATE INDEX idx_api_usage_purpose ON api_usage_log(purpose);
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_pricing (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_cost_per_1m NUMERIC(10,4) NOT NULL DEFAULT 0,
      output_cost_per_1m NUMERIC(10,4) NOT NULL DEFAULT 0,
      per_request_cost NUMERIC(10,6),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(provider, model)
    )
  `);

  // Seed default pricing
  const seeds = [
    ['grok', 'grok-4.20-beta-0309-non-reasoning', 2.0, 10.0, null],
    ['anthropic', 'claude-opus-4-1-20250805', 15.0, 75.0, null],
    ['anthropic', 'claude-sonnet-4-6', 3.0, 15.0, null],
    ['perplexity', 'sonar-pro', 3.0, 15.0, null],
    ['ollama', 'gpt-oss:120b', 0.50, 1.50, null],
    ['firecrawl', 'scrape', 0, 0, 0.01],
    ['resend', 'email', 0, 0, 0.001],
    ['parallel', 'search', 0, 0, 0.005],        // Parallel Search API: $5/1k requests
    ['twitter', 'timeline', 0, 0, 0.025],       // X API: ≤5 post-reads × $0.005
    ['twitter', 'user-lookup', 0, 0, 0.005],    // X API: 1 read (rare — cached after first)
  ];

  for (const [provider, model, inputCost, outputCost, perReq] of seeds) {
    await pool.query(
      `INSERT INTO model_pricing (provider, model, input_cost_per_1m, output_cost_per_1m, per_request_cost)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, model) DO NOTHING`,
      [provider, model, inputCost, outputCost, perReq]
    );
  }

  await refreshPricingCache();
}

// ---- Fire-and-forget logging ----

const pendingUsageWrites = new Set<Promise<void>>();
let usageWriteFailure: Error | null = null;
export async function flushUsageLogs(): Promise<void> {
  await Promise.all([...pendingUsageWrites]);
  if (usageWriteFailure) throw usageWriteFailure;
}

export function logApiUsage(params: UsageLogParams): void {
  const cost = estimateCost(params.provider, params.model, params.tokens_in, params.tokens_out);

  const pool = getPool();
  const write = pool.query(
    `INSERT INTO api_usage_log (provider, model, purpose, tokens_in, tokens_out, estimated_cost_usd, wire, entry_id, duration_ms, success, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      params.provider,
      params.model || null,
      params.purpose,
      params.tokens_in || null,
      params.tokens_out || null,
      cost,
      params.wire || null,
      params.entry_id ?? null,
      params.duration_ms,
      params.success ?? true,
      params.error_message || null,
    ]
  ).then(() => undefined).catch(err => {
    usageWriteFailure = new Error('Usage accounting unavailable; discovery paused until restart');
    console.error('[ApiUsage] Failed to log usage:', err.message);
  });
  pendingUsageWrites.add(write);
  void write.finally(() => pendingUsageWrites.delete(write));
}

// ---- Query functions ----

export async function getUsageSummary(opts: {
  days: number;
  provider?: string;
  purpose?: string;
  wire?: string;
}): Promise<UsageSummaryRow[]> {
  const pool = getPool();
  const days = Math.min(Math.max(opts.days, 1), 90);
  const params: (string | number)[] = [days];
  const conditions = [`created_at >= NOW() - make_interval(days => $1::int)`];

  if (opts.provider) {
    params.push(opts.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (opts.purpose) {
    params.push(opts.purpose);
    conditions.push(`purpose = $${params.length}`);
  }
  if (opts.wire) {
    params.push(opts.wire);
    conditions.push(`wire = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT
       provider,
       purpose,
       array_agg(DISTINCT model) AS models,
       COUNT(*)::int AS calls,
       COALESCE(SUM(tokens_in), 0)::int AS tokens_in,
       COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
       COALESCE(SUM(estimated_cost_usd), 0)::numeric AS estimated_cost_usd,
       COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unpriced_calls,
       COUNT(*) FILTER (WHERE NOT success)::int AS errors
     FROM api_usage_log
     WHERE ${conditions.join(' AND ')}
     GROUP BY provider, purpose
     ORDER BY estimated_cost_usd DESC`,
    params
  );

  return rows.map(r => ({
    ...r,
    estimated_cost_usd: parseFloat(r.estimated_cost_usd) || 0,
  }));
}

export async function getUsageTimeline(opts: {
  days: number;
  provider?: string;
  granularity?: 'hour' | 'day';
}): Promise<UsageTimelineRow[]> {
  const pool = getPool();
  // Strictly validated: only 'hour' or 'day' (no user input reaches SQL)
  const gran = opts.granularity === 'hour' ? 'hour' : 'day';
  const days = Math.min(Math.max(opts.days, 1), 90);
  const params: (string | number)[] = [days];
  const conditions = [`created_at >= NOW() - make_interval(days => $1::int)`];

  if (opts.provider) {
    params.push(opts.provider);
    conditions.push(`provider = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT
       date_trunc('${gran}', created_at) AS bucket,
       provider,
       COUNT(*)::int AS calls,
       COALESCE(SUM(tokens_in), 0)::int AS tokens_in,
       COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
       COALESCE(SUM(estimated_cost_usd), 0)::numeric AS estimated_cost_usd
     FROM api_usage_log
     WHERE ${conditions.join(' AND ')}
     GROUP BY bucket, provider
     ORDER BY bucket`,
    params
  );

  return rows.map(r => ({
    ...r,
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
    estimated_cost_usd: parseFloat(r.estimated_cost_usd) || 0,
  }));
}

export async function getRecentUsage(opts: {
  limit?: number;
  provider?: string;
}): Promise<any[]> {
  const pool = getPool();
  const limit = Math.min(opts.limit || 50, 200);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.provider) {
    params.push(opts.provider);
    conditions.push(`provider = $${params.length}`);
  }

  params.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT id, provider, model, purpose, tokens_in, tokens_out, estimated_cost_usd, wire, entry_id, duration_ms, success, error_message, created_at
     FROM api_usage_log
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return rows.map(r => ({
    ...r,
    estimated_cost_usd: r.estimated_cost_usd != null ? parseFloat(r.estimated_cost_usd) : null,
  }));
}

// ---- Model pricing CRUD ----

export async function getModelPricing(): Promise<ModelPricingRow[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, provider, model, input_cost_per_1m, output_cost_per_1m, per_request_cost, updated_at FROM model_pricing ORDER BY provider, model'
  );
  return rows.map(r => ({
    ...r,
    input_cost_per_1m: parseFloat(r.input_cost_per_1m) || 0,
    output_cost_per_1m: parseFloat(r.output_cost_per_1m) || 0,
    per_request_cost: r.per_request_cost != null ? parseFloat(r.per_request_cost) : null,
  }));
}

export async function upsertModelPricing(
  provider: string,
  model: string,
  data: { input_cost_per_1m?: number; output_cost_per_1m?: number; per_request_cost?: number | null }
): Promise<ModelPricingRow> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO model_pricing (provider, model, input_cost_per_1m, output_cost_per_1m, per_request_cost, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (provider, model) DO UPDATE SET
       input_cost_per_1m = COALESCE($3, model_pricing.input_cost_per_1m),
       output_cost_per_1m = COALESCE($4, model_pricing.output_cost_per_1m),
       per_request_cost = COALESCE($5, model_pricing.per_request_cost),
       updated_at = NOW()
     RETURNING id, provider, model, input_cost_per_1m, output_cost_per_1m, per_request_cost, updated_at`,
    [provider, model, data.input_cost_per_1m ?? 0, data.output_cost_per_1m ?? 0, data.per_request_cost ?? null]
  );

  await refreshPricingCache();

  return {
    ...rows[0],
    input_cost_per_1m: parseFloat(rows[0].input_cost_per_1m) || 0,
    output_cost_per_1m: parseFloat(rows[0].output_cost_per_1m) || 0,
    per_request_cost: rows[0].per_request_cost != null ? parseFloat(rows[0].per_request_cost) : null,
  };
}
