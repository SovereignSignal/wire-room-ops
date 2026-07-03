/**
 * Weekly BD leads job.
 *
 * Finds + qualifies + verifies BD opportunities from the last N days of
 * relationship_signal entries, dedups by org, and writes the verified ones into
 * the Notion "Leads" list in Sov's CRM as Status=Lead. FIND + QUALIFY ONLY:
 * never contacts anyone, never creates Opps. Folded into the daily-digest run
 * and gated to Wednesday by the scheduler — no new cron.
 */
import type { Pool } from 'pg';
import { qualifyOpportunities, BdCandidate, QualifiedOpportunity } from '../services/bd-qualifier';
import { verifyBdOpportunities, bdVerifyAvailable, BdVerifyInput, BdVerifyResult } from '../services/bd-verify';
import { writeLeadsToNotion, LeadRecord } from '../services/bd-leads-notion';

const LINE_LABEL: Record<string, string> = {
  grant_program_ops: 'Grants-ops',
  ops_sales_bd: 'Ops/Sales/BD',
  governance_ops: 'Governance',
};
const confRank = (c?: string | null): number => (c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0);

export interface BdLeadsResult {
  signals: number;
  shapeFit: number;
  verified: number;
  unique: number;
  created: number;
  skipped: number;
  message: string;
}

export async function runBdLeads(pool: Pool, opts: { days?: number } = {}): Promise<BdLeadsResult> {
  const days = opts.days ?? 7;
  const out: BdLeadsResult = { signals: 0, shapeFit: 0, verified: 0, unique: 0, created: 0, skipped: 0, message: '' };

  const { rows } = await pool.query(
    `SELECT id, name, description, wire, source_url, classification
     FROM scan_entries
     WHERE metadata->>'operator_route' = 'relationship_signal'
       AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
     ORDER BY created_at DESC`,
    [days],
  );
  const candidates: BdCandidate[] = rows.map((r: Record<string, unknown>) => ({
    id: r.id as number, name: r.name as string, description: r.description as string | null,
    wire: r.wire as string | null, source_url: r.source_url as string | null, classification: r.classification as string | null,
  }));
  out.signals = candidates.length;
  if (!candidates.length) { out.message = 'no signals in window'; return out; }

  // Stage 1 — shape-screen
  const shape = await qualifyOpportunities(candidates);
  const shapeById = new Map<number, QualifiedOpportunity>(shape.map(r => [r.id, r]));
  const pass = candidates.filter(c => shapeById.get(c.id)?.qualified);
  out.shapeFit = pass.length;
  if (!pass.length) { out.message = 'no shape-fit candidates'; return out; }

  // Stage 2 — verify against live sources (drops stale / confabulated)
  if (!bdVerifyAvailable()) { out.message = `parallel key unavailable — ${pass.length} shape-fit not verified`; return out; }
  const vinputs: BdVerifyInput[] = pass.map(c => ({ id: c.id, name: c.name, org: shapeById.get(c.id)?.org || null, url: c.source_url }));
  const vres = await verifyBdOpportunities(vinputs);
  const vById = new Map<number, BdVerifyResult>();
  for (const v of vres) if (v) vById.set(v.id, v);
  const verified = pass.filter(c => { const v = vById.get(c.id); return v && v.is_real && v.currently_active; });
  out.verified = verified.length;

  // Dedup by org, keep highest verification confidence
  const byOrg = new Map<string, { rec: LeadRecord; conf: string }>();
  for (const c of verified) {
    const s = shapeById.get(c.id)!;
    const v = vById.get(c.id)!;
    const org = (s.org || c.name).trim();
    const line = LINE_LABEL[s.fit_line] || s.fit_line;
    const rec: LeadRecord = {
      lead: `${org} — ${line.toLowerCase()} opportunity`.slice(0, 200),
      source: v.citationUrl || c.source_url || '',
      notes: `[${line} · ${c.wire || '?'} · ${v.confidence || 'low'}] ${v.status_summary || s.why_now}`,
      body: `Verified: ${v.status_summary || ''}\nOriginal signal: ${c.name}\nConfidence: ${v.confidence || 'low'} · Last activity: ${v.last_activity || 'unknown'}`,
    };
    const key = org.toLowerCase();
    const cur = byOrg.get(key);
    if (!cur || confRank(v.confidence) > confRank(cur.conf)) byOrg.set(key, { rec, conf: v.confidence || 'low' });
  }
  const leads = Array.from(byOrg.values()).map(x => x.rec);
  out.unique = leads.length;

  // Write to the Notion Leads list (dedups by Source URL across weeks)
  const w = await writeLeadsToNotion(leads);
  out.created = w.created;
  out.skipped = w.skipped;
  out.message = w.configured
    ? `${out.signals}→${out.shapeFit}→${out.verified}→${out.unique} unique; ${w.message}`
    : w.message;
  return out;
}
