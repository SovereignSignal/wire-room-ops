/**
 * Organization Enricher
 *
 * Uses Grok LLM to classify and enrich org_profiles with:
 * - org_type (Web2, Non-Profit/NGO, etc.)
 * - source_type (X Account, Forum, Blog, etc.)
 * - website URL
 * - twitter URL
 *
 * Also computes derived fields:
 * - avg_quality_score from linked scan_entries
 * - tier from entry_count + avg_quality_score rules
 */

import { config } from '../config';
import { getPool } from '../db';

// ============================================================
// Allowed enum values
// ============================================================

const VALID_ORG_TYPES = [
  'Web2', 'Non-Profit/NGO', 'Corporate', 'Ecosystem DAO',
  'Protocol DAO', 'Foundation/Lab', 'Education', 'Government', 'Healthcare',
];

const VALID_SOURCE_TYPES = [
  'X Account', 'Forum', 'Blog', 'Website', 'Newsletter',
  'Discord', 'Protocol/Infrastructure', 'Advocate', 'Official',
];

// ============================================================
// LLM Enrichment
// ============================================================

interface EnrichmentResult {
  org_type: string | null;
  source_type: string | null;
  website: string | null;
  twitter: string | null;
}

/**
 * Enrich a batch of orgs via Grok LLM.
 * Returns a map of org name → enrichment data.
 */
export async function enrichOrgs(
  orgs: Array<{ id: number; name: string; wires: string[]; entry_count: number }>
): Promise<Map<number, EnrichmentResult>> {
  const results = new Map<number, EnrichmentResult>();

  if (!config.apis.grok.apiKey) {
    console.warn('[OrgEnricher] No Grok API key — skipping enrichment');
    return results;
  }

  const orgList = orgs.map((o, i) =>
    `${i + 1}. [ID:${o.id}] "${o.name}" (wires: ${o.wires.join(', ')}, entries: ${o.entry_count})`
  ).join('\n');

  const prompt = `You are classifying organizations that appear in a grant/funding discovery pipeline. For each org below, determine:

1. **org_type** — exactly one of: ${VALID_ORG_TYPES.join(', ')}
2. **source_type** — exactly one of: ${VALID_SOURCE_TYPES.join(', ')}
3. **website** — the org's primary website URL (https://...), or null if unknown
4. **twitter** — the org's Twitter/X URL (https://x.com/...), or null if unknown

Rules:
- For crypto/web3 orgs, "Foundation/Lab" covers foundations like Ethereum Foundation, "Protocol DAO" covers on-chain DAOs, "Ecosystem DAO" covers ecosystem funds
- "Official" source_type means the org publishes grants directly on their own channels
- "Advocate" means a third party shares info about this org's grants
- Only return URLs you are confident are correct — do not guess
- Twitter URLs should use x.com format

Return ONLY a JSON array of objects with fields: id, org_type, source_type, website, twitter. No explanation.

Organizations:
${orgList}`;

  const response = await fetch(`${config.apis.grok.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apis.grok.apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-4.20-beta-0309-non-reasoning',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    throw new Error(`Grok returned ${response.status}: ${await response.text().catch(() => 'unknown')}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() || '';

  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn('[OrgEnricher] No JSON array in Grok response');
    return results;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      id: number;
      org_type?: string;
      source_type?: string;
      website?: string;
      twitter?: string;
    }>;

    for (const item of parsed) {
      results.set(item.id, {
        org_type: item.org_type && VALID_ORG_TYPES.includes(item.org_type) ? item.org_type : null,
        source_type: item.source_type && VALID_SOURCE_TYPES.includes(item.source_type) ? item.source_type : null,
        website: item.website && item.website.startsWith('http') ? item.website : null,
        twitter: item.twitter && item.twitter.startsWith('http') ? item.twitter : null,
      });
    }
  } catch {
    console.warn('[OrgEnricher] Failed to parse Grok enrichment response');
  }

  return results;
}

/**
 * Batch-enrich unenriched org profiles.
 * Processes in chunks of 10 with 2s delay between batches.
 */
export async function enrichBatch(opts?: {
  force?: boolean;
  limit?: number;
}): Promise<{ enriched: number; errors: number }> {
  const pool = getPool();
  const limit = Math.min(opts?.limit || 200, 200);
  const stats = { enriched: 0, errors: 0 };

  const { rows: orgs } = await pool.query(
    `SELECT id, name, wires, entry_count FROM org_profiles
     WHERE ($1::boolean OR enriched_at IS NULL)
     ORDER BY entry_count DESC LIMIT $2`,
    [!!opts?.force, limit]
  );

  if (orgs.length === 0) {
    console.log('[OrgEnricher] No orgs to enrich');
    return stats;
  }

  console.log(`[OrgEnricher] Enriching ${orgs.length} orgs...`);

  const CHUNK_SIZE = 10;
  for (let i = 0; i < orgs.length; i += CHUNK_SIZE) {
    const chunk = orgs.slice(i, i + CHUNK_SIZE);

    try {
      const enrichments = await enrichOrgs(chunk);

      for (const [orgId, data] of enrichments) {
        try {
          await pool.query(
            `UPDATE org_profiles SET
              org_type = COALESCE($1, org_type),
              source_type = COALESCE($2, source_type),
              website = COALESCE($3, website),
              twitter = COALESCE($4, twitter),
              enriched_at = NOW(),
              updated_at = NOW()
            WHERE id = $5`,
            [data.org_type, data.source_type, data.website, data.twitter, orgId]
          );
          stats.enriched++;
        } catch (err) {
          console.error(`[OrgEnricher] DB update failed for org ${orgId}:`, err);
          stats.errors++;
        }
      }

      // Mark orgs that weren't in the response as enriched (with no data) to avoid re-processing
      for (const org of chunk) {
        if (!enrichments.has(org.id)) {
          await pool.query(
            `UPDATE org_profiles SET enriched_at = NOW(), updated_at = NOW() WHERE id = $1 AND enriched_at IS NULL`,
            [org.id]
          );
        }
      }
    } catch (err) {
      console.error(`[OrgEnricher] Batch failed:`, err);
      stats.errors += chunk.length;
    }

    // Rate limit between batches
    if (i + CHUNK_SIZE < orgs.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`[OrgEnricher] Done: ${stats.enriched} enriched, ${stats.errors} errors`);
  return stats;
}

/**
 * Enrich a single org by ID. Skips if already enriched (idempotent).
 * Used in the approve flow for fire-and-forget enrichment.
 */
export async function enrichSingleOrg(orgId: number): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT id, name, wires, entry_count, enriched_at FROM org_profiles WHERE id = $1`,
    [orgId]
  );

  if (rows.length === 0) return;
  if (rows[0].enriched_at) return; // Already enriched

  const org = rows[0];

  try {
    const enrichments = await enrichOrgs([org]);
    const data = enrichments.get(orgId);

    if (data) {
      await pool.query(
        `UPDATE org_profiles SET
          org_type = COALESCE($1, org_type),
          source_type = COALESCE($2, source_type),
          website = COALESCE($3, website),
          twitter = COALESCE($4, twitter),
          enriched_at = NOW(),
          updated_at = NOW()
        WHERE id = $5 AND enriched_at IS NULL`,
        [data.org_type, data.source_type, data.website, data.twitter, orgId]
      );
    } else {
      // Mark as enriched even if no data returned
      await pool.query(
        `UPDATE org_profiles SET enriched_at = NOW(), updated_at = NOW() WHERE id = $1 AND enriched_at IS NULL`,
        [orgId]
      );
    }

    console.log(`[OrgEnricher] Enriched org id=${orgId} "${org.name}"`);
  } catch (err) {
    console.error(`[OrgEnricher] Failed to enrich org ${orgId}:`, err);
  }
}

// ============================================================
// Derived field computation
// ============================================================

/**
 * Compute avg_quality_score and tier for all org profiles in a single bulk UPDATE.
 * - avg_quality_score: average quality_score of linked approved/queued entries
 * - tier: Tier 1 (entry_count >= 5 AND avg >= 60), Tier 2 (entry_count >= 2 OR avg >= 50), else Tier 3
 */
export async function computeDerivedFields(): Promise<{ updated: number }> {
  const pool = getPool();

  const result = await pool.query(`
    UPDATE org_profiles op SET
      entry_count = sub.real_entry_count,
      avg_quality_score = sub.avg_score,
      tier = CASE
        WHEN sub.real_entry_count >= 5 AND sub.avg_score >= 60 THEN 'Tier 1 - Official'
        WHEN sub.real_entry_count >= 2 OR sub.avg_score >= 50 THEN 'Tier 2 - Secondary'
        ELSE 'Tier 3 - Monitor'
      END,
      updated_at = NOW()
    FROM (
      SELECT
        op2.id,
        COUNT(se.id)::int AS real_entry_count,
        ROUND(AVG(se.quality_score)::numeric, 1) AS avg_score
      FROM org_profiles op2
      LEFT JOIN scan_entries se ON se.org_id = op2.id AND se.status IN ('queued', 'approved')
      GROUP BY op2.id
    ) sub
    WHERE op.id = sub.id
  `);

  const updated = result.rowCount ?? 0;
  console.log(`[OrgEnricher] Computed derived fields for ${updated} orgs`);
  return { updated };
}
