/** Read-only census: Notion Orgs pages vs Postgres org_profiles (untracked). */
import { getPool } from '../db';

async function main() {
  const pool = getPool();
  const integ = await pool.query(`SELECT config FROM integration_config WHERE provider='notion' AND enabled=true LIMIT 1`);
  const token = integ.rows[0]?.config?.notion_token;
  const dbId = integ.rows[0]?.config?.database_id;
  if (!token || !dbId) { console.error('no notion config'); process.exit(1); }

  const { rows: orgs } = await pool.query(`SELECT id, name FROM org_profiles`);
  const pgNames = new Set(orgs.map((o: any) => o.name.trim().toLowerCase()));
  console.error(`[census] postgres orgs: ${orgs.length}`);

  // paginate all pages in the Notion Orgs database
  const pages: any[] = [];
  let cursor: string | undefined;
  do {
    const resp: any = await (await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    })).json();
    if (!resp.results) { console.error('ERR', JSON.stringify(resp).slice(0, 300)); process.exit(1); }
    pages.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
    console.error(`[census] fetched ${pages.length} pages...`);
  } while (cursor);

  // resolve distinct creator ids -> bot/person
  const creatorIds = [...new Set(pages.map(p => p.created_by?.id).filter(Boolean))];
  const creators: Record<string, string> = {};
  for (const id of creatorIds) {
    try {
      const u: any = await (await fetch(`https://api.notion.com/v1/users/${id}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
      })).json();
      creators[id] = u.type === 'bot' ? `bot:${u.name || 'unknown'}` : `person:${u.name || u.id}`;
    } catch { creators[id] = 'unknown'; }
  }
  console.error('[census] creators:', JSON.stringify(creators));

  const orphans = pages.filter(p => {
    const title = (p.properties?.Name?.title || []).map((t: any) => t.plain_text).join('').trim();
    return title && !pgNames.has(title.toLowerCase());
  }).map(p => ({
    id: p.id,
    name: (p.properties?.Name?.title || []).map((t: any) => t.plain_text).join('').trim(),
    creator: creators[p.created_by?.id] || 'unknown',
    created: p.created_time?.slice(0, 10),
    edited: p.last_edited_time?.slice(0, 10),
  }));

  const byCreator: Record<string, number> = {};
  for (const o of orphans) byCreator[o.creator] = (byCreator[o.creator] || 0) + 1;
  console.error(`[census] total pages: ${pages.length} | matched: ${pages.length - orphans.length} | ORPHANS: ${orphans.length}`);
  console.error('[census] orphans by creator:', JSON.stringify(byCreator));

  console.log('===ORPHANS_JSON===');
  console.log(JSON.stringify(orphans));
  console.log('===END===');
  await pool.end();
}
main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e); process.exit(1); });
