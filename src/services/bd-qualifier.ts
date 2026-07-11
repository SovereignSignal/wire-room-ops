/**
 * BD Opportunity Qualifier (P1 + P3 core).
 *
 * Scores BD/funder/ecosystem signals against Sov's consulting shape (three
 * service lines + ICP) and returns only the qualified ones. FIND + QUALIFY
 * ONLY — this module never contacts anyone and imports no send/distribution
 * path by construction.
 */
import { config } from '../config';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';

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

/** Sov's consulting shape — the rubric the qualifier reasons against (P1). */
export const SOV_SHAPE = `SOV is a senior operator-for-hire for funding ecosystems (vehicle: Consensus Consulting). He sells three service lines, each as a project, a fractional engagement, or a full-time role:
1. grant_program_ops — design, run, fix, or stand up grant programs. Proof: ran Gitcoin's grants program ($64M+ across 3,500+ projects), Uniswap Foundation Grants Manager, CoW grants committee, Cardano funding architecture, Optimism RetroPGF.
2. ops_sales_bd — operations, revenue, partnerships, GTM, ecosystem revenue models, P&L, professional-services offerings. Proof: ex-COO of a $50M company, secured $1M+ new revenue for Gitcoin, built partner programs across Optimism/Arbitrum/Base.
3. governance_ops — council/delegate systems, proposal process, governance-to-partnership. Proof: Optimism govNERDs Lead + Foundation liaison, ENS Public Goods Steward, delegate across Optimism/ENS/Scroll/Arbitrum, Sky/Maker.

IDEAL CLIENT (ICP): crypto, OSS, and AI foundations, DAOs, protocols, labs, and funders, treated EQUALLY with no ecosystem preference. He works WITH the orgs that RUN funding, programs, and governance (the funder/operator side). He is NOT for individual grant applicants, university professors' personal awards, generic scholarships, or off-domain orgs.

A signal QUALIFIES as a BD opportunity for Sov only when ALL of these hold:
- it is about an ORG in his ICP (a crypto/OSS/AI foundation, DAO, protocol, lab, or funder), not an individual, an academic award, or an off-domain org;
- it maps to a concrete need in ONE of his three lines (the org now has program/ops/BD/governance work that he does);
- there is a why-now: something just launched, opened, changed, restructured, a role opened, a lead departed, a fund/treasury landed, or a governance process broke, within roughly 30 days;
- there is a plausible path for Sov to be the operator (the org could hire or contract someone with his background).

Judge each signal ORGANICALLY on its own merits against the rules above. Do NOT favor or penalize any specific named organization, and do NOT carry an inclusion or exclusion list of orgs. Whatever appears in the wires that week is judged the same way.
QUALIFY examples (by TYPE, never specific orgs): a foundation or DAO actively running, launching, or expanding a grants program that needs an operator (grant_program_ops); an active governance change, council formation, or committee election (governance_ops); an org that just raised or launched a fund and needs ops/partnerships/GTM, or opened a senior ecosystem/BD/ops/governance role (ops_sales_bd).
DO-NOT-QUALIFY examples (by TYPE): an individual's academic award (e.g. a university professor's NSF grant) — no ICP org, no path; a startup's seed raise with no program/ops need; a one-off grant a recipient just won; generic news with no actionable org-side work.`;

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

  return `You qualify business-development opportunities for SOV against his consulting shape. Be a STRICT gatekeeper: default NO, high bar. Most signals are NOT opportunities for him.

${SOV_SHAPE}

For EACH numbered entry below, decide if it is a qualified BD opportunity for Sov. Return a JSON array only, no markdown, one object per entry, same ids:
[{"id":123,"qualified":true,"fit_line":"grant_program_ops","org":"Uniswap Foundation","pain":"one sentence: the org-side work Sov would do","why_now":"one sentence: the dated trigger","confidence":78,"reason":"one short sentence: why it qualifies or not"}]

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
  const apiKey = provider?.api_key || config.apis.grok.apiKey;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  const model = provider?.default_model || 'grok-4.20-beta-0309-non-reasoning';

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
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 6000, temperature: 0.1 }),
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
