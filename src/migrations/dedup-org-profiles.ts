/**
 * One-time LLM-powered org_profiles deduplication
 *
 * Sends all org names to Grok in a single call to classify each as:
 * - entity_type: "org" | "person" | "event" | "program" | "junk"
 * - merge_into: ID of canonical org if duplicate
 * - parent_id: ID of parent org if subsidiary (metadata only)
 * - keep: boolean
 *
 * Then executes merges, archives, and parent links.
 */

import type { Pool } from 'pg';
import { config } from '../config';
import { mergeOrgs, archiveOrg } from '../services/org-merge';

export interface DedupResult {
  totalOrgs: number;
  merged: number;
  archived: number;
  parentLinked: number;
  kept: number;
  errors: string[];
}

interface LlmClassification {
  id: number;
  name: string;
  entity_type: 'org' | 'person' | 'event' | 'program' | 'junk';
  merge_into: number | null;
  parent_id: number | null;
  keep: boolean;
}

export async function runOrgDedup(pool: Pool): Promise<DedupResult> {
  const result: DedupResult = {
    totalOrgs: 0,
    merged: 0,
    archived: 0,
    parentLinked: 0,
    kept: 0,
    errors: [],
  };

  // Fetch all orgs
  const { rows: orgs } = await pool.query(
    `SELECT id, name, entry_count, wires FROM org_profiles ORDER BY entry_count DESC`
  );

  if (orgs.length === 0) {
    console.log('[OrgDedup] No orgs to process');
    return result;
  }

  result.totalOrgs = orgs.length;
  console.log(`[OrgDedup] Classifying ${orgs.length} org profiles via Grok...`);

  // Build the org list for the prompt
  const orgList = orgs.map(o =>
    `  { "id": ${o.id}, "name": ${JSON.stringify(o.name)}, "entries": ${o.entry_count}, "wires": ${JSON.stringify(o.wires || [])} }`
  ).join(',\n');

  const prompt = `You are a data quality analyst. Below is a JSON array of organization profiles from a grants intelligence database. Many entries are bad data — people, events, programs, junk, or duplicates of real organizations.

Classify each entry. Return a JSON array with one object per input:
{
  "id": <number>,
  "entity_type": "org" | "person" | "event" | "program" | "junk",
  "merge_into": <id of canonical org to merge into, or null>,
  "parent_id": <id of parent org if this is a subsidiary/sub-brand, or null>,
  "keep": <boolean>
}

Rules:
- "org": Real organization, foundation, company, DAO, protocol, or agency
- "person": Individual person name (e.g., "Shakila Shukla", "Otto Kekäläinen")
- "event": Conference, summit, or time-bound event
- "program": Grant program, initiative, or campaign (not the org itself)
- "junk": Meaningless abbreviations, titles, or noise

For merge_into:
- Only set this for TRUE duplicates of the same entity (e.g., "Base" should merge into "Base (Coinbase)")
- Do NOT merge genuinely distinct subsidiaries (Google.org and Google DeepMind are separate from Google — use parent_id instead)
- The merge target must be the entry with the most complete/canonical name

For parent_id:
- Set this for subsidiaries or sub-brands (e.g., Google.org → parent Google, Google DeepMind → parent Google)
- Only link to orgs that exist in the list

For keep:
- true for real orgs (even if they have a parent_id)
- false for persons, events, programs, junk, and entries being merged

Organizations:
[
${orgList}
]

Return ONLY valid JSON array, no explanation.`;

  // Call Grok
  const response = await fetch(`${config.apis.grok.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apis.grok.apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-3-mini-fast',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Grok returned ${response.status}: ${body}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() || '';

  // Parse JSON
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('Grok did not return valid JSON array');
  }

  let classifications: LlmClassification[];
  try {
    classifications = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse Grok JSON: ${e}`);
  }

  console.log(`[OrgDedup] Got ${classifications.length} classifications from Grok`);

  // Build ID set of existing orgs for validation
  const existingIds = new Set(orgs.map(o => o.id));

  // Phase 1: Execute merges (process these first so merge targets exist)
  const mergeTargets = new Set<number>(); // Track IDs being merged into
  for (const c of classifications) {
    if (c.merge_into && c.merge_into !== c.id && existingIds.has(c.merge_into)) {
      mergeTargets.add(c.merge_into);
    }
  }

  for (const c of classifications) {
    if (!c.merge_into || c.merge_into === c.id || !existingIds.has(c.merge_into)) continue;
    // Don't merge an org that is itself a merge target
    if (mergeTargets.has(c.id)) {
      result.errors.push(`Skipped merge of id=${c.id} — it is also a merge target`);
      continue;
    }

    try {
      await mergeOrgs(c.id, c.merge_into);
      existingIds.delete(c.id);
      result.merged++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Merge ${c.id} → ${c.merge_into}: ${msg}`);
    }
  }

  // Phase 2: Archive non-orgs (persons, events, programs, junk) that weren't merged
  for (const c of classifications) {
    if (c.keep || c.merge_into) continue;
    if (!existingIds.has(c.id)) continue; // Already merged/deleted

    try {
      await archiveOrg(c.id);
      existingIds.delete(c.id);
      result.archived++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Archive ${c.id}: ${msg}`);
    }
  }

  // Phase 3: Set parent links
  for (const c of classifications) {
    if (!c.parent_id || c.parent_id === c.id) continue;
    if (!existingIds.has(c.id) || !existingIds.has(c.parent_id)) continue;

    try {
      await pool.query(
        `UPDATE org_profiles SET parent_org_id = $1, updated_at = NOW() WHERE id = $2`,
        [c.parent_id, c.id]
      );
      result.parentLinked++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Parent link ${c.id} → ${c.parent_id}: ${msg}`);
    }
  }

  result.kept = [...existingIds].length;

  console.log(`[OrgDedup] Complete: ${result.merged} merged, ${result.archived} archived, ${result.parentLinked} parent-linked, ${result.kept} kept, ${result.errors.length} errors`);
  return result;
}
