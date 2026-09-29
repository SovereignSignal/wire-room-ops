import { programLastDecisionSql } from '../db/program-decisions';
/**
 * Program-identity backfill — MANUAL, resumable, idempotent.
 *
 *   railway run npx ts-node src/scripts/program-backfill.ts --dry-run
 *   railway run npx ts-node src/scripts/program-backfill.ts
 *
 * 1. Cluster all scan_entries by normalizeProgramKey(name).
 * 2. Skip synthetic names beginning with "Test".
 * 3. LLM-canonicalize and write one 20-cluster chunk at a time so reruns resume
 *    from the first unlinked cluster.
 * 4. Upsert programs, set scan_entries.program_id, compute counters,
 *    pick canonical_entry_id (approved > declined > queued, newest).
 * 5. Chain hygiene: repair duplicate_of_id cycles (point every member at the
 *    smallest id) and give pointer-less duplicates a pointer to their
 *    program's canonical entry when resolvable.
 * Idempotent: entries with program_id set are skipped on re-run.
 */
import { getPool } from '../db';
import { normalizeProgramKey, canonicalizeBatch, createProgram } from '../services/program-identity';
import { getCachedProvider, refreshProviderCache } from '../services/api-provider';

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

const DECIDED = new Set(['approved', 'declined', 'duplicate']);

export function isSyntheticTestName(name: string): boolean {
  return /^test(?:\s|$)/i.test((name || '').trim());
}

export function selectEligibleClusters<T extends { id: number; name: string; status: string }>(
  clusters: Map<string, T[]>,
): Array<[string, T[]]> {
  return [...clusters.entries()].filter(([, members]) =>
    !members.every(member => isSyntheticTestName(member.name))
    && (members.length >= 2 || members.some(member => DECIDED.has(member.status))));
}

export function chunkClusters<T>(items: T[], size = 20): T[][] {
  if (size < 1) throw new Error('Chunk size must be at least 1');
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
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
  const eligible = selectEligibleClusters(clusters);
  const syntheticSkipped = [...clusters.values()].filter(members =>
    members.every(member => isSyntheticTestName(member.name))
    && (members.length >= 2 || members.some(member => DECIDED.has(member.status)))).length;
  console.log(`clusters: ${clusters.size} total, ${eligible.length} eligible (≥2 members or decided), ${syntheticSkipped} synthetic test clusters skipped`);
  if (dryRun) {
    const top = eligible.sort((a, b) => b[1].length - a[1].length).slice(0, 20);
    for (const [key, members] of top) console.log(`  ${String(members.length).padStart(4)}  ${key}  e.g. "${members[0].name.slice(0, 60)}"`);
  }

  // Canonicalize and write each chunk before requesting the next. Because the
  // query starts from program_id IS NULL, a failed run resumes after the last
  // committed chunk without repeating earlier model calls.
  const reps = eligible.map(([key, members]) => ({ key, rep: members[0], members }));
  let linked = 0;
  if (!dryRun) {
    await refreshProviderCache();
    const provider = getCachedProvider('grok');
    if (!provider?.enabled || !provider.api_key || !provider.base_url || !provider.default_model) {
      throw new Error('Configured grok provider is unavailable; refusing to start the live backfill');
    }
    console.log(`canonicalizer: ${provider.default_model} via ${provider.source} provider config`);

    let clusterNum = 0;
    for (const chunk of chunkClusters(reps)) {
      const out = await canonicalizeBatch(chunk.map(c => ({ id: c.rep.id, name: c.rep.name, description: '' })));
      if (out.length === 0) {
        throw new Error(`Canonicalization returned no results for chunk beginning at cluster ${clusterNum + 1}; refusing fallback-only writes`);
      }
      const canonicalById = new Map(out.map(o => [o.id, o]));

      // Acquire a database client only after the model call. A slow provider
      // response must not hold an idle production connection.
      const client = await pool.connect();
      try {
        for (const { rep, members } of chunk) {
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
                        ${programLastDecisionSql('scan_entries')} AS last_decision,
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
        }
      } finally {
        client.release();
      }
      console.log(`canonicalized and wrote ${clusterNum}/${reps.length}`);
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
