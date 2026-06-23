/**
 * Run the full two-stage BD pipeline on the last N days and emit the final
 * deduped, verified shortlist as JSON (between markers) — for standing up the
 * Notion BD Pipeline. Read-only on the DB; Grok (screen) + Parallel (verify).
 * No writes, no email, no outreach.
 *   railway run npx ts-node src/scripts/bd-pipeline-run.ts [days]
 */
import { getPool } from '../db';
import { qualifyOpportunities, BdCandidate, QualifiedOpportunity } from '../services/bd-qualifier';
import { verifyBdOpportunities, bdVerifyAvailable, BdVerifyInput, BdVerifyResult } from '../services/bd-verify';

const confRank = (c?: string | null): number => (c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0);

async function main() {
  const days = parseInt(process.argv[2] || '7', 10);
  const pool = getPool();

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
  console.error(`[pipeline] ${candidates.length} signals over ${days}d`);

  const shape = await qualifyOpportunities(candidates);
  const shapeById = new Map<number, QualifiedOpportunity>(shape.map(r => [r.id, r]));
  const pass = candidates.filter(c => shapeById.get(c.id)?.qualified);
  console.error(`[pipeline] shape-fit: ${pass.length}`);

  if (!bdVerifyAvailable()) { console.error('[pipeline] no parallel key'); process.exit(1); }
  const vinputs: BdVerifyInput[] = pass.map(c => ({ id: c.id, name: c.name, org: shapeById.get(c.id)?.org || null, url: c.source_url }));
  const vres = await verifyBdOpportunities(vinputs);
  const vById = new Map<number, BdVerifyResult>();
  for (const v of vres) if (v) vById.set(v.id, v);
  const verified = pass.filter(c => { const v = vById.get(c.id); return v && v.is_real && v.currently_active; });
  console.error(`[pipeline] verified current: ${verified.length}`);

  // dedup by org (normalized), keep highest verification confidence
  const byOrg = new Map<string, Record<string, unknown>>();
  for (const c of verified) {
    const s = shapeById.get(c.id)!;
    const v = vById.get(c.id)!;
    const org = (s.org || c.name).trim();
    const item = {
      org, line: s.fit_line, wire: c.wire,
      why_now: v.status_summary || s.why_now,
      last_activity: v.last_activity,
      source: v.citationUrl || c.source_url,
      confidence: v.confidence || 'low',
      signal: c.name,
    };
    const cur = byOrg.get(org.toLowerCase());
    if (!cur || confRank(item.confidence) > confRank(cur.confidence as string)) byOrg.set(org.toLowerCase(), item);
  }
  const final = Array.from(byOrg.values()).sort((a, b) => confRank(b.confidence as string) - confRank(a.confidence as string));
  console.error(`[pipeline] deduped unique: ${final.length}`);

  console.log('===BD_JSON_START===');
  console.log(JSON.stringify(final));
  console.log('===BD_JSON_END===');
  await pool.end();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
