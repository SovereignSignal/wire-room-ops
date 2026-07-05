/**
 * Backfill watch_surfaces from a Notion full-workspace export of Sov's Orgs
 * (the vault mirror), recovering the URL columns pruned from live Notion on
 * 2026-07-03 (PR #59). Export pages are markdown: "# Title" then "Key: value"
 * lines. Default DRY RUN; pass --write to persist.
 *
 * Usage: npx ts-node src/scripts/import-watch-surfaces-export.ts "<export-dir>" [--write]
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { upsertSurfaces, type SurfaceRow } from './import-watch-surfaces';
import type { SurfaceType } from '../types/intake';

const FIELD_MAP: Array<[string, SurfaceType]> = [
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

export function parseExportPage(md: string): { name: string | null; fields: Record<string, string> } {
  const lines = md.split('\n');
  const name = lines[0]?.startsWith('# ') ? lines[0].slice(2).trim() : null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const m = line.match(/^([A-Za-z()/'’ -]+?):\s+(.+)$/);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  return { name, fields };
}

export function pageToSurfaces(md: string): SurfaceRow[] {
  const { name, fields } = parseExportPage(md);
  if (!name) return [];
  const wireRaw = (fields['Wire'] || '').split(',')[0].trim();
  const wire = wireRaw ? wireRaw.toLowerCase() : null;
  const tier = fields['Tier'] || null;
  const rows: SurfaceRow[] = [];
  for (const [field, surfaceType] of FIELD_MAP) {
    const url = (fields[field] || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    rows.push({
      org_name: name, wire, surface_type: surfaceType, url, tier,
      source_of_truth: 'notion-export', notion_page_id: null,
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => a !== '--write');
  const write = process.argv.includes('--write');
  const dir = args[0];
  if (!dir) throw new Error('Usage: import-watch-surfaces-export.ts "<export-dir>" [--write]');
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  const seen = new Set<string>();
  const rows: SurfaceRow[] = [];
  for (const f of files) {
    for (const r of pageToSurfaces(readFileSync(join(dir, f), 'utf8'))) {
      const key = `${r.surface_type}|${r.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
  }
  const { byType } = await upsertSurfaces(rows, write);
  console.log(`[ExportImport] ${files.length} pages -> ${rows.length} surfaces ${write ? '(WRITTEN)' : '(dry run — pass --write to persist)'}`);
  for (const [t, n] of Object.entries(byType).sort()) console.log(`  ${t}: ${n}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('[ExportImport] FAILED:', err.message); process.exit(1); });
}
