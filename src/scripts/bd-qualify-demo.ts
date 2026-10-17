/**
 * DEMO: two-stage BD pipeline on the live relationship_signal backlog.
 *   Stage 1  shape-screen (Grok)      — does it fit the operator's lines + ICP?
 *   Stage 2  verify (Parallel Task)   — is it REAL and CURRENT, per sources?
 *   Final    qualify on VERIFIED facts; why-now comes from sources, not titles.
 * Prints confabulated (title-claim) vs verified (sourced) side by side.
 * Read-only — no writes, no email, no outreach.
 *   railway run npx ts-node src/scripts/bd-qualify-demo.ts [limit]
 */
import { getPool } from '../db';
import { qualifyOpportunities, BdCandidate, QualifiedOpportunity } from '../services/bd-qualifier';
import { verifyBdOpportunities, bdVerifyAvailable, BdVerifyInput, BdVerifyResult } from '../services/bd-verify';

const LABEL: Record<string, string> = { grant_program_ops: 'GRANTS-OPS', ops_sales_bd: 'OPS/SALES/BD', governance_ops: 'GOVERNANCE', none: '-' };

async function main() {
  const limit = parseInt(process.argv[2] || '40', 10);
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT id, name, description, wire, source_url, classification
     FROM scan_entries
     WHERE metadata->>'operator_route' = 'relationship_signal'
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  const candidates: BdCandidate[] = rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    name: r.name as string,
    description: r.description as string | null,
    wire: r.wire as string | null,
    source_url: r.source_url as string | null,
    classification: r.classification as string | null,
  }));

  // Stage 1 — shape-screen
  console.log(`STAGE 1 — shape-screen ${candidates.length} signals against the operator's lines + ICP...`);
  const shape = await qualifyOpportunities(candidates);
  const shapeById = new Map<number, QualifiedOpportunity>(shape.map(r => [r.id, r]));
  const shapePass = candidates.filter(c => shapeById.get(c.id)?.qualified);
  console.log(`  passed shape: ${shapePass.length} / ${candidates.length}\n`);

  if (!bdVerifyAvailable()) {
    console.log('Parallel key not available — cannot run verification. Set PARALLEL_API_KEY / provider.');
    await pool.end();
    return;
  }

  // Stage 2 — verify the shape-passers against live sources
  console.log(`STAGE 2 — verifying ${shapePass.length} against live sources (Parallel Task)...\n`);
  const vInputs: BdVerifyInput[] = shapePass.map(c => ({
    id: c.id, name: c.name, org: shapeById.get(c.id)?.org || null, url: c.source_url,
  }));
  const vres = await verifyBdOpportunities(vInputs);
  const vById = new Map<number, BdVerifyResult>();
  for (const v of vres) if (v) vById.set(v.id, v);

  const survived = shapePass.filter(c => { const v = vById.get(c.id); return v && v.is_real && v.currently_active; });
  const killed = shapePass.filter(c => !survived.includes(c));

  console.log(`================  QUALIFIED (shape + VERIFIED current): ${survived.length}  ================\n`);
  for (const c of survived.sort((a, b) => (vById.get(b.id)!.confidence === 'high' ? 1 : 0) - (vById.get(a.id)!.confidence === 'high' ? 1 : 0))) {
    const s = shapeById.get(c.id)!;
    const v = vById.get(c.id)!;
    console.log(`● ${LABEL[s.fit_line]}  —  ${s.org || c.name}   [verify confidence: ${v.confidence || '?'}]`);
    console.log(`   signal:        ${String(c.name).slice(0, 92)}`);
    console.log(`   verified now:  ${v.status_summary || '(active, no summary)'}`);
    console.log(`   last activity: ${v.last_activity || 'unknown'}`);
    console.log(`   source:        ${v.citationUrl || c.source_url || '-'}`);
    console.log('');
  }

  console.log(`================  KILLED BY VERIFICATION: ${killed.length}  (title said X, sources say Y)  ================\n`);
  for (const c of killed) {
    const s = shapeById.get(c.id)!;
    const v = vById.get(c.id);
    const verdict = !v ? 'could not verify from sources (no confident match)'
      : !v.is_real ? `not confirmable as real — ${v.status_summary || 'no source'}`
      : `STALE: ${v.status_summary || 'not current'} (last activity ${v.last_activity || 'unknown'})`;
    console.log(`✗ ${s.org || c.name}`);
    console.log(`   title claimed:  ${s.why_now}`);
    console.log(`   sources say:    ${verdict}`);
    console.log('');
  }

  console.log(`================  SUMMARY  ================`);
  console.log(`signals: ${candidates.length}  →  shape-fit: ${shapePass.length}  →  verified current: ${survived.length}`);
  console.log(`verification killed ${killed.length} shape-fit candidates that were stale, unreal, or unconfirmable.`);

  await pool.end();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
