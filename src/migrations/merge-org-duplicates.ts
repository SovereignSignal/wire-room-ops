/**
 * Conservative CRM org-duplicate merge.
 *
 * Only the reviewed same-entity pairs below. Does not run the LLM deduper.
 *
 *   npx ts-node src/scripts/merge-org-duplicates.ts --dry-run
 *   npx ts-node src/scripts/merge-org-duplicates.ts
 */

import type { Pool } from 'pg';
import { addOrgAlias, mergeOrgs, renameOrg } from '../services/org-merge';
import { archiveSimpleCrmOrgPages } from '../services/notion-sync';

export interface KnownOrgMerge {
  sourceName: string;
  targetName: string;
  /** Archive the source-named Sov's Orgs page. Default true. */
  archiveNotionSource?: boolean;
}

/**
 * Reviewed pairs only.
 *
 * Arbitrum's leftover Notion page is Watch-backed (registry / Programs /
 * Open Now) while Contacts live on Arbitrum Foundation — do not archive it.
 */
export const KNOWN_ORG_MERGES: KnownOrgMerge[] = [
  {
    sourceName: 'Rocket Pool Grants Management Committee',
    targetName: 'Rocket Pool',
    archiveNotionSource: true,
  },
  {
    sourceName: 'Arbitrum',
    targetName: 'Arbitrum Foundation',
    archiveNotionSource: false,
  },
];

export type OrgMergePlan =
  | {
      kind: 'merge';
      sourceId: number;
      targetId: number;
      sourceName: string;
      targetName: string;
      archiveNotionSource: boolean;
    }
  | {
      kind: 'rename';
      orgId: number;
      fromName: string;
      toName: string;
      archiveNotionSource: boolean;
    }
  | {
      kind: 'alias';
      targetId: number;
      targetName: string;
      alias: string;
      archiveNotionSource: boolean;
    }
  | {
      kind: 'skip';
      sourceName: string;
      targetName: string;
      reason: string;
    };

export interface OrgRow {
  id: number;
  name: string;
  aliases?: string[] | null;
}

export function planKnownOrgMerges(
  orgs: OrgRow[],
  pairs: KnownOrgMerge[] = KNOWN_ORG_MERGES,
): OrgMergePlan[] {
  const byName = new Map(orgs.map(o => [o.name.toLowerCase(), o]));
  return pairs.map((pair) => {
    const source = byName.get(pair.sourceName.toLowerCase());
    const target = byName.get(pair.targetName.toLowerCase());
    const archiveNotionSource = pair.archiveNotionSource !== false;

    if (source && target) {
      if (source.id === target.id) {
        return {
          kind: 'skip',
          sourceName: pair.sourceName,
          targetName: pair.targetName,
          reason: 'source and target are the same row',
        };
      }
      return {
        kind: 'merge',
        sourceId: source.id,
        targetId: target.id,
        sourceName: source.name,
        targetName: target.name,
        archiveNotionSource,
      };
    }

    if (source && !target) {
      return {
        kind: 'rename',
        orgId: source.id,
        fromName: source.name,
        toName: pair.targetName,
        archiveNotionSource,
      };
    }

    if (!source && target) {
      const aliases = target.aliases || [];
      if (aliases.some(a => a.toLowerCase() === pair.sourceName.toLowerCase())) {
        return {
          kind: 'skip',
          sourceName: pair.sourceName,
          targetName: target.name,
          reason: 'alias already present',
        };
      }
      return {
        kind: 'alias',
        targetId: target.id,
        targetName: target.name,
        alias: pair.sourceName,
        archiveNotionSource,
      };
    }

    return {
      kind: 'skip',
      sourceName: pair.sourceName,
      targetName: pair.targetName,
      reason: 'neither name exists in org_profiles',
    };
  });
}

export interface KnownMergeResult {
  dryRun: boolean;
  plans: OrgMergePlan[];
  merged: number;
  renamed: number;
  aliased: number;
  skipped: number;
  notionArchived: number;
  errors: string[];
}

export async function runKnownOrgMerges(
  pool: Pool,
  opts: { dryRun?: boolean } = {},
): Promise<KnownMergeResult> {
  const dryRun = !!opts.dryRun;
  const { rows: orgs } = await pool.query(
    `SELECT id, name, aliases FROM org_profiles ORDER BY id`,
  );
  const plans = planKnownOrgMerges(orgs);
  const result: KnownMergeResult = {
    dryRun,
    plans,
    merged: 0,
    renamed: 0,
    aliased: 0,
    skipped: 0,
    notionArchived: 0,
    errors: [],
  };

  for (const plan of plans) {
    if (plan.kind === 'skip') {
      result.skipped++;
      continue;
    }
    if (dryRun) continue;

    try {
      if (plan.kind === 'merge') {
        const merged = await mergeOrgs(plan.sourceId, plan.targetId, {
          archiveNotion: plan.archiveNotionSource,
        });
        result.merged++;
        result.notionArchived += merged.notionArchived;
      } else if (plan.kind === 'rename') {
        const renamed = await renameOrg(plan.orgId, plan.toName, {
          archiveNotion: plan.archiveNotionSource,
        });
        result.renamed++;
        result.notionArchived += renamed.notionArchived;
      } else if (plan.kind === 'alias') {
        await addOrgAlias(plan.targetId, plan.alias);
        result.aliased++;
        if (plan.archiveNotionSource) {
          const notion = await archiveSimpleCrmOrgPages([plan.alias]);
          result.notionArchived += notion.archived;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${plan.kind}: ${msg}`);
    }
  }

  return result;
}
