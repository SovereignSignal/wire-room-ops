require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkDuplicate,
  registerSeenInTransaction,
  closedPriorRound,
  hasNewRoundSignal,
  reopenedRoundNote,
} = require('../src/services/dedup');

function stubPool(responses) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const responder = responses[calls.length - 1];
      if (!responder) throw new Error(`unexpected query #${calls.length}: ${sql}`);
      return typeof responder === 'function' ? responder(sql, params) : responder;
    },
  };
}

const NUMFOCUS_URL = 'https://numfocus.org/programs/small-development-grants';
const NOW = Date.parse('2026-10-02T12:00:00Z');

test('closedPriorRound: declined, archived, or past deadline closes the prior round', () => {
  assert.equal(closedPriorRound({ name: 'x', status: 'declined' }, NOW), 'declined');
  assert.equal(closedPriorRound({ name: 'x', status: 'archived' }, NOW), 'archived');
  assert.equal(
    closedPriorRound({ name: 'x', status: 'approved', deadlineParsed: new Date('2026-03-01') }, NOW),
    'deadline 2026-03-01 passed',
  );
  assert.equal(closedPriorRound({ name: 'x', status: 'approved', deadline: '2026-10-02' }, NOW), null, 'due today is still open');
  assert.equal(closedPriorRound({ name: 'x', status: 'queued', deadline: '2026-12-01' }, NOW), null);
  assert.equal(closedPriorRound({ name: 'x', status: 'approved', deadline: null }, NOW), null);
  assert.equal(closedPriorRound({ name: 'x', status: 'approved', deadline: 'Oct 17' }, NOW), null, 'yearless text is not a past date');
});

test('hasNewRoundSignal needs the incoming entry to name a different round', () => {
  assert.equal(hasNewRoundSignal({ name: 'NumFOCUS SDG 2026 Round 2' }, { name: 'NumFOCUS SDG 2025 Round 2' }), true);
  assert.equal(hasNewRoundSignal({ name: 'NumFOCUS SDG 2026 Round 2' }, { name: 'NumFOCUS Small Development Grants' }), true);
  assert.equal(hasNewRoundSignal({ name: 'NumFOCUS SDG 2026 Round 2' }, { name: 'NumFOCUS SDG 2026 Round 2' }), false);
  assert.equal(hasNewRoundSignal({ name: 'NumFOCUS Small Development Grants' }, { name: 'NumFOCUS SDG 2025 Round 2' }), false,
    'a generic reprint carries no round of its own');
  assert.equal(
    hasNewRoundSignal({ name: 'ISC Grants', deadline: '2026-10-17' }, { name: 'ISC Grants', deadline: '2026-03-01' }),
    true,
  );
  assert.equal(
    hasNewRoundSignal({ name: 'ISC Grants Round 3', deadline: '2026-10-17' }, { name: 'ISC Grants', deadline: '2026-10-17' }),
    false,
    'the same deadline is the same round whatever the name says',
  );
});

test('reopenedRoundNote only fires when the prior is closed and the incoming round differs', () => {
  const incoming = { name: 'NumFOCUS SDG 2026 Round 2' };
  assert.equal(reopenedRoundNote(incoming, { name: 'NumFOCUS SDG 2025 Round 2', status: 'declined' }, NOW), 'declined');
  assert.equal(reopenedRoundNote(incoming, { name: 'NumFOCUS SDG 2025 Round 2', status: 'approved', deadline: '2099-01-01' }, NOW), null,
    'an approved prior that is still open keeps the URL strict');
  assert.equal(reopenedRoundNote(incoming, { name: 'NumFOCUS SDG 2026 Round 2', status: 'declined' }, NOW), null);
});

test('checkDuplicate: NumFOCUS SDG 2026 Round 2 is not a duplicate of the declined older round on the same URL', async () => {
  const prior = { id: 14294, name: 'NumFOCUS SDG 2025 Round 2', deadline: '2025-06-13', deadline_parsed: null, status: 'declined' };
  const pool = stubPool([
    { rows: [{ first_seen_entry_id: 14294, name: prior.name, url: NUMFOCUS_URL, deadline: prior.deadline, deadline_parsed: null, status: 'declined' }] },
    { rows: [prior] },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: NUMFOCUS_URL,
    name: 'NumFOCUS SDG 2026 Round 2 — CFP open (due Oct 17)',
    wire: 'oss',
    excludeEntryId: 18508,
  });

  assert.equal(result.isDuplicate, false);
  assert.deepEqual(result.priorCycle, { entryId: 14294, name: 'NumFOCUS SDG 2025 Round 2' });
  assert.match(result.reason, /^New cycle of #14294: "NumFOCUS SDG 2025 Round 2" \(prior declined\)$/);
  assert.equal(pool.calls.length, 2, 'the name layer must not re-kill the reopened round');
});

test('checkDuplicate: an approved prior whose deadline passed yields to a new round on the same URL', async () => {
  const pool = stubPool([
    { rows: [{ first_seen_entry_id: 900, name: 'ISC Grant Program Round 2', url: 'https://r-consortium.org/cfp', deadline: null, deadline_parsed: new Date('2025-10-01'), status: 'approved' }] },
    { rows: [{ id: 900, name: 'ISC Grant Program Round 2', deadline: null, deadline_parsed: new Date('2025-10-01'), status: 'approved' }] },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://r-consortium.org/cfp',
    name: 'ISC Grant Program Round 2 2026',
    wire: 'oss',
  });

  assert.equal(result.isDuplicate, false);
  assert.equal(result.priorCycle.entryId, 900);
  assert.match(result.reason, /\(prior deadline 2025-10-01 passed\)$/);
});

test('checkDuplicate: the same round behind a declined prior still duplicates', async () => {
  const pool = stubPool([
    { rows: [{ first_seen_entry_id: 14294, name: 'NumFOCUS SDG 2026 Round 2', url: NUMFOCUS_URL, deadline: null, status: 'declined' }] },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: NUMFOCUS_URL,
    name: 'NumFOCUS SDG 2026 Round 2',
    wire: 'oss',
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchedEntryId, 14294);
  assert.equal(pool.calls.length, 1);
});

test('checkDuplicate: a generic reprint behind a declined prior still duplicates', async () => {
  const pool = stubPool([
    { rows: [{ first_seen_entry_id: 14294, name: 'NumFOCUS SDG 2025 Round 2', url: NUMFOCUS_URL, deadline: null, status: 'declined' }] },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: NUMFOCUS_URL,
    name: 'NumFOCUS Small Development Grants',
    wire: 'oss',
  }, 180, { urlOnly: true });

  assert.equal(result.isDuplicate, true);
  assert.equal(pool.calls.length, 1);
});

test('checkDuplicate: an approved prior that is still open keeps URL dedup strict', async () => {
  const pool = stubPool([
    { rows: [{ first_seen_entry_id: 14294, name: 'NumFOCUS SDG 2025 Round 2', url: NUMFOCUS_URL, deadline: '2099-01-01', status: 'approved' }] },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: NUMFOCUS_URL,
    name: 'NumFOCUS SDG 2026 Round 2',
    wire: 'oss',
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchedEntryId, 14294);
});

test('checkDuplicate: a queued open copy of the new round blocks a resubmit behind the declined prior', async () => {
  const pool = stubPool([
    { rows: [{ first_seen_entry_id: 14294, name: 'NumFOCUS SDG 2025 Round 2', url: NUMFOCUS_URL, deadline: null, status: 'declined' }] },
    {
      rows: [
        { id: 14294, name: 'NumFOCUS SDG 2025 Round 2', deadline: null, status: 'declined' },
        { id: 18508, name: 'NumFOCUS SDG 2026 Round 2 — CFP open (due Oct 17)', deadline: null, status: 'queued' },
      ],
    },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: NUMFOCUS_URL,
    name: 'NumFOCUS SDG 2026 Round 2',
    wire: 'oss',
    excludeEntryId: 18600,
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchedEntryId, 18508);
});

test('atomic URL claim lets a new round share the URL with a declined owner', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO seen_urls')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT su.first_seen_entry_id')) {
        return { rows: [{ first_seen_entry_id: 14294, name: 'NumFOCUS SDG 2025 Round 2', status: 'declined', deadline: null }], rowCount: 1 };
      }
      if (sql.includes('FROM scan_entries') && sql.includes('deadline_parsed')) {
        return { rows: [{ id: 14294, name: 'NumFOCUS SDG 2025 Round 2', deadline: null, status: 'declined' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO seen_names')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await registerSeenInTransaction(db, {
    id: 18508,
    sourceUrl: NUMFOCUS_URL,
    name: 'NumFOCUS SDG 2026 Round 2 — CFP open (due Oct 17)',
    wire: 'oss',
    scanDate: '2026-10-02',
  });

  assert.deepEqual(result, { urlConflict: false, conflictEntryId: null });
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO seen_names')));
});

test('atomic URL claim still conflicts on the same round behind a declined owner', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('INSERT INTO seen_urls')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT su.first_seen_entry_id')) {
        return { rows: [{ first_seen_entry_id: 14294, name: 'NumFOCUS SDG 2026 Round 2', status: 'declined', deadline: null }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await registerSeenInTransaction(db, {
    id: 18508,
    sourceUrl: NUMFOCUS_URL,
    name: 'NumFOCUS SDG 2026 Round 2',
    wire: 'oss',
    scanDate: '2026-10-02',
  });

  assert.deepEqual(result, { urlConflict: true, conflictEntryId: 14294 });
});
