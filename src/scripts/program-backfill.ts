/**
 * Program-identity backfill — MANUAL, resumable, idempotent.
 *
 *   railway run npx ts-node src/scripts/program-backfill.ts --dry-run
 *   railway run npx ts-node src/scripts/program-backfill.ts
 *
 * 1. Cluster all scan_entries by normalizeProgramKey(name).
 * 2. LLM-canonicalize one representative per multi-member-or-decided cluster.
 * 3. Upsert programs, set scan_entries.program_id, compute counters,
 *    pick canonical_entry_id (approved > declined > queued, newest).
 * 4. Chain hygiene: repair duplicate_of_id cycles (point every member at the
 *    smallest id) and give pointer-less duplicates a pointer to their
 *    program's canonical entry when resolvable.
 * Idempotent: entries with program_id set are skipped on re-run.
 */
import { getPool } from '../db';
import { normalizeProgramKey, canonicalizeBatch, createProgram } from '../services/program-identity';

interface BackfillRow {
  id: number;
  name: string;
  status: string;
  wire: string | null;
  source_url: string | null;
}

export function clusterByKey<T extends { id: number; name: string; status: string }>(rows: T[]): Map<string, T[]> {
  const clusters = new Map<string, T[]>();
  for (const r of rows) {
    const key = normalizeProgramKey(r.name);
    if (!key) continue;
    const bucket = clusters.get(key) ?? [];
    bucket.push(r);
    clusters.set(key, bucket);
  }
  return clusters;
}

export function resolveChainSafe(pointers: Map<number, number | null>, startId: number): number {
  const path: number[] = [];
  let cur = startId;
  for (let hop = 0; hop < 20; hop++) {
    path.push(cur);
    const next = pointers.get(cur);
    if (next == null) return cur;                    // canonical or unknown target
    if (path.includes(next)) {                       // cycle — deterministic pick
      const cycle = path.slice(path.indexOf(next)).concat(next);
      return Math.min(...cycle);
    }
    if (!pointers.has(next)) return next;            // dangling pointer: trust it
    cur = next;
  }
  return cur;
}

export type ChainAction = { action: 'repoint'; to: number } | { action: 'clear' } | { action: 'orphan' } | { action: 'none' };

// The per-dupe chain-hygiene decision, extracted so the caller logic is testable.
// A cycle's canonical member resolves to ITSELF (resolveChainSafe returns d.id)
// while still carrying a stale non-null pointer — that member must be cleared
// or the cycle survives with zero writes (both members already "agree").
export function chainActionFor(pointers: Map<number, number | null>, d: { id: number; duplicate_of_id: number | null }): ChainAction {
  if (d.duplicate_of_id == null) return { action: 'orphan' };
  const canonical = resolveChainSafe(pointers, d.id);
  if (canonical === d.id) return { action: 'clear' };
  if (canonical !== d.duplicate_of_id) return { action: 'repoint', to: canonical };
  return { action: 'none' };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = getPool();

  const { rows } = await pool.query<{ id: number; name: string; status: string; wire: string; source_url: string; deadline: string | null; program_id: number | null; duplicate_of_id: number | null; updated_at: Date }>(
    `SELECT id, name, status, wire, source_url, deadline, program_id, duplicate_of_id, updated_at FROM scan_entries WHERE name IS NOT NULL`);
  console.log(`entries: ${rows.length}, already linked: ${rows.filter(r => r.program_id).length}`);

  const unlinked: BackfillRow[] = rows.filter(r => !r.program_id);
  const clusters = clusterByKey(unlinked);
  const DECIDED = new Set(['approved', 'declined', 'duplicate']);
  const eligible = [...clusters.entries()].filter(([, members]) =>
    members.length >= 2 || members.some(m => DECIDED.has(m.status)));
  console.log(`clusters: ${clusters.size} total, ${eligible.length} eligible (≥2 members or decided)`);
  if (dryRun) {
    const top = eligible.sort((a, b) => b[1].length - a[1].length).slice(0, 20);
    for (const [key, members] of top) console.log(`  ${String(members.length).padStart(4)}  ${key}  e.g. "${members[0].name.slice(0, 60)}"`);
  }

  // Canonicalize representatives in chunks of 20
  const reps = eligible.map(([key, members]) => ({ key, rep: members[0], members }));
  const canonicalById = new Map<number, { org: string | null; program: string | null; round_label: string | null }>();
  if (!dryRun) {
    for (let i = 0; i < reps.length; i += 20) {
      const chunk = reps.slice(i, i + 20);
      const out = await canonicalizeBatch(chunk.map(c => ({ id: c.rep.id, name: c.rep.name, description: '' })));
      for (const o of out) canonicalById.set(o.id, o);
      console.log(`canonicalized ${Math.min(i + 20, reps.length)}/${reps.length}`);
    }
  }

  let linked = 0;
  if (!dryRun) {
    const client = await pool.connect();
    try {
      let clusterNum = 0;
      for (const { rep, members } of reps) {
        clusterNum++;
        const canon = canonicalById.get(rep.id);
        try {
          await client.query('BEGIN');
          const programId = await createProgram(client, {
            name: rep.name, canonicalName: canon?.program ?? null, orgName: canon?.org ?? null,
            wire: rep.wire ?? null, sourceUrl: rep.source_url ?? null, roundLabel: canon?.round_label ?? null,
          });
          const ids = members.map(m => m.id);
          await client.query(`UPDATE scan_entries SET program_id = $1 WHERE id = ANY($2::int[]) AND program_id IS NULL`, [programId, ids]);
          // counters + canonical exemplar from members
          await client.query(
            `UPDATE programs p SET
               entry_count = s.total, approved_count = s.approved, declined_count = s.declined,
               first_seen = s.first_seen, last_seen = s.last_seen,
               canonical_entry_id = s.exemplar,
               last_decision = s.last_decision,
               aliases = (SELECT ARRAY(SELECT DISTINCT unnest(p.aliases || s.names)))
             FROM (
               SELECT COUNT(*)::int AS total,
                      COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
                      COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
                      MIN(created_at)::date AS first_seen, MAX(created_at)::date AS last_seen,
                      (ARRAY_AGG(id ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'declined' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, created_at DESC))[1] AS exemplar,
                      (ARRAY_AGG(status || ' ' || updated_at::date ORDER BY updated_at DESC) FILTER (WHERE status IN ('approved','declined')))[1] AS last_decision,
                      ARRAY_AGG(DISTINCT name) AS names
               FROM scan_entries WHERE program_id = $1
             ) s
             WHERE p.id = $1`, [programId]);
          await client.query('COMMIT');
          linked += ids.length;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
        if (clusterNum % 50 === 0) console.log(`clusters written: ${clusterNum}/${reps.length}`);
      }
    } finally {
      client.release();
    }
    console.log(`programs written; entries linked: ${linked}`);
  }

  // Chain hygiene (runs in both modes; writes only when live)
  const pointers = new Map<number, number | null>(rows.map(r => [r.id, r.duplicate_of_id]));
  const dupes = rows.filter(r => r.status === 'duplicate');
  let cycleFixes = 0, orphanFixes = 0;
  for (const d of dupes) {
    const decision = chainActionFor(pointers, d);
    switch (decision.action) {
      case 'clear':
        // cycle's canonical member resolved to itself but still carries a stale
        // pointer — clear it so the cycle actually breaks (established corpus
        // pattern: "duplicate status + NULL duplicate_of_id"; the orphan branch
        // may give it a program-canonical pointer on a later run)
        cycleFixes++;
        if (!dryRun) await pool.query(`UPDATE scan_entries SET duplicate_of_id = NULL WHERE id = $1`, [d.id]);
        break;
      case 'repoint':
        cycleFixes++;
        if (!dryRun) await pool.query(`UPDATE scan_entries SET duplicate_of_id = $1 WHERE id = $2`, [decision.to, d.id]);
        break;
      case 'orphan':
        orphanFixes++; // pointer-less duplicate: leave unless its program has an exemplar
        if (!dryRun) {
          await pool.query(
            `UPDATE scan_entries se SET duplicate_of_id = p.canonical_entry_id
             FROM programs p WHERE se.id = $1 AND se.program_id = p.id
               AND p.canonical_entry_id IS NOT NULL AND p.canonical_entry_id <> se.id`, [d.id]);
        }
        break;
      case 'none':
        break;
    }
  }
  console.log(`chain hygiene: ${cycleFixes} pointers flattened/de-cycled, ${orphanFixes} orphan dupes examined`);
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error('BACKFILL FAILED:', e); process.exit(1); });
}
