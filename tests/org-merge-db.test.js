require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../src/db');
const { mergeOrgs } = require('../src/services/org-merge');
const { ensureOrgProfilesTable } = require('../src/services/org-extractor');
const { ensureProgramsTable } = require('../src/services/program-identity');
const { ensureDiscoveredContactsTable } = require('../src/services/contact-discovery');

if (!process.env.DATABASE_URL) {
  console.log('Skipping org-merge DB tests: DATABASE_URL not set');
  process.exit(0);
}
const schema = `org_merge_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });

test.before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  test.mock.method(db, 'getPool', () => pool);
  await pool.query('CREATE TABLE scan_entries (id SERIAL PRIMARY KEY)');
  await ensureOrgProfilesTable();
  await ensureProgramsTable();
  // Mirror the watch-surface FK in this private schema; its migration uses a
  // module-local pool, so invoking it here would initialize the default schema.
  await pool.query(`CREATE TABLE watch_surfaces (
    id SERIAL PRIMARY KEY, org_id integer REFERENCES org_profiles(id) ON DELETE SET NULL,
    org_name text NOT NULL, surface_type text NOT NULL, url text NOT NULL,
    updated_at timestamptz DEFAULT now(), UNIQUE (surface_type, url)
  )`);
  await ensureDiscoveredContactsTable(pool);
});
test.beforeEach(async () => {
  await pool.query('TRUNCATE org_profiles, scan_entries, programs, watch_surfaces, discovered_contacts RESTART IDENTITY CASCADE');
});
test.after(async () => {
  test.mock.restoreAll();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function fixtures() {
  const { rows } = await pool.query(`INSERT INTO org_profiles (name, slug, wires, aliases)
    VALUES ('Source', 'source', '{ai}', '{Previous}'), ('Target', 'target', '{oss}', '{}') RETURNING id`);
  const [source, target] = rows.map(row => row.id);
  await pool.query('INSERT INTO scan_entries (org_id) VALUES ($1)', [source]);
  return { source, target };
}
async function contact(org, name, handle, page) {
  return (await pool.query(`INSERT INTO discovered_contacts (org_id, name_norm, name, x_handle, notion_page_id)
    VALUES ($1, lower($2), $2, $3, $4) RETURNING id`, [org, name, handle, page])).rows[0].id;
}

test('merge preserves contacts, complementary duplicate fields, programs, surfaces, and children', async () => {
  const { source, target } = await fixtures();
  const unique = await contact(source, 'Unique', '@unique', 'page-unique');
  await contact(source, 'Shared', '@shared', null);
  const shared = await contact(target, 'Shared', null, 'page-shared');
  await pool.query('UPDATE org_profiles SET parent_org_id = $1 WHERE id = $2', [source, target]);
  await pool.query(`INSERT INTO programs (canonical_name, normalized_key, org_id, org_name)
    VALUES ('Grant', 'grant', $1, 'Source')`, [source]);
  await pool.query(`INSERT INTO watch_surfaces (org_id, org_name, surface_type, url)
    VALUES ($1, 'Source', 'rss', 'https://example.invalid/rss')`, [source]);
  const result = await mergeOrgs(source, target, { archiveNotion: false });
  assert.equal(result.entriesRelinked, 1);
  const contacts = (await pool.query('SELECT * FROM discovered_contacts ORDER BY id')).rows;
  assert.equal(contacts.length, 2);
  assert.deepEqual(contacts.map(c => c.id), [unique, shared]);
  assert.ok(contacts.every(c => c.org_id === target));
  assert.equal(contacts[0].notion_page_id, 'page-unique');
  assert.equal(contacts[1].notion_page_id, 'page-shared');
  assert.equal(contacts[1].x_handle, '@shared');
  for (const table of ['scan_entries', 'programs', 'watch_surfaces']) {
    assert.equal((await pool.query(`SELECT org_id FROM ${table}`)).rows[0].org_id, target);
  }
  const orgs = (await pool.query('SELECT * FROM org_profiles')).rows;
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].parent_org_id, null, 'merge must not make the target its own parent');
  assert.equal(orgs[0].entry_count, 1);
  assert.deepEqual(orgs[0].wires, ['oss', 'ai']);
  assert.deepEqual(orgs[0].aliases, ['Source', 'Previous']);
});

test('conflicting contact identifiers abort without discarding either record', async () => {
  for (const field of ['page', 'handle']) {
    const { source, target } = await fixtures();
    await contact(source, 'Shared', field === 'handle' ? '@source' : null, field === 'page' ? 'source-page' : null);
    await contact(target, 'Shared', field === 'handle' ? '@target' : null, field === 'page' ? 'target-page' : null);
    await assert.rejects(mergeOrgs(source, target, { archiveNotion: false }), /conflicting contact identifiers/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_profiles')).rows[0].n, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM discovered_contacts')).rows[0].n, 2);
    assert.equal((await pool.query('SELECT org_id FROM scan_entries')).rows[0].org_id, source);
    await pool.query('TRUNCATE org_profiles, scan_entries RESTART IDENTITY CASCADE');
  }
});

test('late database failure rolls back contact moves and entry relinking', async () => {
  const { source, target } = await fixtures();
  await contact(source, 'Unique', '@unique', 'unique-page');
  // A real FK failure at the final DELETE exercises rollback of earlier writes.
  await pool.query('CREATE TABLE merge_blocker (org_id integer REFERENCES org_profiles(id))');
  try {
    await pool.query('INSERT INTO merge_blocker VALUES ($1)', [source]);
    await assert.rejects(mergeOrgs(source, target, { archiveNotion: false }), /foreign key/);
    assert.equal((await pool.query('SELECT org_id FROM discovered_contacts')).rows[0].org_id, source);
    assert.equal((await pool.query('SELECT org_id FROM scan_entries')).rows[0].org_id, source);
    assert.equal((await pool.query('SELECT aliases FROM org_profiles WHERE id = $1', [target])).rows[0].aliases.length, 0);
  } finally {
    await pool.query('DROP TABLE merge_blocker');
  }
});

test('merge works before optional contact discovery has created its table', async () => {
  const { source, target } = await fixtures();
  await pool.query('DROP TABLE discovered_contacts');
  try {
    assert.equal((await mergeOrgs(source, target, { archiveNotion: false })).sourceDeleted, true);
  } finally {
    await ensureDiscoveredContactsTable(pool);
  }
});
