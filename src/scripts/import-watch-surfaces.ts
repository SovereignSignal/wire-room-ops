/**
 * One-off Watchtower registry import: Notion Sov's Orgs -> watch_surfaces.
 * Default is DRY RUN (prints counts). Pass --write to persist.
 * Re-runnable: upserts on (surface_type, url).
 *
 * Usage: npx ts-node src/scripts/import-watch-surfaces.ts [--write]
 */
import { getPool } from '../db';
import { getIntegrationConfigs, queryAllNotionPages } from '../services/notion-sync';
import type { SurfaceType } from '../types/intake';

// Sov's Orgs database (page 301000c0d590815b826dd1ac087df53f wraps this db).
const ORGS_DATABASE_ID = '301000c0d59081c48435c6db7782db12';

export interface SurfaceRow {
  org_name: string;
  wire: string | null;
  surface_type: SurfaceType;
  url: string;
  tier: string | null;
  source_of_truth: string;
  notion_page_id: string | null;
}

const URL_COLUMN_MAP: Array<[string, SurfaceType]> = [
  ['Grants Program URL', 'grants_page'],
  ['Blog URL', 'blog'],
  ['Forum URL', 'forum'],
  ['RSS Feed URL', 'rss'],
  ['Application URL', 'application'],
  ['Website', 'website'],
  ['Twitter', 'x_account'],
  ['GitHub URL', 'github'],
  ['Career Page URL', 'career_page'],
];

type NotionProp = { type: string; [k: string]: unknown };
type NotionPage = { id: string; properties?: Record<string, NotionProp> };

function propUrl(p?: NotionProp): string | null {
  if (!p) return null;
  if (p.type === 'url') return typeof p.url === 'string' && p.url.trim() ? p.url.trim() : null;
  if (p.type === 'rich_text') {
    const rt = p.rich_text as Array<{ plain_text?: string }> | undefined;
    const s = rt?.map(t => t.plain_text || '').join('').trim();
    return s && /^https?:\/\//i.test(s) ? s : null;
  }
  return null;
}

function propTitle(p?: NotionProp): string | null {
  const t = p?.title as Array<{ plain_text?: string }> | undefined;
  const s = t?.map(x => x.plain_text || '').join('').trim();
  return s || null;
}

function propSelect(p?: NotionProp): string | null {
  const s = p?.select as { name?: string } | null | undefined;
  return s?.name || null;
}

function propFirstMultiSelect(p?: NotionProp): string | null {
  const arr = p?.multi_select as Array<{ name?: string }> | undefined;
  return arr?.[0]?.name || null;
}

/**
 * Notion URL columns are hand-edited, and two real failure shapes reached
 * production before this gate existed (found by the 2026-08-01 Tier 1 dry run):
 * an annotation pasted after the URL ("https://sam.gov (search DARPA)"), and
 * two URLs mashed into one field with a "|" separator (Aptos, Starknet).
 *
 * Splits on "|", strips one trailing "(annotation)" per fragment, and keeps
 * only fragments that are well-formed http(s) URLs. Dropped fragments warn so
 * the Notion field gets fixed rather than silently losing a surface.
 */
export function splitSurfaceUrls(raw: string | null | undefined): string[] {
  if (!raw) return [];
  // Remove whitespace-preceded "(annotation)" groups BEFORE splitting on "|":
  // the space anchor is what separates a human note ("https://sam.gov (search
  // DARPA)") from parens that belong to the URL path (".../wiki/Grant_(money)",
  // no space), and removing first means a "|" INSIDE an annotation can no
  // longer shear a good URL into two dead fragments.
  const withoutAnnotations = raw.replace(/\s+\([^)]*\)/g, ' ');
  const out: string[] = [];
  for (const fragment of withoutAnnotations.split('|')) {
    const candidate = fragment.trim();
    if (!candidate) continue;
    if (!/^https?:\/\/\S+$/.test(candidate)) {
      console.warn(`[SurfacesImport] dropping non-URL fragment: "${candidate.slice(0, 80)}"`);
      continue;
    }
    let parsed: URL;
    try { parsed = new URL(candidate); } catch { continue; }
    // An annotation stripped down to a bare domain is importable but a poor
    // hash-diff target (root pages churn on unrelated content) — keep it, and
    // nudge the operator to fix the Notion field.
    if (parsed.pathname === '/' && !parsed.search && /\s+\(/.test(raw)) {
      console.warn(`[SurfacesImport] annotation stripped to bare domain "${candidate}" — verify the Notion URL field`);
    }
    out.push(candidate);
  }
  return out;
}

export function mapOrgToSurfaces(page: NotionPage): SurfaceRow[] {
  const props = page.properties || {};
  const name = propTitle(props['Name']);
  if (!name) return [];
  const wireRaw = propFirstMultiSelect(props['Wire']);
  const wire = wireRaw ? wireRaw.toLowerCase() : null;
  const tier = propSelect(props['Tier']);
  const rows: SurfaceRow[] = [];
  for (const [column, surfaceType] of URL_COLUMN_MAP) {
    for (const url of splitSurfaceUrls(propUrl(props[column]))) {
      rows.push({
        org_name: name, wire, surface_type: surfaceType, url, tier,
        source_of_truth: 'notion-orgs', notion_page_id: page.id,
      });
    }
  }
  return rows;
}

// grant-wire-scout's validated per-wire source lists (run-producer.sh:47-57),
// carried in as seed surfaces so the parked producer's coverage isn't lost.
const scout = (org_name: string, wire: string, url: string): SurfaceRow => ({
  org_name, wire, surface_type: 'grants_page', url, tier: null,
  source_of_truth: 'scout-seed', notion_page_id: null,
});
export const SCOUT_SEED_SURFACES: SurfaceRow[] = [
  scout('Zcash Community', 'crypto', 'https://forum.zcashcommunity.com'),
  scout('Solana Foundation', 'crypto', 'https://solana.org/grants'),
  scout('Project Catalyst', 'crypto', 'https://cardano.ideascale.com'),
  scout('Ethereum Foundation', 'crypto', 'https://ethereum.org/en/community/grants/'),
  scout('Filecoin Foundation', 'crypto', 'https://fil.org/grants'),
  scout('Cosmos', 'crypto', 'https://cosmos.network'),
  scout('Gitcoin', 'crypto', 'https://www.gitcoin.co'),
  scout('Anthropic (safety)', 'ai', 'https://safety.anthropic.com'),
  scout('OpenAI (security)', 'ai', 'https://openai.com/security'),
  scout('NSF', 'ai', 'https://www.nsf.gov/funding/'),
  scout('Grants.gov', 'ai', 'https://www.grants.gov'),
  scout('ARIA', 'ai', 'https://www.aria.org.uk'),
  scout('FAR.AI', 'ai', 'https://far.ai'),
  scout('Apollo Research', 'ai', 'https://www.apolloresearch.ai'),
  scout('NLnet Foundation', 'oss', 'https://nlnet.nl'),
  scout('Sovereign Tech Agency', 'oss', 'https://www.sovereign.tech'),
  scout('Alpha-Omega', 'oss', 'https://alpha-omega.dev'),
  scout('FOSS Responders', 'oss', 'https://fossresponders.com'),
  scout('Open Collective', 'oss', 'https://opencollective.com'),
  scout('GitHub Sponsors', 'oss', 'https://github.com/sponsors'),
  scout('OpenSSF', 'oss', 'https://openssf.org'),
  scout('Linux Foundation', 'oss', 'https://www.linuxfoundation.org'),
  scout('Open Technology Fund', 'oss', 'https://www.opentech.fund'),
  scout('FreeBSD Foundation', 'oss', 'https://freebsdfoundation.org'),
];

export async function upsertSurfaces(rows: SurfaceRow[], write: boolean): Promise<{ byType: Record<string, number> }> {
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.surface_type] = (byType[r.surface_type] || 0) + 1;
  if (!write) return { byType };
  const pool = getPool();
  for (const r of rows) {
    await pool.query(
      `INSERT INTO watch_surfaces (org_name, wire, surface_type, url, tier, source_of_truth, notion_page_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (surface_type, url) DO UPDATE
         SET org_name = EXCLUDED.org_name, wire = COALESCE(EXCLUDED.wire, watch_surfaces.wire),
             tier = COALESCE(EXCLUDED.tier, watch_surfaces.tier),
             notion_page_id = COALESCE(EXCLUDED.notion_page_id, watch_surfaces.notion_page_id),
             updated_at = NOW()`,
      [r.org_name, r.wire, r.surface_type, r.url, r.tier, r.source_of_truth, r.notion_page_id],
    );
  }
  return { byType };
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const integrations = await getIntegrationConfigs('notion');
  const integration = integrations.find(i => i.enabled);
  const token = integration?.config?.notion_token;
  if (!token) throw new Error('No Notion integration configured (integration_config table)');
  console.log(`[Import] Querying Sov's Orgs (${ORGS_DATABASE_ID})...`);
  const pages = await queryAllNotionPages(token, ORGS_DATABASE_ID);
  const rows = pages.flatMap(p => mapOrgToSurfaces(p as NotionPage)).concat(SCOUT_SEED_SURFACES);
  const { byType } = await upsertSurfaces(rows, write);
  console.log(`[Import] ${pages.length} org pages -> ${rows.length} surfaces ${write ? '(WRITTEN)' : '(dry run — pass --write to persist)'}`);
  for (const [t, n] of Object.entries(byType).sort()) console.log(`  ${t}: ${n}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('[Import] FAILED:', err.message); process.exit(1); });
}
