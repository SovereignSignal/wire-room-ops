/**
 * Remove pure-digest orgs (and the contacts cascaded from them) from the grants CRM.
 * Snapshot-first + reversible. Run:
 *   railway run npx ts-node src/scripts/cleanup-digest-orgs.ts          # dry-run
 *   railway run npx ts-node src/scripts/cleanup-digest-orgs.ts --apply  # archive Notion + delete DB
 *
 * "Pure-digest" = linked to a digest summary but NEVER to a grant scan_entry, and not a
 * funder in `awards`. Deleting these cascades to digest_item_orgs, org_weekly_snapshots,
 * and discovered_contacts (the people found FOR those digest orgs — also not grant-relevant).
 */
import { writeFileSync } from 'fs';
import { getPool } from '../db';
import { getIntegrationConfigs, notionRequest, queryAllNotionPages } from '../services/notion-sync';

async function archiveByName(token: string | undefined, dbId: string | undefined, names: string[], label: string, apply: boolean): Promise<number> {
  if (!token || !dbId) { console.log(`  ${label}: no token/db id — skipping Notion`); return 0; }
  const pages = await queryAllNotionPages(token, dbId);
  const byName = new Map<string, string>();
  for (const pg of pages as Array<{ id: string; properties: Record<string, { title?: Array<{ plain_text: string }> }> }>) {
    const np = pg.properties['Name'] || pg.properties['name'] || pg.properties['Title'] || pg.properties['title'];
    const nm = np?.title?.map(t => t.plain_text).join('').toLowerCase().trim();
    if (nm) byName.set(nm, pg.id);
  }
  let n = 0;
  for (const name of names) {
    const pid = byName.get((name || '').toLowerCase().trim());
    if (!pid) continue;
    if (apply) await notionRequest('PATCH', `/pages/${pid}`, token, { archived: true });
    n++;
  }
  console.log(`  ${label}: ${n}/${names.length} pages ${apply ? 'archived' : 'matched (dry-run)'} (of ${pages.length} in DB)`);
  return n;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = getPool();

  const PURE_DIGEST = `o.id in (select org_id from digest_item_orgs)
    and o.id not in (select org_id from scan_entries where org_id is not null)
    and o.id not in (select funder_org_id from awards where funder_org_id is not null)`;

  const orgs = (await pool.query(`select id, name from org_profiles o where ${PURE_DIGEST} order by id`)).rows as Array<{ id: number; name: string }>;
  const ids = orgs.map(o => o.id);
  const contacts = (await pool.query(`select id, name from discovered_contacts where org_id = any($1::int[])`, [ids])).rows as Array<{ id: number; name: string }>;
  console.log(`\n=== Digest-org cleanup ${apply ? '(APPLYING)' : '(dry-run)'} — ${orgs.length} orgs + ${contacts.length} cascaded contacts ===\n`);

  // 1. Snapshot full rows (reversibility)
  const orgRows = (await pool.query(`select * from org_profiles where id = any($1::int[])`, [ids])).rows;
  const contactRows = (await pool.query(`select * from discovered_contacts where org_id = any($1::int[])`, [ids])).rows;
  const snapPath = '/Users/home/Documents/Claude/digest-cleanup-snapshot.json';
  writeFileSync(snapPath, JSON.stringify({ when: new Date().toISOString(), orgs: orgRows, contacts: contactRows }, null, 2));
  console.log(`Snapshot: ${snapPath} (${orgRows.length} orgs, ${contactRows.length} contacts)`);

  // 2. Archive Notion pages (orgs + contacts) by name
  const cfg = (await getIntegrationConfigs('notion'))[0];
  const token = cfg?.config?.notion_token as string | undefined;
  console.log('Notion:');
  await archiveByName(token, cfg?.config?.database_id as string | undefined, orgs.map(o => o.name), 'org pages', apply);
  await archiveByName(token, cfg?.config?.contacts_database_id as string | undefined, contacts.map(c => c.name), 'contact pages', apply);

  // 3. Delete org_profiles (cascade: digest_item_orgs, org_weekly_snapshots, discovered_contacts)
  if (apply) {
    const res = await pool.query(`delete from org_profiles where id = any($1::int[])`, [ids]);
    const remaining = (await pool.query('select count(*) c from org_profiles')).rows[0].c;
    console.log(`\nDELETED ${res.rowCount} org_profiles (cascade removed digest links + ${contacts.length} contacts). org_profiles now: ${remaining}`);
  } else {
    console.log(`\n(dry-run) would delete ${ids.length} orgs + cascade ${contacts.length} contacts. Re-run with --apply.`);
  }
  await pool.end();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
