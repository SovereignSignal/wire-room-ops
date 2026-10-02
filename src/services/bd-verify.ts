/**
 * BD Opportunity verification — grounds a candidate in CURRENT REALITY before
 * it can qualify, so the qualifier stops trusting entry titles. Uses the
 * Parallel.ai Task API to research the claimed program/event and return whether it
 * is REAL and CURRENTLY ACTIVE, the most recent real activity date, a
 * one-sentence sourced status, a citation, and confidence.
 *
 * Read-only research. Contacts no one. Returns null on no-key / error / timeout
 * so the caller treats "unverified" as "does not qualify" (strict default).
 */
import { getCachedProvider } from './api-provider';
import { logApiUsage } from './api-usage';

const PARALLEL_BASE = 'https://api.parallel.ai';
const FIELD_BASIS_HEADER = 'field-basis-2025-11-25';

export interface BdVerifyInput {
  id: number;
  name: string;
  org?: string | null;
  url?: string | null;
}

export interface BdVerifyResult {
  id: number;
  is_real: boolean;
  currently_active: boolean;
  last_activity: string | null;
  status_summary: string | null;
  citationUrl: string | null;
  confidence: 'low' | 'medium' | 'high' | null;
}

function creds(): { apiKey?: string; baseUrl: string } {
  const p = getCachedProvider('parallel');
  return { apiKey: p?.api_key || undefined, baseUrl: p?.base_url || PARALLEL_BASE };
}

export function bdVerifyAvailable(): boolean {
  const p = getCachedProvider('parallel');
  return Boolean(p?.api_key);
}

const BD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_real', 'currently_active', 'last_activity', 'status_summary'],
  properties: {
    is_real: { type: 'boolean', description: 'true ONLY if this org/program/initiative and the claimed activity actually exist and are confirmable from sources; false if it looks fabricated, unverifiable, or a misread of a headline' },
    currently_active: { type: 'boolean', description: 'true ONLY if active, open, or freshly launched/changed within roughly the last 60 days as of today; false if it is an old program, a closed round, a past-grantee announcement, a recap, or a years-old initiative merely being mentioned' },
    last_activity: { type: 'string', description: 'the most recent REAL date or period of genuine activity from sources (e.g. "June 2026", "early 2024"), or "unknown"' },
    status_summary: { type: 'string', description: 'one sentence on the real current status as of today, strictly from sources, e.g. "Arbitrum STIP Round 2 ran in early 2024 and is closed; no active round currently"' },
  },
};

async function verifyOne(item: BdVerifyInput): Promise<BdVerifyResult | null> {
  const { apiKey, baseUrl } = creds();
  if (!apiKey) return null;
  const start = Date.now();
  const input = `Research the REAL, CURRENT status of the following as of today, strictly from sources. Do NOT infer from the title. Item: "${item.name}"${item.org ? ` (organization: ${item.org})` : ''}.${item.url ? ` A post about it was seen at: ${item.url}.` : ''}\nAnswer: (1) Is this program/initiative/event and its claimed activity actually real and confirmable? (2) Is it CURRENTLY active/open, or freshly launched or changed within the last ~60 days, OR is it an old/closed/recapped program merely being mentioned now? (3) What is the most recent REAL date of activity? (4) One-sentence current status from sources.`;

  try {
    const create = await fetch(`${baseUrl}/v1/tasks/runs`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', 'parallel-beta': FIELD_BASIS_HEADER },
      body: JSON.stringify({ input, processor: 'core-fast', task_spec: { output_schema: { type: 'json', json_schema: BD_SCHEMA } } }),
    });
    if (!create.ok) {
      logApiUsage({ provider: 'parallel', model: 'task-core', purpose: 'bd-verify', duration_ms: Date.now() - start, success: false, error_message: String(create.status) });
      return null;
    }
    const created = await create.json() as { run_id?: string };
    if (!created.run_id) return null;

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${baseUrl}/v1/tasks/runs/${created.run_id}/result?timeout=150`, {
        headers: { 'x-api-key': apiKey, 'parallel-beta': FIELD_BASIS_HEADER },
        signal: AbortSignal.timeout(170000),
      });
      if (res.status === 408) continue;
      if (!res.ok) return null;
      const data = await res.json() as {
        output?: { content?: Record<string, unknown>; basis?: Array<{ field?: string; confidence?: string; citations?: Array<{ url?: string }> }> };
      };
      logApiUsage({ provider: 'parallel', model: 'task-core', purpose: 'bd-verify', duration_ms: Date.now() - start });
      const content = data.output?.content || {};
      const basis = data.output?.basis || [];

      let citationUrl: string | null = null;
      let confidence: BdVerifyResult['confidence'] = null;
      for (const b of basis) {
        const url = (b.citations || [])[0]?.url || null;
        const isKey = b.field === 'currently_active' || b.field === 'is_real';
        if (url && (!citationUrl || isKey)) citationUrl = url;
        if (isKey && b.confidence) confidence = b.confidence as BdVerifyResult['confidence'];
        else if (!confidence && b.confidence) confidence = b.confidence as BdVerifyResult['confidence'];
      }
      const clean = (v: unknown): string | null => {
        const s = typeof v === 'string' ? v.trim() : null;
        return s && !['n/a', 'null', 'unknown'].includes(s.toLowerCase()) ? s : null;
      };
      return {
        id: item.id,
        is_real: (content as { is_real?: boolean }).is_real === true,
        currently_active: (content as { currently_active?: boolean }).currently_active === true,
        last_activity: clean((content as { last_activity?: unknown }).last_activity),
        status_summary: clean((content as { status_summary?: unknown }).status_summary),
        citationUrl,
        confidence,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function isUsableBdVerification(result: BdVerifyResult | null): result is BdVerifyResult {
  return Boolean(
    result
    && result.is_real === true
    && result.currently_active === true
    && result.status_summary
    && result.citationUrl
    && /^https:\/\//i.test(result.citationUrl)
    && (result.confidence === 'medium' || result.confidence === 'high')
  );
}

/** Verify a batch via per-item Parallel Tasks with bounded concurrency. */
export async function verifyBdOpportunities(
  items: BdVerifyInput[],
  opts: { concurrency?: number } = {},
): Promise<Array<BdVerifyResult | null>> {
  const limit = opts.concurrency || 6;
  const out: Array<BdVerifyResult | null> = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await verifyOne(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
