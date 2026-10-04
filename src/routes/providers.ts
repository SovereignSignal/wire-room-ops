import { getPool } from '../db';
import { getDiscoveryCoverage } from '../services/discovery-coverage';
/**
 * API Provider, Usage & Pricing Routes
 *
 * GET  /providers                    — list all providers (masked keys)
 * PUT  /providers/:provider          — upsert provider config
 * POST /providers/:provider/test     — test connection
 * GET  /usage/summary                — aggregated usage (grouped by provider, purpose, job)
 * GET  /usage/timeline               — daily rollup for charts
 * GET  /usage/recent                 — last N raw log entries (created_at is ISO 8601)
 * GET  /pricing                      — list all model pricing
 * PUT  /pricing/:provider/:model     — update pricing for a model
 */

import { Router, Request, Response } from 'express';
import { getAllProviders, upsertProvider, testProviderConnection } from '../services/api-provider';
import { noteCuratorChange } from '../services/curator-audit';
import { getUsageSummary, getUsageTimeline, getRecentUsage, getModelPricing, upsertModelPricing, parseUsageJobQuery } from '../services/api-usage';

const router = Router();

router.get('/usage/coverage', async (_req, res) => {
  try { res.json(await getDiscoveryCoverage(getPool())); }
  catch { res.status(500).json({ error: 'Could not load discovery coverage' }); }
});

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


const KNOWN_PROVIDERS = new Set(['grok', 'ollama', 'firecrawl', 'perplexity', 'parallel', 'resend', 'telegram', 'telegram-intake']);

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

  try {
    const previous = (await getAllProviders()).find(row => row.provider === provider) || null;
    // Omitted base_url, default_model, and enabled stay on the stored row.
    // A blank or masked api_key also keeps the stored key.
    const result = await upsertProvider(provider, {
      api_key,
      base_url,
      default_model,
      enabled,
      display_name,
    });
    noteCuratorChange(res, {
      subject: `PUT /api/providers/${provider}`,
      old: previous ? { provider: previous.provider, enabled: previous.enabled, base_url: previous.base_url, default_model: previous.default_model, api_key: previous.api_key } : null,
      next: { provider, enabled: result.enabled, base_url: result.base_url, default_model: result.default_model, api_key: result.api_key },
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
    noteCuratorChange(res, { subject: `POST /api/providers/${req.params.provider}/test`, old: null, next: { provider: req.params.provider, success: result.success } });
    res.json(result);
  } catch (error) {
    console.error('[Providers] Test failed:', error);
    res.status(500).json({ success: false, error: 'Test request failed' });
  }
});

// --- API Usage ---

function usageJob(req: Request, res: Response): string | undefined | null {
  const parsed = parseUsageJobQuery(req.query.job);
  if (!parsed.ok) {
    res.status(400).json({ error: 'Invalid job filter' });
    return null;
  }
  return parsed.job;
}

// GET /usage/summary — aggregated usage, one row per provider + purpose + job
router.get('/usage/summary', async (req: Request, res: Response) => {
  try {
    const job = usageJob(req, res);
    if (job === null) return;
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const rows = await getUsageSummary({
      days,
      provider: req.query.provider as string | undefined,
      purpose: req.query.purpose as string | undefined,
      wire: req.query.wire as string | undefined,
      job,
    });
    res.json(rows);
  } catch (error) {
    console.error('[Usage] Summary failed:', error);
    res.status(500).json({ error: 'Failed to fetch usage summary' });
  }
});

// GET /usage/recent — last N raw log entries. created_at is an ISO 8601 string.
router.get('/usage/recent', async (req: Request, res: Response) => {
  try {
    const job = usageJob(req, res);
    if (job === null) return;
    const rows = await getRecentUsage({
      limit: Number(req.query.limit) || 50,
      provider: req.query.provider as string | undefined,
      job,
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
    const previous = (await getModelPricing()).find(row => row.provider === provider && row.model === model) || null;
    const result = await upsertModelPricing(provider, model, {
      input_cost_per_1m,
      output_cost_per_1m,
      per_request_cost,
    });
    noteCuratorChange(res, { subject: `PUT /api/pricing/${provider}/${model}`, old: previous, next: result });
    res.json(result);
  } catch (error) {
    console.error('[Pricing] Failed to update:', error);
    res.status(500).json({ error: 'Failed to update pricing' });
  }
});

export { router as providerRouter };
