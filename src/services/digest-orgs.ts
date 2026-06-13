/**
 * Sourcing orgs from tele-sum digest content (repos/models/claw) into org_profiles.
 * Pure helpers here; DB-touching runner is sourceDigestOrgs() below.
 */
import type { Pool } from 'pg';
import { findSimilarOrg, upsertOrgProfile } from './org-extractor';

export function normalizeDigestOrg(raw: string | null | undefined): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * Auto-create quality bar. A digest org mention becomes a CRM org only if it is a
 * real organization (not an incidental owner/repo handle) AND has enough signal:
 * >=2 distinct mentions, or a resolvable link from the content.
 */
export function qualifiesAsDigestOrg(
  rawName: string,
  signal: { mentionCount: number; hasLink: boolean },
): boolean {
  const name = normalizeDigestOrg(rawName);
  if (!name) return false;
  if (name.includes('/')) return false;       // owner/repo handle, not an org
  if (name.length < 2) return false;
  // Org-shaped names (have an uppercase letter or a space) qualify on >=2
  // mentions OR a resolvable link. Bare lowercase single-token names look like
  // personal handles (e.g. 'orhun'), so they need repeated mentions (>=2) to
  // qualify — a single link isn't enough. This still admits multi-mention
  // lowercase-branded orgs like 'openai' / 'huggingface-org'.
  const orgShaped = /[A-Z]/.test(name) || name.includes(' ');
  if (orgShaped) return signal.mentionCount >= 2 || signal.hasLink === true;
  return signal.mentionCount >= 2;
}

export async function ensureDigestItemOrgsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS digest_item_orgs (
      id SERIAL PRIMARY KEY,
      summary_id INTEGER NOT NULL,
      item_index INTEGER NOT NULL,
      org_id INTEGER NOT NULL REFERENCES org_profiles(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (summary_id, item_index, org_id)
    )
  `);
}

export async function linkDigestItemToOrg(
  pool: Pool, summaryId: number, itemIndex: number, orgId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO digest_item_orgs (summary_id, item_index, org_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (summary_id, item_index, org_id) DO NOTHING`,
    [summaryId, itemIndex, orgId],
  );
}

export interface DigestOrgOccurrence { summaryId: number; itemIndex: number; wire: string; }
export interface DigestOrgAgg { mentionCount: number; hasLink: boolean; occurrences: DigestOrgOccurrence[]; }

/** Pure: roll up org mentions across digest summaries. Keyed by normalized name. */
export function aggregateDigestOrgMentions(
  summaries: Array<{ id: number; wire: string; items: Array<{ org?: string | null; url?: string | null }> }>,
): Map<string, DigestOrgAgg> {
  const agg = new Map<string, DigestOrgAgg>();
  for (const s of summaries) {
    (s.items || []).forEach((item, idx) => {
      const name = normalizeDigestOrg(item.org);
      if (!name) return;
      const cur = agg.get(name) || { mentionCount: 0, hasLink: false, occurrences: [] };
      cur.mentionCount += 1;
      if (item.url) cur.hasLink = true;
      cur.occurrences.push({ summaryId: s.id, itemIndex: idx, wire: s.wire });
      agg.set(name, cur);
    });
  }
  return agg;
}

/** Read recent tele-sum digest summaries from the shared DB. */
export async function loadDigestSummaries(pool: Pool, lookbackDays = 30): Promise<Array<{ id: number; wire: string; items: any[] }>> {
  const { rows } = await pool.query(
    `SELECT s.id, m.wire, s.entities->'items' AS items
     FROM summaries s JOIN messages m ON m.id = s.message_id
     WHERE s.processing_status = 'SUCCESS'
       AND s.entities->>'profile' = 'digest'
       AND m.wire IN ('repos','models','claw')
       AND s.created_at >= NOW() - INTERVAL '1 day' * $1
     ORDER BY s.id`,
    [lookbackDays],
  );
  return rows.map((r: any) => ({ id: r.id, wire: r.wire, items: Array.isArray(r.items) ? r.items : [] }));
}

export async function sourceDigestOrgs(
  pool: Pool, lookbackDays = 30,
): Promise<{ orgsTouched: number; itemsLinked: number; skipped: number; errors: number }> {
  await ensureDigestItemOrgsTable(pool);
  const summaries = await loadDigestSummaries(pool, lookbackDays);
  const agg = aggregateDigestOrgMentions(summaries);
  let orgsTouched = 0, itemsLinked = 0, skipped = 0, errors = 0;
  for (const [name, info] of agg.entries()) {
    if (!qualifiesAsDigestOrg(name, { mentionCount: info.mentionCount, hasLink: info.hasLink })) {
      skipped += 1; continue;
    }
    try {
      const wire = info.occurrences[0]?.wire || 'models';
      const match = await findSimilarOrg(name);
      const orgId = match ? match.id : await upsertOrgProfile(name, wire);
      // 1. Link all occurrences first so the digest_item_orgs COUNT is current.
      for (const occ of info.occurrences) {
        await linkDigestItemToOrg(pool, occ.summaryId, occ.itemIndex, orgId);
        itemsLinked += 1;
      }
      // 2. Update wires + last_seen only. entry_count is grant-pipeline-owned; the digest
      //    path must not touch it — items_sourced is computed live at CRM sync time instead.
      await pool.query(
        `UPDATE org_profiles
           SET wires = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(wires,'{}') || $2::text))),
               last_seen = CURRENT_DATE
         WHERE id = $1`,
        [orgId, wire],
      );
      orgsTouched += 1;
    } catch (err) {
      errors += 1;
      console.error(`[DigestOrgs] error processing org "${name}":`, err);
    }
  }
  console.log(`[DigestOrgs] orgs touched=${orgsTouched} itemsLinked=${itemsLinked} skipped=${skipped} errors=${errors}`);
  return { orgsTouched, itemsLinked, skipped, errors };
}
