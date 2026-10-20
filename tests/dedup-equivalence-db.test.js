require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping dedup equivalence DB test: DATABASE_URL not set');
  process.exit(0);
}

const { getPool, closePool, findSeenUrls } = require('../src/db');
const { registerSeen, checkDuplicate } = require('../src/services/dedup');

const tag = `${process.pid}-${Date.now()}`;
const ids = [];

async function insertEntry(pool, { name, url, wire = 'oss', status = 'queued' }) {
  const row = await pool.query(
    `INSERT INTO scan_entries (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status)
     VALUES ($1, 'dedup equivalence fixture', $2, $3, 'P', 'web-search', '2026-10-20', $4)
     RETURNING id`,
    [name, url, wire, status],
  );
  const id = row.rows[0].id;
  ids.push(id);
  await registerSeen(pool, { id, sourceUrl: url, name, wire, scanDate: '2026-10-20' });
  return id;
}

test.after(async () => {
  const pool = getPool();
  await pool.query(`DELETE FROM seen_names WHERE entry_id = ANY($1::bigint[])`, [ids]);
  await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1::bigint[])`, [ids]);
  await pool.query(`DELETE FROM scan_entries WHERE id = ANY($1::bigint[])`, [ids]);
  await closePool();
});

test('a different spelling of a stored URL is an exact URL duplicate', async () => {
  const pool = getPool();
  const stored = `https://equiv-${tag}.example.org/apply`;
  const id = await insertEntry(pool, { name: `Equivalence Fund ${tag}`, url: stored });

  for (const spelling of [
    `http://www.equiv-${tag}.example.org/apply/`,
    `https://equiv-${tag}.example.org/apply#:~:text=Apply%20now`,
    `https://equiv-${tag}.example.org/apply?srsltid=AfmBOoq`,
  ]) {
    const result = await checkDuplicate(pool, { sourceUrl: spelling, name: `Unrelated title ${tag}`, wire: 'oss' });
    assert.equal(result.isDuplicate, true, spelling);
    assert.equal(result.matchType, 'url_exact', spelling);
    assert.equal(result.matchedEntryId, id, spelling);
  }

  const otherPage = await checkDuplicate(pool, {
    sourceUrl: `https://equiv-${tag}.example.org/apply-2027`,
    name: `Unrelated title ${tag}`,
    wire: 'oss',
  });
  assert.equal(otherPage.isDuplicate, false);

  const otherWire = await checkDuplicate(pool, { sourceUrl: `http://www.equiv-${tag}.example.org/apply`, name: `Unrelated ${tag}`, wire: 'ai' });
  assert.equal(otherWire.isDuplicate, false, 'URL ownership stays per wire');
});

test('Parallel early dedup sees a stored page under another spelling', async () => {
  const pool = getPool();
  const stored = `https://early-${tag}.example.org/grants`;
  await insertEntry(pool, { name: `Early Dedup Grants ${tag}`, url: stored });
  const incoming = [`http://www.early-${tag}.example.org/grants/`, `https://early-${tag}.example.org/grants-2`];
  const seen = await findSeenUrls(pool, incoming, 'oss');
  assert.deepEqual([...seen], [incoming[0]]);
});

test('punctuation and spacing differences are an exact name duplicate', async () => {
  const pool = getPool();
  const id = await insertEntry(pool, { name: `OpenSats ${tag} — General Fund`, url: `https://name-${tag}.example.org/a` });

  const same = await checkDuplicate(pool, {
    sourceUrl: `https://name-${tag}.example.org/b`,
    name: `opensats ${tag}: General  Fund.`,
    wire: 'oss',
  });
  assert.equal(same.isDuplicate, true);
  assert.equal(same.matchType, 'name_exact');
  assert.equal(same.matchedEntryId, id);

  const nextRound = await checkDuplicate(pool, {
    sourceUrl: `https://name-${tag}.example.org/c`,
    name: `OpenSats ${tag} — General Fund Round 2`,
    wire: 'oss',
  });
  assert.equal(nextRound.isDuplicate, false);
});

test('a non-ASCII word is never folded away', async () => {
  const pool = getPool();
  await insertEntry(pool, { name: `Fondation ${tag} Ñ Grants`, url: `https://fold-${tag}.example.org/a` });
  const result = await checkDuplicate(pool, {
    sourceUrl: `https://fold-${tag}.example.org/b`,
    name: `Fondation ${tag} Grants`,
    wire: 'oss',
  });
  assert.equal(result.isDuplicate, false);
});
