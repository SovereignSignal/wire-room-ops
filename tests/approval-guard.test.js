// Pins the pre-approval validation gate: approve=publish, so the guard is the
// last line between bad data and the live Telegram channel. These mirror the
// documented block/warn contract in CLAUDE.md.
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateForApproval } = require('../src/services/approval-guard');

const healthy = {
  id: 1,
  name: 'NLnet Open Call',
  description: 'Open call for privacy-enhancing internet technology projects, 5k-50k EUR.',
  source_url: 'https://nlnet.nl/propose',
  classification: 'GRANT',
  quality_score: 80,
  deadline: '2026-08-01',
};

test('healthy entry passes with no errors', () => {
  const v = validateForApproval(healthy);
  assert.equal(v.valid, true);
  assert.deepEqual(v.errors, []);
});

test('empty description blocks approval', () => {
  const v = validateForApproval({ ...healthy, description: '' });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => /description/i.test(e)));
});

test('empty source_url blocks approval', () => {
  const v = validateForApproval({ ...healthy, source_url: '' });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => /source url/i.test(e)));
});

test('internal placeholder and unresolved shortener URLs block approval', () => {
  for (const url of ['scan://missing-1', 'https://t.me/manual/abc', 'https://t.co/abc123']) {
    const v = validateForApproval({ ...healthy, source_url: url });
    assert.equal(v.valid, false, `${url} should block`);
  }
});

test('EXPIRED classification warns but does not block', () => {
  const v = validateForApproval({ ...healthy, classification: 'EXPIRED' });
  assert.equal(v.valid, true);
  assert.ok(v.warnings.some(w => /EXPIRED/.test(w)));
});

test('oversized name and junk deadline warn but do not block', () => {
  const v = validateForApproval({
    ...healthy,
    name: 'X'.repeat(130),
    deadline: 'rolling; see site (details) for more information about deadlines',
  });
  assert.equal(v.valid, true);
  assert.ok(v.warnings.some(w => /120 characters/.test(w)));
  assert.ok(v.warnings.some(w => /junk/i.test(w)));
});
