/**
 * Scan Stats Service
 *
 * Provides prompt effectiveness metrics:
 * - Per-prompt: total results, unique results, dup rate, avg quality, high quality count
 * - Cross-prompt: overlap rate (entries found by 2+ prompts)
 */

import type { Pool } from 'pg';

export interface PromptStats {
  promptId: string | null;
  wire: string;
  label: string;
  variant: string;
  scanSource: string;
  totalResults: number;
  uniqueResults: number;
  duplicateRate: number;       // 0-1
  avgQualityScore: number;
  highQualityCount: number;    // score >= 60
  approvedCount: number;
  declinedCount: number;
  approvalRate: number;        // 0-1 (of reviewed entries)
  classificationMix: Record<string, number>;  // e.g. { GRANT: 5, NEWS: 3, NOISE: 1 }
  publishedAtCoverage: number; // 0-1 fraction of entries with source_published_at
}

export interface OverlapStats {
  totalUniqueEntries: number;
  entriesFoundByMultiple: number;
  overlapRate: number;         // 0-1
}

export interface PromptEffectivenessStats {
  prompts: PromptStats[];
  overlapStats: OverlapStats;
}

export async function getPromptEffectivenessStats(
  pool: Pool,
  days: number = 7,
  wire?: string
): Promise<PromptEffectivenessStats> {
  // Per-prompt stats: join scan_entries to scan_prompts, group by prompt
  // For legacy entries without prompt_id, fall back to wire + prompt_variant
  const params: (number | string)[] = [days];
  const wireFilter = wire ? `AND COALESCE(p.wire, e.wire) = $${params.push(wire)}` : '';

  const perPromptResult = await pool.query(`
    WITH prompt_entries AS (
      SELECT
        e.prompt_id,
        COALESCE(p.wire, e.wire) AS wire,
        COALESCE(p.label, e.wire || ' ' || e.prompt_variant) AS label,
        COALESCE(p.variant, e.prompt_variant) AS variant,
        COALESCE(e.scan_source, 'unknown') AS scan_source,
        e.status,
        e.quality_score,
        e.classification,
        e.source_published_at
      FROM scan_entries e
      LEFT JOIN scan_prompts p ON e.prompt_id = p.id
      WHERE e.created_at >= NOW() - INTERVAL '1 day' * $1
      ${wireFilter}
    )
    SELECT
      prompt_id,
      wire,
      label,
      variant,
      MAX(scan_source) AS scan_source,
      COUNT(*) AS total_results,
      COUNT(*) FILTER (WHERE status NOT IN ('duplicate')) AS unique_results,
      ROUND(
        CASE WHEN COUNT(*) > 0
          THEN COUNT(*) FILTER (WHERE status = 'duplicate')::NUMERIC / COUNT(*)
          ELSE 0
        END, 3
      ) AS duplicate_rate,
      ROUND(COALESCE(AVG(quality_score) FILTER (WHERE quality_score IS NOT NULL), 0), 1) AS avg_quality_score,
      COUNT(*) FILTER (WHERE quality_score >= 60) AS high_quality_count,
      COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
      COUNT(*) FILTER (WHERE status = 'declined') AS declined_count,
      COUNT(*) FILTER (WHERE classification = 'GRANT') AS cls_grant,
      COUNT(*) FILTER (WHERE classification = 'NEWS') AS cls_news,
      COUNT(*) FILTER (WHERE classification = 'EXPIRED') AS cls_expired,
      COUNT(*) FILTER (WHERE classification = 'NOISE') AS cls_noise,
      COUNT(*) FILTER (WHERE classification = 'UNCHECKED' OR classification IS NULL) AS cls_unchecked,
      COUNT(*) FILTER (WHERE source_published_at IS NOT NULL) AS has_published_at,
      COUNT(*) FILTER (WHERE status NOT IN ('duplicate')) AS non_dup_total
    FROM prompt_entries
    GROUP BY prompt_id, wire, label, variant
    ORDER BY wire, variant
  `, params);

  const prompts: PromptStats[] = perPromptResult.rows.map(row => {
    const approved = parseInt(row.approved_count, 10);
    const declined = parseInt(row.declined_count, 10);
    const reviewed = approved + declined;
    const nonDup = parseInt(row.non_dup_total, 10);

    return {
      promptId: row.prompt_id,
      wire: row.wire,
      label: row.label,
      variant: row.variant,
      scanSource: row.scan_source,
      totalResults: parseInt(row.total_results, 10),
      uniqueResults: parseInt(row.unique_results, 10),
      duplicateRate: parseFloat(row.duplicate_rate),
      avgQualityScore: parseFloat(row.avg_quality_score),
      highQualityCount: parseInt(row.high_quality_count, 10),
      approvedCount: approved,
      declinedCount: declined,
      approvalRate: reviewed > 0 ? Math.round((approved / reviewed) * 1000) / 1000 : 0,
      classificationMix: {
        GRANT: parseInt(row.cls_grant, 10),
        NEWS: parseInt(row.cls_news, 10),
        EXPIRED: parseInt(row.cls_expired, 10),
        NOISE: parseInt(row.cls_noise, 10),
        UNCHECKED: parseInt(row.cls_unchecked, 10),
      },
      publishedAtCoverage: nonDup > 0 ? Math.round((parseInt(row.has_published_at, 10) / nonDup) * 1000) / 1000 : 0,
    };
  });

  // Cross-prompt overlap must include duplicate observations: those rows are
  // the evidence that two prompts found the same source.
  const overlapParams: (number | string)[] = [days];
  const overlapWireFilter = wire ? `AND wire = $${overlapParams.push(wire)}` : '';

  const overlapResult = await pool.query(`
    WITH url_prompts AS (
      SELECT
        lower(regexp_replace(regexp_replace(source_url, '^https?://(www\.)?', '', 'i'), '/$', '')) AS normalized_source_url,
        COUNT(DISTINCT COALESCE(prompt_id::TEXT, wire || '_' || prompt_variant)) AS prompt_count
      FROM scan_entries
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        AND source_url IS NOT NULL
        AND btrim(source_url) != ''
        ${overlapWireFilter}
      GROUP BY normalized_source_url
    )
    SELECT
      COUNT(*) AS total_unique,
      COUNT(*) FILTER (WHERE prompt_count >= 2) AS found_by_multiple
    FROM url_prompts
  `, overlapParams);

  const overlapRow = overlapResult.rows[0];
  const totalUnique = parseInt(overlapRow?.total_unique || '0', 10);
  const foundByMultiple = parseInt(overlapRow?.found_by_multiple || '0', 10);

  return {
    prompts,
    overlapStats: {
      totalUniqueEntries: totalUnique,
      entriesFoundByMultiple: foundByMultiple,
      overlapRate: totalUnique > 0 ? Math.round((foundByMultiple / totalUnique) * 1000) / 1000 : 0,
    },
  };
}
