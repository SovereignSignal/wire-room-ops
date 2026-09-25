require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { finalizeProgramForEntry, refreshProgramCounters } = require('../src/services/program-identity');
const { buildProgramIntegrityPlan, runProgramIntegrityRepair } = require('../src/services/program-integrity');
const { purgeSourceEntries } = require('../src/services/source-purge');
const { demoteEntryToDuplicateInTransaction } = require('../src/services/duplicate-chain');
const { linkEntryDuplicate } = require('../src/services/entry-maintenance');
const { planProgramOrgLinks, fillMissingProgramOrgLinks, repairProgramOrgLinks } = require('../src/services/program-org-links');
const { linkEntryToOrg } = require('../src/services/org-extractor');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping program-integrity DB tests: DATABASE_URL not set');
  process.exit(0);
}

const schema = `program_integrity_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: DB_URL });
const pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });

test.before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`
    CREATE TABLE org_profiles (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE programs (
      id SERIAL PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_key TEXT NOT NULL UNIQUE,
      org_name TEXT,
      org_id INTEGER REFERENCES org_profiles(id),
      wire TEXT,
      aliases TEXT[] NOT NULL DEFAULT '{}',
      canonical_url TEXT,
      url_domains TEXT[] NOT NULL DEFAULT '{}',
      canonical_entry_id INTEGER,
      latest_round_label TEXT,
      latest_deadline DATE,
      entry_count INTEGER NOT NULL DEFAULT 0,
      approved_count INTEGER NOT NULL DEFAULT 0,
      declined_count INTEGER NOT NULL DEFAULT 0,
      last_decision TEXT,
      first_seen DATE,
      last_seen DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE scan_entries (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      source_url TEXT NOT NULL DEFAULT 'https://example.test',
      deadline TEXT,
      wire TEXT NOT NULL DEFAULT 'ai',
      scan_source TEXT NOT NULL DEFAULT 'forum',
      status TEXT NOT NULL DEFAULT 'queued',
      distributable BOOLEAN NOT NULL DEFAULT true,
      duplicate_reason TEXT,
      actioned_by TEXT,
      action_reason TEXT,
      operator_notes TEXT,
      metadata JSONB DEFAULT '{}',
      program_id INTEGER REFERENCES programs(id),
      org_id INTEGER REFERENCES org_profiles(id),
      duplicate_of_id INTEGER REFERENCES scan_entries(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE seen_names (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES scan_entries(id)
    );
    CREATE TABLE seen_urls (
      id SERIAL PRIMARY KEY,
      first_seen_entry_id INTEGER NOT NULL REFERENCES scan_entries(id)
    );
    CREATE TABLE distribution_logs (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES scan_entries(id)
    );
  `);
});

test.beforeEach(async () => {
  await pool.query('TRUNCATE distribution_logs, seen_urls, seen_names, scan_entries, programs, org_profiles RESTART IDENTITY CASCADE');
});

async function orgLinkFixture() {
  await pool.query(`INSERT INTO org_profiles (name) VALUES ('Example Foundation'), ('Different Foundation');
    INSERT INTO programs (canonical_name, normalized_key, org_name)
      VALUES ('Example Grants', 'example', ' Example Foundation ');
    INSERT INTO scan_entries (name, program_id, org_id, status)
      VALUES ('Example round', 1, 1, 'approved')`);
}

test('program org links require exact names and approved nonduplicate member agreement', async () => {
  await orgLinkFixture();
  assert.deepEqual((await planProgramOrgLinks(pool)).links.map(x => [x.programId, x.orgId, x.evidenceEntryIds]), [[1, 1, [1]]]);
  await pool.query("UPDATE programs SET org_name = 'Example'");
  assert.equal((await planProgramOrgLinks(pool)).links.length, 0, 'no substring inference');
  await pool.query("UPDATE programs SET org_name = 'Example Foundation'; UPDATE scan_entries SET status='queued'");
  assert.equal((await planProgramOrgLinks(pool)).links.length, 0, 'a queued sighting is insufficient');
  await pool.query("UPDATE scan_entries SET status='approved', duplicate_of_id=1");
  assert.equal((await planProgramOrgLinks(pool)).links.length, 0, 'a linked duplicate is insufficient');
});

test('program org links leave contradictory members, holds and ambiguous org names unresolved', async () => {
  await orgLinkFixture();
  await pool.query("INSERT INTO scan_entries (name, program_id, org_id, status) VALUES ('Conflicting sighting',1,2,'duplicate')");
  assert.equal((await planProgramOrgLinks(pool)).links.length, 0);
  await pool.query('DELETE FROM scan_entries WHERE id=2');
  await pool.query("UPDATE scan_entries SET operator_notes='Curator HOLD: check identity'");
  assert.equal((await planProgramOrgLinks(pool)).links.length, 0);
  await pool.query("UPDATE scan_entries SET operator_notes=NULL; INSERT INTO org_profiles (name) VALUES ('example foundation')");
  assert.equal((await planProgramOrgLinks(pool)).links.length, 0);
});

test('program org repair rejects drift, fills missing links once and preserves resolved links', async () => {
  await orgLinkFixture();
  const plan = await repairProgramOrgLinks(pool);
  assert.equal(plan.applied, 0);
  await assert.rejects(() => repairProgramOrgLinks(pool, '0'.repeat(64)), /plan changed/);
  assert.equal((await pool.query('SELECT org_id FROM programs WHERE id=1')).rows[0].org_id, null);
  assert.equal((await repairProgramOrgLinks(pool, plan.planHash)).applied, 1);
  assert.equal((await repairProgramOrgLinks(pool)).links.length, 0);
  await pool.query('UPDATE programs SET org_id=2');
  assert.equal(await fillMissingProgramOrgLinks(pool, [1]), 0);
  assert.equal((await pool.query('SELECT org_id FROM programs WHERE id=1')).rows[0].org_id, 2);
});

test('normal approval counter refresh and later org extraction both fill the program link', async () => {
  await orgLinkFixture();
  await refreshProgramCounters(pool, [1]);
  assert.equal((await pool.query('SELECT org_id FROM programs WHERE id=1')).rows[0].org_id, 1);
  await pool.query('UPDATE programs SET org_id=NULL; UPDATE scan_entries SET org_id=NULL');
  const db = require('../src/db'); const original = db.getPool;
  db.getPool = () => pool;
  try { await linkEntryToOrg(1, 1); } finally { db.getPool = original; }
  assert.equal((await pool.query('SELECT org_id FROM programs WHERE id=1')).rows[0].org_id, 1);
});

test('the historical counter-repair command does not apply unreviewed organization links', async () => {
  await orgLinkFixture();
  const plan = await runProgramIntegrityRepair(pool, { apply: false });
  await runProgramIntegrityRepair(pool, { apply: true, expectedPlanHash: plan.planHash });
  assert.equal((await pool.query('SELECT org_id FROM programs WHERE id=1')).rows[0].org_id, null);
  assert.equal((await planProgramOrgLinks(pool)).links.length, 1);
});

test('org extraction rolls back the entry link if program reconciliation fails', async () => {
  await orgLinkFixture();
  await pool.query('UPDATE scan_entries SET org_id=NULL');
  const db = require('../src/db'); const original = db.getPool;
  db.getPool = () => ({ connect: async () => {
    const client = await pool.connect();
    return { release: () => client.release(), query: (sql, params) => {
      if (sql.includes('WITH eligible')) throw new Error('reconciliation failed');
      return client.query(sql, params);
    } };
  } });
  try { await assert.rejects(() => linkEntryToOrg(1, 1), /reconciliation failed/); }
  finally { db.getPool = original; }
  assert.equal((await pool.query('SELECT org_id FROM scan_entries WHERE id=1')).rows[0].org_id, null);
});

test('refreshProgramCounters repairs empty programs and never selects a duplicate canonical', async () => {
  const inserted = await pool.query(
    `INSERT INTO programs
       (canonical_name, normalized_key, entry_count, approved_count, canonical_entry_id, first_seen, last_seen)
     VALUES ('Repair Me', 'repairme', 99, 99, 9999, DATE '2020-01-01', DATE '2020-01-01'),
            ('Empty', 'empty', 5, 1, 8888, DATE '2020-01-01', DATE '2020-01-01'),
            ('Preserve', 'preserve', 0, 0, NULL, NULL, NULL)
     RETURNING id`,
  );
  const [repairId, emptyId, preserveId] = inserted.rows.map(row => row.id);
  const repairEntries = await pool.query(
    `INSERT INTO scan_entries (name, status, program_id, created_at, updated_at)
     VALUES ('Approved', 'approved', $1, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'),
            ('Duplicate', 'duplicate', $1, NOW(), NOW())
     RETURNING id, status`,
    [repairId],
  );
  const approvedId = repairEntries.rows.find(row => row.status === 'approved').id;
  const preserved = await pool.query(
    `INSERT INTO scan_entries (name, status, program_id, created_at)
     VALUES ('Older queue canonical', 'queued', $1, NOW() - INTERVAL '2 days'),
            ('Newer approved candidate', 'approved', $1, NOW())
     RETURNING id`,
    [preserveId],
  );
  await pool.query('UPDATE programs SET canonical_entry_id = $2 WHERE id = $1', [preserveId, preserved.rows[0].id]);

  assert.equal(await refreshProgramCounters(pool, [repairId, emptyId, preserveId]), 3);
  const rows = await pool.query('SELECT * FROM programs ORDER BY id');
  assert.equal(rows.rows[0].entry_count, 2);
  assert.equal(rows.rows[0].approved_count, 1);
  assert.equal(rows.rows[0].canonical_entry_id, approvedId);
  assert.equal(rows.rows[1].entry_count, 0);
  assert.equal(rows.rows[1].canonical_entry_id, null);
  assert.equal(rows.rows[1].first_seen, null);
  assert.equal(rows.rows[2].canonical_entry_id, preserved.rows[0].id, 'a valid existing canonical is preserved');
});

test('finalizeProgramForEntry links and counts one entry exactly once across retries', async () => {
  const program = await pool.query(
    `INSERT INTO programs (canonical_name, normalized_key) VALUES ('Alpha', 'alpha') RETURNING id`,
  );
  const entry = await pool.query(
    `INSERT INTO scan_entries (name, status) VALUES ('Alpha Round 2', 'queued') RETURNING id`,
  );
  const resolution = {
    programId: program.rows[0].id,
    confidence: 0.95,
    verdict: 'same_round',
    roundLabel: 'round 2',
    historyLine: 'seen 0×',
  };
  await finalizeProgramForEntry(pool, { id: entry.rows[0].id, name: 'Alpha Round 2' }, resolution);
  await finalizeProgramForEntry(pool, { id: entry.rows[0].id, name: 'Alpha Round 2' }, resolution);

  const linked = await pool.query('SELECT program_id, metadata, operator_notes FROM scan_entries WHERE id = $1', [entry.rows[0].id]);
  const state = await pool.query('SELECT entry_count, canonical_entry_id FROM programs WHERE id = $1', [program.rows[0].id]);
  assert.equal(linked.rows[0].program_id, program.rows[0].id);
  assert.equal(linked.rows[0].metadata.program.id, program.rows[0].id);
  assert.equal(state.rows[0].entry_count, 1);
  assert.equal(state.rows[0].canonical_entry_id, entry.rows[0].id);
  const repeatNotes = (linked.rows[0].operator_notes || '').match(/Program repeat/g) || [];
  assert.equal(repeatNotes.length, 1, 'same-round history note lands exactly once across retries');
});

test('linking historical approved and duplicate entries derives counts, dates and a valid canonical', async () => {
  const programId = (await pool.query("INSERT INTO programs (canonical_name, normalized_key) VALUES ('History', 'history') RETURNING id")).rows[0].id;
  const entries = (await pool.query(`INSERT INTO scan_entries (name, status, created_at, updated_at)
    VALUES ('Old duplicate', 'duplicate', '2024-01-10T12:00:00Z', '2024-01-11T12:00:00Z'),
           ('Reviewed grant', 'approved', '2024-02-10T12:00:00Z', '2024-02-11T12:00:00Z') RETURNING id, name`)).rows;
  const resolution = { programId, confidence: 0.95, verdict: 'same_round', roundLabel: null, historyLine: 'existing program' };
  await finalizeProgramForEntry(pool, entries[0], resolution);
  assert.equal((await pool.query('SELECT canonical_entry_id FROM programs WHERE id=$1', [programId])).rows[0].canonical_entry_id, null);
  await finalizeProgramForEntry(pool, entries[1], resolution);
  const state = (await pool.query(`SELECT entry_count, approved_count, canonical_entry_id,
    first_seen::text, last_seen::text, last_decision FROM programs WHERE id=$1`, [programId])).rows[0];
  assert.deepEqual(state, { entry_count: 2, approved_count: 1, canonical_entry_id: entries[1].id,
    first_seen: '2024-01-10', last_seen: '2024-02-10', last_decision: 'approved 2024-02-11' });
});

async function demotionFixture() {
  const programId = (await pool.query("INSERT INTO programs (canonical_name, normalized_key) VALUES ('Demotion', 'demotion') RETURNING id")).rows[0].id;
  const entries = (await pool.query(`INSERT INTO scan_entries (name, status, program_id)
    VALUES ('Former canonical', 'approved', $1), ('Surviving canonical', 'queued', $1) RETURNING id, source_url`, [programId])).rows;
  const [target, parent] = entries;
  await refreshProgramCounters(pool, [programId]);
  await pool.query('INSERT INTO seen_urls (first_seen_entry_id) VALUES ($1)', [target.id]);
  return { programId, target, parent };
}

for (const mode of ['automatic', 'operator']) {
  test(`${mode} duplicate demotion refreshes the former canonical and its decision counts in the transaction`, async () => {
    const { programId, target, parent } = await demotionFixture();
    if (mode === 'automatic') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await demoteEntryToDuplicateInTransaction(client, { targetId: target.id, requestedParentId: parent.id,
          expectedStatus: 'approved', expectedSourceUrl: target.source_url, reason: 'Confirmed repeat' });
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } else {
      await linkEntryDuplicate(pool, target.id, { duplicateOfId: parent.id, expectedStatus: 'approved',
        expectedSourceUrl: target.source_url, actor: 'user:test', reason: 'Confirmed repeat' });
    }
    const state = (await pool.query('SELECT entry_count, approved_count, canonical_entry_id, last_decision FROM programs WHERE id=$1', [programId])).rows[0];
    assert.deepEqual(state, { entry_count: 2, approved_count: 0, canonical_entry_id: parent.id, last_decision: null });
    assert.equal((await pool.query('SELECT first_seen_entry_id FROM seen_urls')).rows[0].first_seen_entry_id, parent.id);
  });
}

test('a program refresh failure rolls back the duplicate decision and URL transfer', async () => {
  const { programId, target, parent } = await demotionFixture();
  await pool.query(`CREATE FUNCTION reject_program_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'program refresh unavailable'; END $$`);
  await pool.query('CREATE TRIGGER reject_program_update BEFORE UPDATE ON programs FOR EACH ROW EXECUTE FUNCTION reject_program_update()');
  try {
    await assert.rejects(linkEntryDuplicate(pool, target.id, { duplicateOfId: parent.id, expectedStatus: 'approved',
      expectedSourceUrl: target.source_url, actor: 'user:test', reason: 'Confirmed repeat' }), /program refresh unavailable/);
    assert.equal((await pool.query('SELECT status FROM scan_entries WHERE id=$1', [target.id])).rows[0].status, 'approved');
    assert.equal((await pool.query('SELECT first_seen_entry_id FROM seen_urls')).rows[0].first_seen_entry_id, target.id);
    assert.equal((await pool.query('SELECT canonical_entry_id FROM programs WHERE id=$1', [programId])).rows[0].canonical_entry_id, target.id);
  } finally {
    await pool.query('DROP TRIGGER reject_program_update ON programs');
    await pool.query('DROP FUNCTION reject_program_update()');
  }
});

test('purgeSourceEntries replaces a deleted canonical and reparents surviving duplicates', async () => {
  const program = await pool.query(
    `INSERT INTO programs (canonical_name, normalized_key, entry_count, approved_count)
     VALUES ('Purge', 'purge', 3, 1) RETURNING id`,
  );
  const programId = program.rows[0].id;
  const victim = await pool.query(
    `INSERT INTO scan_entries (name, status, program_id, scan_source, created_at)
     VALUES ('Victim', 'approved', $1, 'forum', NOW() - INTERVAL '2 days') RETURNING id`,
    [programId],
  );
  const survivor = await pool.query(
    `INSERT INTO scan_entries (name, status, program_id, scan_source, created_at)
     VALUES ('Survivor', 'queued', $1, 'telegram', NOW() - INTERVAL '1 day') RETURNING id`,
    [programId],
  );
  const orphan = await pool.query(
    `INSERT INTO scan_entries (name, status, program_id, scan_source, duplicate_of_id, created_at)
     VALUES ('Duplicate', 'duplicate', $1, 'telegram', $2, NOW()) RETURNING id`,
    [programId, victim.rows[0].id],
  );
  await pool.query('UPDATE programs SET canonical_entry_id = $2 WHERE id = $1', [programId, victim.rows[0].id]);
  await pool.query('INSERT INTO seen_names (entry_id) VALUES ($1)', [victim.rows[0].id]);
  await pool.query('INSERT INTO seen_urls (first_seen_entry_id) VALUES ($1), ($2)', [victim.rows[0].id, orphan.rows[0].id]);
  await pool.query('INSERT INTO distribution_logs (entry_id) VALUES ($1)', [victim.rows[0].id]);

  const result = await purgeSourceEntries(pool, 'forum');
  assert.equal(result.deleted, 1);
  assert.equal(result.orphanPointersRepointed, 1);
  assert.equal(result.seenUrlOwnersReassigned, 1);
  const state = await pool.query('SELECT entry_count, approved_count, canonical_entry_id FROM programs WHERE id = $1', [programId]);
  assert.deepEqual(state.rows[0], { entry_count: 2, approved_count: 0, canonical_entry_id: survivor.rows[0].id });
  const pointer = await pool.query('SELECT duplicate_of_id FROM scan_entries WHERE id = $1', [orphan.rows[0].id]);
  assert.equal(pointer.rows[0].duplicate_of_id, survivor.rows[0].id);
  const owners = await pool.query('SELECT first_seen_entry_id FROM seen_urls');
  assert.deepEqual(owners.rows, [{ first_seen_entry_id: survivor.rows[0].id }]);
});

test('reviewed program-integrity plan applies cleanly and is idempotent', async () => {
  const program = await pool.query(
    `INSERT INTO programs (canonical_name, normalized_key, entry_count)
     VALUES ('Integrity', 'integrity', 9) RETURNING id`,
  );
  const canonical = await pool.query(
    `INSERT INTO scan_entries (name, status, program_id, created_at)
     VALUES ('Canonical', 'approved', $1, NOW() - INTERVAL '1 day') RETURNING id`,
    [program.rows[0].id],
  );
  const orphan = await pool.query(
    `INSERT INTO scan_entries (name, status, program_id)
     VALUES ('Orphan', 'duplicate', $1) RETURNING id`,
    [program.rows[0].id],
  );
  await pool.query('INSERT INTO seen_urls (first_seen_entry_id) VALUES ($1)', [orphan.rows[0].id]);

  const plan = await buildProgramIntegrityPlan(pool);
  assert.equal(plan.planned.programRows.length, 1);
  assert.equal(plan.planned.orphanLinks.length, 1);
  const receipt = await runProgramIntegrityRepair(pool, { apply: true, expectedPlanHash: plan.planHash });
  assert.deepEqual(receipt.applied, { programRows: 1, orphanLinks: 1, seenUrlOwnerRows: 1 });
  const second = await buildProgramIntegrityPlan(pool);
  assert.equal(second.planned.programRows.length, 0);
  assert.equal(second.planned.orphanLinks.length, 0);
  const state = await pool.query('SELECT entry_count, approved_count, canonical_entry_id FROM programs WHERE id = $1', [program.rows[0].id]);
  assert.deepEqual(state.rows[0], { entry_count: 2, approved_count: 1, canonical_entry_id: canonical.rows[0].id });
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
