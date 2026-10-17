/**
 * BD Opportunity Qualifier (P1 + P3 core).
 *
 * Scores BD/funder/ecosystem signals against the operator profile (three
 * service lines + ICP) and returns only the qualified ones. FIND + QUALIFY
 * ONLY — this module never contacts anyone and imports no send/distribution
 * path by construction.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';
import { DEFAULT_GROK_MODEL, chatCompletionExtras } from './grok';

export type FitLine = 'grant_program_ops' | 'ops_sales_bd' | 'governance_ops' | 'none';

export interface BdCandidate {
  id: number;
  name: string;
  description?: string | null;
  wire?: string | null;
  source_url?: string | null;
  classification?: string | null;
  org_type?: string | null;
  org_tier?: string | null;
  org_last_signal?: string | null;
  stakeholder_name?: string | null;
  stakeholder_role?: string | null;
  stakeholder_handle?: string | null;
}

export interface QualifiedOpportunity {
  id: number;
  qualified: boolean;
  fit_line: FitLine;
  org: string;
  pain: string;
  why_now: string;
  confidence: number;
  reason: string;
}

const FIT_LINES = new Set(['grant_program_ops', 'ops_sales_bd', 'governance_ops', 'none']);

/** Generic rubric used when no operator profile is configured. */
const DEFAULT_OPERATOR_PROFILE = 'The operator is a senior operator for funding ecosystems: grant program ops, ops/sales/BD, governance ops.';

const PROFILE_FILE = path.join(process.cwd(), 'config', 'bd-profile.local.md');

/**
 * The operator profile the qualifier reasons against: BD_PROFILE, else the
 * untracked config/bd-profile.local.md, else the generic default.
 */
export function loadOperatorProfile(): string {
  if (config.bdLeads.profile.trim()) return config.bdLeads.profile.trim();
  try {
    const fromFile = fs.readFileSync(PROFILE_FILE, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // No local profile file; fall through to the default.
  }
  return DEFAULT_OPERATOR_PROFILE;
}

export const OPERATOR_PROFILE = loadOperatorProfile();

function buildQualifyPrompt(candidates: BdCandidate[]): string {
  const lines = candidates.map((c, idx) => {
    const ctx = [
      c.org_type ? `org_type:${c.org_type}` : '',
      c.org_tier ? `tier:${c.org_tier}` : '',
      c.org_last_signal ? `recent:${c.org_last_signal}` : '',
      c.stakeholder_name ? `contact:${c.stakeholder_name} (${c.stakeholder_role || '?'})` : '',
    ].filter(Boolean).join(' | ');
    return `${idx + 1}. [ID:${c.id}] wire:${c.wire || '?'} class:${c.classification || '?'}\n   Name: "${c.name}"\n   Desc: "${(c.description || '').slice(0, 240)}"${ctx ? `\n   Context: ${ctx}` : ''}`;
  }).join('\n\n');

  return `You qualify business-development opportunities for the operator against the profile below. Be a STRICT gatekeeper: default NO, high bar. Most signals are NOT opportunities for the operator.

${OPERATOR_PROFILE}

For EACH numbered entry below, decide if it is a qualified BD opportunity for the operator. Return a JSON array only, no markdown, one object per entry, same ids:
[{"id":123,"qualified":true,"fit_line":"grant_program_ops","org":"Example Foundation","pain":"one sentence: the org-side work the operator would do","why_now":"one sentence: the dated trigger","confidence":78,"reason":"one short sentence: why it qualifies or not"}]

Rules: fit_line is exactly one of grant_program_ops | ops_sales_bd | governance_ops | none. If qualified is false, set fit_line to "none". confidence is 0-100. Keep pain and why_now to one sentence each. "org" is the funder/org the opportunity is about.

ENTRIES:
${lines}`;
}

/**
 * Qualify a list of candidate signals. One batched Grok call per `batchSize`
 * chunk. Returns one result per candidate it could score (missing ids simply
 * do not appear). Never writes, never contacts.
 */
export async function qualifyOpportunities(
  candidates: BdCandidate[],
  options?: { batchSize?: number; delayMs?: number },
): Promise<QualifiedOpportunity[]> {
  if (!candidates.length) return [];
  const batchSize = options?.batchSize || 20;
  const delayMs = options?.delayMs ?? 600;

  const provider = getCachedProvider('grok');
  const apiKey = provider?.api_key;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  const model = provider?.default_model || DEFAULT_GROK_MODEL;

  const out: QualifiedOpportunity[] = [];

  for (let i = 0; i < candidates.length; i += batchSize) {
    const chunk = candidates.slice(i, i + batchSize);
    const prompt = buildQualifyPrompt(chunk);
    const start = Date.now();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 6000, temperature: 0.1, ...chatCompletionExtras(baseUrl) }),
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logApiUsage({ provider: 'grok', model, purpose: 'bd-qualify', duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
        console.error(`[BdQualifier] Grok ${response.status} on chunk ${i}-${i + chunk.length}`);
        continue;
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      logApiUsage({ provider: 'grok', model, purpose: 'bd-qualify', duration_ms: Date.now() - start, tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens });
      const content = data.choices?.[0]?.message?.content;
      if (!content) continue;
      const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned) as Array<Record<string, unknown>>;
      for (const p of parsed) {
        const id = Number(p.id);
        if (!Number.isFinite(id)) continue;
        const fitRaw = String(p.fit_line || 'none');
        const fit = (FIT_LINES.has(fitRaw) ? fitRaw : 'none') as FitLine;
        const qualified = p.qualified === true && fit !== 'none';
        out.push({
          id,
          qualified,
          fit_line: qualified ? fit : 'none',
          org: String(p.org || ''),
          pain: String(p.pain || ''),
          why_now: String(p.why_now || ''),
          confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(p.confidence))) : 0,
          reason: String(p.reason || ''),
        });
      }
    } catch (err) {
      console.error('[BdQualifier] chunk failed:', err);
    }
    if (i + batchSize < candidates.length) await new Promise(r => setTimeout(r, delayMs));
  }
  return out;
}
