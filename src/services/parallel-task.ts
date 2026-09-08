/**
 * Parallel.ai Task API — deep, source-cited verification.
 *
 * Unlike the Search API (services/parallel.ts), the Task API researches a single
 * program against its official source and returns a STRUCTURED, CITED result:
 * is_open + corrected amount/deadline + a per-field citation URL and confidence
 * (low/medium/high). Used as the weekly newsletter's verify gate — every featured
 * item gets a real source + confidence instead of an LLM assertion.
 *
 * Per-item Task (processor 'core'), bounded concurrency, fails soft (null on error
 * so the caller can fall back to the Firecrawl verify path).
 */

import { getCachedProvider } from './api-provider';
import { logApiUsage } from './api-usage';

const PARALLEL_BASE = 'https://api.parallel.ai';
const FIELD_BASIS_HEADER = 'field-basis-2025-11-25';

export interface VerifyInput {
  name: string;
  funder?: string | null;
  amount?: string | null;
  deadline?: string | null;
  url: string;
}

export interface VerifyResult {
  is_open: boolean;
  amount: string | null;
  deadline: string | null;
  apply_url: string | null;
  citationUrl: string | null;
  confidence: 'low' | 'medium' | 'high' | null;
}

function creds(): { apiKey?: string; baseUrl: string } {
  const p = getCachedProvider('parallel');
  return { apiKey: p?.api_key || undefined, baseUrl: p?.base_url || PARALLEL_BASE };
}

export function parallelAvailable(): boolean {
  const p = getCachedProvider('parallel');
  return Boolean(p?.api_key);
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_open', 'amount', 'deadline', 'apply_url'],
  properties: {
    is_open: { type: 'boolean', description: 'true ONLY if this program is currently open and accepting applications as of today; false if closed, expired, past its deadline, a past-grantee announcement, or a recap' },
    amount: { type: 'string', description: 'funding amount or range stated on the official page, e.g. "up to $50,000", or "n/a"' },
    deadline: { type: 'string', description: 'application deadline (MM-DD-YYYY), "rolling", or "n/a", as stated on the official page' },
    apply_url: { type: 'string', description: 'canonical application or details URL on the official site' },
  },
};

async function verifyOne(item: VerifyInput, wire?: string): Promise<VerifyResult | null> {
  const { apiKey, baseUrl } = creds();
  if (!apiKey) return null;
  const start = Date.now();
  const input = `Verify this funding opportunity against its official source page and answer strictly from that page. Program: "${item.name}"${item.funder ? ` run by ${item.funder}` : ''}. Claimed amount: ${item.amount || 'n/a'}. Claimed deadline: ${item.deadline || 'n/a'}. Source URL: ${item.url}. Determine whether it is CURRENTLY OPEN and accepting applications right now, and correct the amount and deadline to exactly what the official page states.`;

  try {
    const create = await fetch(`${baseUrl}/v1/tasks/runs`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', 'parallel-beta': FIELD_BASIS_HEADER },
      body: JSON.stringify({ input, processor: 'core-fast', task_spec: { output_schema: { type: 'json', json_schema: VERIFY_SCHEMA } } }),
    });
    if (!create.ok) {
      logApiUsage({ provider: 'parallel', model: 'core-fast', purpose: 'weekly-verify', wire, duration_ms: Date.now() - start, success: false, error_message: String(create.status) });
      return null;
    }
    const created = await create.json() as { run_id?: string };
    if (!created.run_id) return null;

    // Long-poll the result (core: ~60s-5min). Re-poll on 408 ("still active").
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${baseUrl}/v1/tasks/runs/${created.run_id}/result?timeout=150`, {
        headers: { 'x-api-key': apiKey, 'parallel-beta': FIELD_BASIS_HEADER },
        signal: AbortSignal.timeout(170000),
      });
      if (res.status === 408) continue; // still running
      if (!res.ok) return null;
      const data = await res.json() as {
        output?: { content?: Record<string, unknown>; basis?: Array<{ field?: string; confidence?: string; citations?: Array<{ url?: string }> }> };
      };
      logApiUsage({ provider: 'parallel', model: 'core-fast', purpose: 'weekly-verify', wire, duration_ms: Date.now() - start });
      const content = data.output?.content || {};
      const basis = data.output?.basis || [];
      if (typeof content.is_open !== 'boolean') return null;

      // Prefer the citation + confidence backing the amount / apply_url claim.
      let citationUrl: string | null = null;
      let confidence: VerifyResult['confidence'] = null;
      for (const b of basis) {
        const url = (b.citations || [])[0]?.url || null;
        const isKey = b.field === 'amount' || b.field === 'apply_url' || b.field === 'is_open';
        if (url && (!citationUrl || isKey)) citationUrl = url;
        if (isKey && b.confidence) confidence = b.confidence as VerifyResult['confidence'];
        else if (!confidence && b.confidence) confidence = b.confidence as VerifyResult['confidence'];
      }
      const clean = (v: unknown): string | null => {
        const s = typeof v === 'string' ? v.trim() : null;
        return s && s.toLowerCase() !== 'n/a' && s.toLowerCase() !== 'null' ? s : null;
      };
      return {
        // Verification is a publication gate. Missing or malformed evidence is
        // unverified, never implicitly open.
        is_open: (content as { is_open?: boolean }).is_open === true,
        amount: clean((content as { amount?: unknown }).amount),
        deadline: clean((content as { deadline?: unknown }).deadline),
        apply_url: clean((content as { apply_url?: unknown }).apply_url) || item.url,
        citationUrl,
        confidence,
      };
    }
    return null; // timed out
  } catch {
    return null;
  }
}

/** Verify a batch of items via per-item Parallel Tasks with bounded concurrency. */
export async function verifyOpportunities(
  items: VerifyInput[],
  opts: { wire?: string; concurrency?: number } = {},
): Promise<Array<VerifyResult | null>> {
  const limit = opts.concurrency || 10;
  const out: Array<VerifyResult | null> = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await verifyOne(items[i], opts.wire);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
