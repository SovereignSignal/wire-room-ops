/**
 * Scan Prompt Routes
 *
 * GET    /              — list all prompts (with last-run enrichment)
 * POST   /              — create a new prompt
 * PUT    /:id           — update a prompt
 * DELETE /:id           — delete a prompt
 * POST   /test          — test-run an unsaved prompt draft
 * POST   /review        — Claude-based prompt review with suggestions
 * POST   /:id/test      — test-run a saved prompt
 * POST   /:id/run       — run a saved prompt through the full intake pipeline
 */

import { Router, Request, Response } from 'express';
import { getPool, getAllScanPrompts, getScanPromptById, createScanPrompt, updateScanPrompt, deleteScanPrompt, getAllFeeds } from '../db';
import { rateLimit } from '../middleware/rate-limit';
import { isValidUuid } from '../utils/validation';
import { executeScanPrompt } from '../services/grok';
import { executePerplexityScan } from '../services/perplexity';
import { parseStructuredOutput } from '../services/intake';
import { reviewScanPrompt } from '../services/anthropic';
import { withRetry } from '../services/processor';
import { buildSubmission } from '../services/intake';
import { runDailyIntake } from '../jobs/daily-intake';
import { jobQueue } from '../services/job-queue';
import type { RawScanResult, ToolType } from '../types/intake';

const router = Router();

function normalizePromptLabPayload(body: Record<string, unknown>): {
  wire?: string;
  label?: string;
  promptText: string;
  responseFormat?: string | null;
  toolType: ToolType;
  model?: string;
  outputFormat?: 'text' | 'json';
  parsedResults?: RawScanResult[];
  testOutput?: string | null;
} {
  return {
    wire: typeof body.wire === 'string' ? body.wire : undefined,
    label: typeof body.label === 'string' ? body.label : undefined,
    promptText: typeof body.promptText === 'string' ? body.promptText.trim() : '',
    responseFormat: typeof body.responseFormat === 'string' ? body.responseFormat : undefined,
    toolType: body.toolType === 'web_search' ? 'web_search' : body.toolType === 'perplexity' ? 'perplexity' : 'x_search',
    model: typeof body.model === 'string' && body.model ? body.model : undefined,
    outputFormat: body.outputFormat === 'json' ? 'json' : 'text',
    parsedResults: Array.isArray(body.parsedResults) ? body.parsedResults as RawScanResult[] : undefined,
    testOutput: typeof body.testOutput === 'string' ? body.testOutput : undefined,
  };
}

async function executePromptLabTest(input: {
  promptText: string;
  responseFormat?: string | null;
  toolType: ToolType;
  model?: string;
  outputFormat?: 'text' | 'json';
  wire?: string;
}) {
  const result = await withRetry(() => {
    if (input.toolType === 'perplexity') {
      return executePerplexityScan(input.promptText, {
        model: input.model,
        responseFormat: input.responseFormat,
        outputFormat: input.outputFormat,
      });
    }
    return executeScanPrompt(input.promptText, {
      model: input.model,
      responseFormat: input.responseFormat,
      toolType: input.toolType,
    });
  });
  const parseHint = input.outputFormat === 'json' ? 'json' as const : undefined;
  const { results: parsedResults, strategy } = parseStructuredOutput(result.content, parseHint);
  return {
    success: true,
    content: result.content,
    parsedResults,
    parsedCount: parsedResults.length,
    parseStrategy: strategy,
    model: result.model,
    tokensUsed: result.tokensUsed,
  };
}

// GET / — list all prompts
router.get('/', async (req: Request, res: Response) => {
  const wire = req.query.wire as string | undefined;
  const active = req.query.active as string | undefined;
  const activeOnly = active === 'true' ? true : active === 'false' ? false : undefined;

  try {
    const prompts = await getAllScanPrompts(wire || undefined, activeOnly ?? undefined);

    // Enrich with last run timestamps from scan_entries
    const pool = getPool();
    const lastRunResult = await pool.query(
      `SELECT prompt_id, MAX(created_at) as last_run_at
       FROM scan_entries WHERE prompt_id IS NOT NULL
       GROUP BY prompt_id`
    );
    const lastRunMap = new Map<string, string>();
    for (const row of lastRunResult.rows) {
      lastRunMap.set(String(row.prompt_id), row.last_run_at);
    }

    const enriched = prompts.map((p: any) => ({
      ...p,
      lastRunAt: lastRunMap.get(p.id) || null,
    }));

    res.json(enriched);
  } catch (error) {
    console.error('Failed to fetch scan prompts:', error);
    res.status(500).json({ error: 'Failed to fetch scan prompts' });
  }
});

// POST / — create prompt
router.post('/', async (req: Request, res: Response) => {
  const { wire, label, promptText, responseFormat, isActive, sortOrder, toolType, variant, model, outputFormat, intent } = req.body;

  if (!wire || typeof wire !== 'string') {
    res.status(400).json({ error: 'wire is required' });
    return;
  }
  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: 'label is required' });
    return;
  }
  if (!promptText || typeof promptText !== 'string' || promptText.trim().length === 0) {
    res.status(400).json({ error: 'promptText is required and must be non-empty' });
    return;
  }
  if (toolType && !['x_search', 'web_search', 'perplexity'].includes(toolType)) {
    res.status(400).json({ error: 'toolType must be "x_search", "web_search", or "perplexity"' });
    return;
  }
  if (outputFormat && !['text', 'json'].includes(outputFormat)) {
    res.status(400).json({ error: 'outputFormat must be "text" or "json"' });
    return;
  }
  if (intent && !['discovery', 'canonical', 'signal'].includes(intent)) {
    res.status(400).json({ error: 'intent must be "discovery", "canonical", or "signal"' });
    return;
  }

  // Validate wire against feeds
  try {
    const feeds = await getAllFeeds();
    const validKeys = feeds.map(f => f.key);
    if (!validKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Valid: ${validKeys.join(', ')}` });
      return;
    }

    const prompt = await createScanPrompt({
      wire,
      label,
      promptText,
      responseFormat: responseFormat || undefined,
      isActive: isActive ?? true,
      sortOrder: typeof sortOrder === 'number' ? sortOrder : undefined,
      toolType: toolType || 'x_search',
      variant: variant || undefined,
      model: model || undefined,
      outputFormat: outputFormat || undefined,
      intent: intent || undefined,
    });

    res.json(prompt);
  } catch (error) {
    console.error('Failed to create scan prompt:', error);
    res.status(500).json({ error: 'Failed to create scan prompt' });
  }
});

// PUT /:id — update prompt
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid prompt ID' });
    return;
  }

  const { wire, label, promptText, responseFormat, isActive, sortOrder, toolType, variant, model, outputFormat, intent } = req.body;
  const updates: Record<string, any> = {};

  if (wire !== undefined) {
    // Validate wire against feeds
    const feeds = await getAllFeeds();
    const validKeys = feeds.map(f => f.key);
    if (!validKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Valid: ${validKeys.join(', ')}` });
      return;
    }
    updates.wire = wire;
  }
  if (label !== undefined) updates.label = label;
  if (promptText !== undefined) updates.promptText = promptText;
  if (responseFormat !== undefined) updates.responseFormat = responseFormat || null;
  if (isActive !== undefined) updates.isActive = isActive;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  if (variant !== undefined) updates.variant = variant;
  if (toolType !== undefined) {
    if (!['x_search', 'web_search', 'perplexity'].includes(toolType)) {
      res.status(400).json({ error: 'toolType must be "x_search", "web_search", or "perplexity"' });
      return;
    }
    updates.toolType = toolType;
  }
  if (model !== undefined) updates.model = model || null;
  if (outputFormat !== undefined) {
    if (!['text', 'json'].includes(outputFormat)) {
      res.status(400).json({ error: 'outputFormat must be "text" or "json"' });
      return;
    }
    updates.outputFormat = outputFormat;
  }
  if (intent !== undefined) {
    if (!['discovery', 'canonical', 'signal'].includes(intent)) {
      res.status(400).json({ error: 'intent must be "discovery", "canonical", or "signal"' });
      return;
    }
    updates.intent = intent;
  }

  try {
    const updated = await updateScanPrompt(id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    res.json(updated);
  } catch (error) {
    console.error('Failed to update scan prompt:', error);
    res.status(500).json({ error: 'Failed to update scan prompt' });
  }
});

// DELETE /:id — delete prompt
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid prompt ID' });
    return;
  }

  try {
    const deleted = await deleteScanPrompt(id);
    if (!deleted) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete scan prompt:', error);
    res.status(500).json({ error: 'Failed to delete scan prompt' });
  }
});

// POST /test — test-run an unsaved prompt draft
router.post('/test', async (req: Request, res: Response) => {
  if (!rateLimit('scan-prompt-test', 15, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many test requests. Max 15 per 5 minutes.' });
    return;
  }

  try {
    const payload = normalizePromptLabPayload(req.body || {});
    if (!payload.promptText) {
      res.status(400).json({ error: 'promptText is required' });
      return;
    }

    res.json(await executePromptLabTest(payload));
  } catch (error) {
    console.error('Scan prompt test failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Test run failed' });
  }
});

// POST /review — Claude-based prompt review
router.post('/review', async (req: Request, res: Response) => {
  if (!rateLimit('scan-prompt-review', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many review requests. Max 3 per 5 minutes.' });
    return;
  }

  try {
    const payload = normalizePromptLabPayload(req.body || {});
    if (!payload.promptText) {
      res.status(400).json({ error: 'promptText is required' });
      return;
    }

    const review = await reviewScanPrompt(payload);
    res.json(review);
  } catch (error) {
    console.error('Prompt review failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Prompt review failed' });
  }
});

// POST /:id/test — test-run a saved prompt
router.post('/:id/test', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid prompt ID' });
    return;
  }

  if (!rateLimit('scan-prompt-test', 15, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many test requests. Max 15 per 5 minutes.' });
    return;
  }

  try {
    const prompt = await getScanPromptById(id);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    res.json(await executePromptLabTest({
      promptText: prompt.promptText,
      responseFormat: prompt.responseFormat,
      toolType: prompt.toolType,
      model: prompt.model || undefined,
      outputFormat: prompt.outputFormat,
      wire: prompt.wire,
    }));
  } catch (error) {
    console.error('Scan prompt test failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Test run failed' });
  }
});

// POST /:id/run — run a saved prompt through full pipeline
router.post('/:id/run', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid prompt ID' });
    return;
  }

  if (!rateLimit(`scan-prompt-run-${id}`, 2, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'This prompt was recently run. Max 2 per 5 minutes.' });
    return;
  }

  try {
    const prompt = await getScanPromptById(id);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    // Execute the prompt
    const scanResult = await withRetry(
      () => {
        if (prompt.toolType === 'perplexity') {
          return executePerplexityScan(prompt.promptText, {
            model: prompt.model || undefined,
            responseFormat: prompt.responseFormat,
            outputFormat: prompt.outputFormat,
          });
        }
        return executeScanPrompt(prompt.promptText, {
          model: prompt.model || undefined,
          responseFormat: prompt.responseFormat,
          toolType: prompt.toolType,
        });
      },
      2
    );

    const parseHint = prompt.outputFormat === 'json' ? 'json' as const : undefined;
    const { results: parsed, strategy: parseStrategy } = parseStructuredOutput(scanResult.content, parseHint);
    const today = new Date().toISOString().split('T')[0];

    // Determine variant
    const VALID_VARIANTS = ['A', 'B', 'C', 'W', 'P', 'N', 'S'];
    const variant = (prompt.variant && VALID_VARIANTS.includes(prompt.variant)) ? prompt.variant : 'A';

    // Determine source
    const source =
      prompt.toolType === 'perplexity' ? 'perplexity' as const :
      prompt.toolType === 'web_search' ? 'web-search' as const
        : 'x-scan' as const;

    // Run through intake pipeline
    const pool = getPool();
    const submission = {
      wire: prompt.wire,
      promptVariant: variant as any,
      scanDate: today,
      source,
      results: parsed,
      promptId: prompt.id,
      rawOutput: scanResult.content,
      parseStrategy,
    };

    const intakeSummary = await runDailyIntake(pool, [submission]);

    console.log(`[PromptRun] "${prompt.label}" → ${parsed.length} parsed (${parseStrategy}), ${intakeSummary.newUnique} new, ${intakeSummary.highQualityCount} high quality`);

    res.json({
      success: true,
      parsedCount: parsed.length,
      parseStrategy,
      newUnique: intakeSummary.newUnique,
      duplicatesFound: intakeSummary.duplicatesFound,
      highQualityCount: intakeSummary.highQualityCount,
      model: scanResult.model || 'unknown',
    });
  } catch (error) {
    console.error('Scan prompt run failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Run failed' });
  }
});

export const scanPromptRouter = router;
