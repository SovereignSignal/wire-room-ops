import { getPool } from '../db';
/**
 * API Provider, Usage & Pricing Routes
 *
 * GET  /providers                    — list all providers (masked keys)
 * PUT  /providers/:provider          — upsert provider config
 * POST /providers/:provider/test     — test connection
 * GET  /usage/summary                — aggregated usage
 * GET  /usage/timeline               — daily rollup for charts
 * GET  /usage/recent                 — last N raw log entries
 * GET  /pricing                      — list all model pricing
 * PUT  /pricing/:provider/:model     — update pricing for a model
 */

import { Router, Request, Response } from 'express';
import { getAllProviders, upsertProvider, testProviderConnection } from '../services/api-provider';
import { getUsageSummary, getUsageTimeline, getRecentUsage, getModelPricing, upsertModelPricing } from '../services/api-usage';

const router = Router();

// Attribute only receipts and usage actually linked to an entry; no inferred lane ROI.
router.get('/usage/outcomes', async (_req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT se.scan_source AS source,
      COUNT(*)::int AS entries, COUNT(DISTINCT se.program_id)::int AS linked_programs,
      COUNT(*) FILTER (WHERE se.status = 'approved')::int AS approvals,
      COUNT(*) FILTER (WHERE se.actioned_by LIKE 'user:%' AND se.status IN ('approved','declined'))::int AS human_decisions,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM distribution_logs dl
        WHERE dl.entry_id = se.id AND dl.status = 'success'))::int AS published_entries,
      COALESCE(SUM(cost.amount),0)::float AS attributed_cost,
      COALESCE(SUM(cost.unpriced),0)::int AS unpriced_calls
      FROM scan_entries se LEFT JOIN LATERAL (
        SELECT SUM(estimated_cost_usd) AS amount,
          COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL) AS unpriced
        FROM api_usage_log WHERE entry_id = se.id
      ) cost ON true
      WHERE se.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY se.scan_source ORDER BY published_entries DESC, approvals DESC`);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Could not load source outcomes' }); }
});


const KNOWN_PROVIDERS = new Set(['grok', 'anthropic', 'ollama', 'firecrawl', 'perplexity', 'parallel', 'resend', 'telegram', 'telegram-intake']);

// GET /providers — list all providers (masked keys)
router.get('/providers', async (_req: Request, res: Response) => {
  try {
    const providers = await getAllProviders();
    const masked = providers.map(p => ({
      ...p,
      api_key: p.api_key ? (p.api_key.length > 8 ? '****' + p.api_key.slice(-4) : '****') : '',
    }));
    res.json(masked);
  } catch (error) {
    console.error('[Providers] Failed to list:', error);
    res.status(500).json({ error: 'Failed to list providers' });
  }
});

// PUT /providers/:provider — upsert provider config
router.put('/providers/:provider', async (req: Request, res: Response) => {
  const { provider } = req.params;
  if (!KNOWN_PROVIDERS.has(provider)) {
    res.status(400).json({ error: `Unknown provider: ${provider}` });
    return;
  }
  const { api_key, base_url, default_model, enabled, display_name } = req.body;

  // Skip masked values (user didn't change the key)
  const cleanKey = api_key && typeof api_key === 'string' && api_key.startsWith('****') ? undefined : api_key;

  try {
    const result = await upsertProvider(provider, {
      api_key: cleanKey,
      base_url,
      default_model,
      enabled,
      display_name,
    });
    res.json({
      ...result,
      api_key: result.api_key ? (result.api_key.length > 8 ? '****' + result.api_key.slice(-4) : '****') : '',
    });
  } catch (error) {
    console.error('[Providers] Failed to upsert:', error);
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

// POST /providers/:provider/test — test connection
router.post('/providers/:provider/test', async (req: Request, res: Response) => {
  if (!KNOWN_PROVIDERS.has(req.params.provider)) {
    res.status(400).json({ success: false, error: `Unknown provider: ${req.params.provider}` });
    return;
  }
  try {
    const result = await testProviderConnection(req.params.provider);
    res.json(result);
  } catch (error) {
    console.error('[Providers] Test failed:', error);
    res.status(500).json({ success: false, error: 'Test request failed' });
  }
});

// --- API Usage ---

// GET /usage/summary — aggregated usage
router.get('/usage/summary', async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const rows = await getUsageSummary({
      days,
      provider: req.query.provider as string | undefined,
      purpose: req.query.purpose as string | undefined,
      wire: req.query.wire as string | undefined,
    });
    res.json(rows);
  } catch (error) {
    console.error('[Usage] Summary failed:', error);
    res.status(500).json({ error: 'Failed to fetch usage summary' });
  }
});

// GET /usage/recent — last N raw log entries
router.get('/usage/recent', async (req: Request, res: Response) => {
  try {
    const rows = await getRecentUsage({
      limit: Number(req.query.limit) || 50,
      provider: req.query.provider as string | undefined,
    });
    res.json(rows);
  } catch (error) {
    console.error('[Usage] Recent failed:', error);
    res.status(500).json({ error: 'Failed to fetch recent usage' });
  }
});

// --- Model Pricing ---

// GET /pricing — list all model pricing
router.get('/pricing', async (_req: Request, res: Response) => {
  try {
    const rows = await getModelPricing();
    res.json(rows);
  } catch (error) {
    console.error('[Pricing] Failed to list:', error);
    res.status(500).json({ error: 'Failed to fetch pricing' });
  }
});

// PUT /pricing/:provider/:model — update pricing for a model
router.put('/pricing/:provider/:model', async (req: Request, res: Response) => {
  const { provider, model } = req.params;
  const { input_cost_per_1m, output_cost_per_1m, per_request_cost } = req.body;

  try {
    const result = await upsertModelPricing(provider, model, {
      input_cost_per_1m,
      output_cost_per_1m,
      per_request_cost,
    });
    res.json(result);
  } catch (error) {
    console.error('[Pricing] Failed to update:', error);
    res.status(500).json({ error: 'Failed to update pricing' });
  }
});

export { router as providerRouter };
