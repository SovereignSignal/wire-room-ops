require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const grants = require('../src/db/runtime-grants');

const sql = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'database-runtime-grants.sql'), 'utf8');

function block(after, until) {
  const start = sql.indexOf(after);
  assert.notEqual(start, -1, `missing "${after}" in grants SQL`);
  const end = sql.indexOf(until, start + after.length);
  assert.notEqual(end, -1, `missing "${until}" in grants SQL`);
  return sql.slice(start + after.length, end);
}

const names = (text) => text.replace(/--[^\n]*/g, '').match(/[a-z_]+/g) || [];

// The migration command applies src/db/runtime-grants.ts; psql users apply the
// SQL file. A table added to one and not the other leaves the runtime role
// locked out after the next release.
test('the SQL grants file and the TypeScript grants list the same tables', () => {
  const writable = names(block('GRANT SELECT, INSERT, UPDATE, DELETE ON', 'TO :"runtime_role"'));
  assert.deepEqual([...writable].sort(), [...grants.RUNTIME_WRITABLE_TABLES].sort());

  const insertOnly = names(block('GRANT SELECT, INSERT ON', 'TO :"runtime_role"'));
  assert.deepEqual(insertOnly, [...grants.RUNTIME_INSERT_ONLY_TABLES]);

  const readOnly = names(block('GRANT SELECT ON', 'TO :"runtime_role"'));
  assert.deepEqual(readOnly, [...grants.RUNTIME_READ_ONLY_TABLES]);

  for (const table of grants.OPTIONAL_SHARED_WRITABLE_TABLES) {
    assert.match(sql, new RegExp(`GRANT SELECT, INSERT, UPDATE ON public\\.${table} TO`));
  }
  const optionalRead = names(block("unnest(ARRAY[", "])"));
  assert.deepEqual(optionalRead, [...grants.OPTIONAL_SHARED_READ_ONLY_TABLES]);

  const sequenceTables = names(block('AND table_name IN (', ')'));
  const expected = [
    ...grants.RUNTIME_WRITABLE_TABLES,
    ...grants.OPTIONAL_SHARED_WRITABLE_TABLES,
    ...grants.RUNTIME_INSERT_ONLY_TABLES,
  ];
  assert.deepEqual([...sequenceTables].sort(), [...expected].sort());
});

test('every table the migrations create is covered by a runtime grant', () => {
  const src = path.join(__dirname, '..', 'src');
  const created = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      for (const match of fs.readFileSync(full, 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (?:public\.)?([a-z_]+)/g)) {
        created.add(match[1]);
      }
    }
  };
  walk(src);
  const granted = new Set([
    ...grants.RUNTIME_WRITABLE_TABLES, ...grants.RUNTIME_INSERT_ONLY_TABLES, ...grants.RUNTIME_READ_ONLY_TABLES,
  ]);
  const uncovered = [...created].filter(table => !granted.has(table)).sort();
  assert.deepEqual(uncovered, []);
});

test('identifiers are quoted for GRANT statements', () => {
  assert.equal(grants.quoteIdent('wro_runtime'), '"wro_runtime"');
  assert.equal(grants.quoteIdent('odd"name'), '"odd""name"');
});
