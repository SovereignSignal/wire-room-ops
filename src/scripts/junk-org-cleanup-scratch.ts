/** Data-quality batch: snapshot + delete curated junk org rows + archive their Notion pages (untracked). */
import { getPool } from '../db';
import * as fs from 'fs';

const JUNK_IDS = [6,106,108,107,59,44,49,41,48,50,46,45,11,210,254,214,211,368,235,359,225,233,358,360,226,229,241,228,36,367,223,357,238,361,248,249,8,364];

async function main() {
  const pool = getPool();

  // 1) snapshot full rows
  const { rows: snap } = await pool.query(`SELECT * FROM org_profiles WHERE id = ANY($1)`, [JUNK_IDS]);
  fs.writeFileSync('/tmp/junk-org-snapshot.json', JSON.stringify(snap, null, 1));
  console.log(`[cleanup] snapshot: ${snap.length} rows -> /tmp/junk-org-snapshot.json`);
  if (snap.length !== JUNK_IDS.length) {
    console.log('[cleanup] WARN: id count mismatch', JUNK_IDS.filter(i => !snap.some((s: any) => s.id === i)));
  }

  // 2) safety: any awards / parent references?
  const { rows: aw } = await pool.query(`SELECT id FROM awards WHERE funder_org_id = ANY($1)`, [JUNK_IDS]);
  const { rows: par } = await pool.query(`SELECT id, name FROM org_profiles WHERE parent_org_id = ANY($1)`, [JUNK_IDS]);
  console.log(`[cleanup] awards refs: ${aw.length} | child orgs: ${par.length}`);
  if (aw.length || par.length) { console.log('[cleanup] ABORT — unexpected references'); process.exit(1); }

  // 3) unlink + delete in one transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const un = await client.query(`UPDATE scan_entries SET org_id = NULL WHERE org_id = ANY($1)`, [JUNK_IDS]);
    const del = await client.query(`DELETE FROM org_profiles WHERE id = ANY($1)`, [JUNK_IDS]);
    await client.query('COMMIT');
    console.log(`[cleanup] unlinked entries: ${un.rowCount} | deleted orgs: ${del.rowCount}`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  // 4) archive matching Notion pages (by exact name)
  const integ = await pool.query(`SELECT config FROM integration_config WHERE provider='notion' AND enabled=true LIMIT 1`);
  const token = integ.rows[0]?.config?.notion_token;
  const dbId = integ.rows[0]?.config?.database_id;
  let archived = 0, misses = 0;
  for (const org of snap) {
    const q: any = await (await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { property: 'Name', title: { equals: org.name } }, page_size: 5 }),
    })).json();
    for (const page of q.results || []) {
      await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
      archived++;
    }
    if (!(q.results || []).length) misses++;
    await new Promise(r => setTimeout(r, 350));
  }
  console.log(`[cleanup] notion pages archived: ${archived} | no-page orgs: ${misses}`);
  await pool.end();
}
main().then(() => process.exit(0)).catch(e => { console.error('[cleanup] FAILED:', e); process.exit(1); });
