require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { entryHeldSql } = require('../src/services/entry-hold');

test('the held condition covers notes, both recheck blocks, and a queued chain error', () => {
  const sql = entryHeldSql('e');
  assert.match(sql, /concat_ws\(' ', e\.operator_notes, e\.action_reason\) ~\* '\\mhold\\M\|human review required'/);
  assert.match(sql, /e\.metadata #>> '\{decided_recheck,canonical_parent_blocked\}' = 'true'/);
  assert.match(sql, /e\.metadata #>> '\{decided_recheck,cross_wire_blocked\}' = 'true'/);
  // A chain-error hold used to be recognised only through its note text. The
  // Stringer's curator stamp replaces operator_notes; on 2026-10-01 eight held
  // rows stayed held only because his text happened to contain the word "hold".
  assert.match(sql, /e\.status = 'queued' AND jsonb_typeof\(e\.metadata -> 'duplicate_chain_error'\) = 'object'/);
});

test('without an alias the columns are unqualified', () => {
  const sql = entryHeldSql();
  assert.match(sql, /concat_ws\(' ', operator_notes, action_reason\)/);
  assert.match(sql, /\(status = 'queued' AND jsonb_typeof\(metadata -> 'duplicate_chain_error'\) = 'object'\)/);
  assert.ok(!sql.includes('undefined'));
});

// Three copies of this condition drifted apart once already (the digest knew
// about chain errors, the linking guards did not). Keep exactly one.
test('the hold condition is defined in one place', () => {
  const src = path.join(__dirname, '..', 'src');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []);
  const owners = walk(src)
    .filter(file => fs.readFileSync(file, 'utf8').includes("human review required'"))
    .map(file => path.relative(src, file));
  assert.deepEqual(owners, ['services/entry-hold.ts']);
});
