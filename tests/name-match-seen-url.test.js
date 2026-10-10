require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping name-match seen URL test: DATABASE_URL not set');
  process.exit(0);
}

const { getPool, closePool, findSeenUrls } = require('../src/db');
const { registerSeen, finalizeExistingEntryDedup } = require('../src/services/dedup');

async function insertEntry(pool, fields) {
  const inserted = await pool.query(
    `INSERT INTO scan_entries (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status)
     VALUES ($1, $2, $3, $4, 'P', 'web-search', CURRENT_DATE, $5)
     RETURNING id`,
    [fields.name, fields.description, fields.url, fields.wire, fields.status],
  );
  return inserted.rows[0].id;
}

async function cleanup(pool, ids, urls) {
  await pool.query(`DELETE FROM seen_names WHERE entry_id = ANY($1::bigint[])`, [ids]);
  await pool.query(
    `DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1::bigint[]) OR url = ANY($2::text[])`,
    [ids, urls],
  );
  await pool.query(`DELETE FROM scan_entries WHERE id = ANY($1::bigint[])`, [ids]);
}

test('name-match duplicates are remembered and URL-exact matches keep their owner', async () => {
  const pool = getPool();
  const stamp = `${process.pid}-${Date.now()}`;
  const name = `Interledger Grant Program ${stamp}`;
  const parentUrl = `https://interledger.org/grants/${stamp}`;
  const childUrl = `https://www.facebook.com/interledger/posts/${stamp}`;
  const sharedUrl = `https://example.org/programs/${stamp}`;
  const ids = [];
  try {
    const parentId = await insertEntry(pool, {
      name, description: 'name match parent', url: parentUrl, wire: 'oss', status: 'approved',
    });
    const childId = await insertEntry(pool, {
      name, description: 'name match child', url: childUrl, wire: 'oss', status: 'raw',
    });
    ids.push(parentId, childId);
    await registerSeen(pool, {
      id: parentId, sourceUrl: parentUrl, name, wire: 'oss', scanDate: '2026-10-10',
    });
    const named = await finalizeExistingEntryDedup(pool, {
      id: childId, sourceUrl: childUrl, name, wire: 'oss', scanDate: '2026-10-10', expectedStatus: 'raw',
    }, 180);
    assert.equal(named.outcome, 'duplicate');
    assert.equal(named.canonicalParentId, parentId);
    const seen = await findSeenUrls(pool, [childUrl], 'oss');
    assert.equal(seen.has(childUrl), true);
    const namedOwner = await pool.query(
      `SELECT first_seen_entry_id FROM seen_urls WHERE url = $1 AND wire = 'oss'`,
      [childUrl],
    );
    assert.equal(Number(namedOwner.rows[0].first_seen_entry_id), parentId);

    const urlParent = await insertEntry(pool, {
      name: `Parent Program ${stamp}`, description: 'url parent', url: sharedUrl, wire: 'ai', status: 'approved',
    });
    const urlChild = await insertEntry(pool, {
      name: `Different Program ${stamp}`, description: 'url child', url: sharedUrl, wire: 'ai', status: 'raw',
    });
    ids.push(urlParent, urlChild);
    await registerSeen(pool, {
      id: urlParent, sourceUrl: sharedUrl, name: `Parent Program ${stamp}`, wire: 'ai', scanDate: '2026-10-10',
    });
    const exact = await finalizeExistingEntryDedup(pool, {
      id: urlChild,
      sourceUrl: sharedUrl,
      name: `Different Program ${stamp}`,
      wire: 'ai',
      scanDate: '2026-10-10',
      expectedStatus: 'raw',
    }, 180);
    assert.equal(exact.outcome, 'duplicate');
    const exactOwner = await pool.query(
      `SELECT first_seen_entry_id FROM seen_urls WHERE url = $1 AND wire = 'ai'`,
      [sharedUrl],
    );
    assert.equal(exactOwner.rows.length, 1);
    assert.equal(Number(exactOwner.rows[0].first_seen_entry_id), urlParent);
  } finally {
    await cleanup(pool, ids, [parentUrl, childUrl, sharedUrl]);
    await closePool();
  }
});
