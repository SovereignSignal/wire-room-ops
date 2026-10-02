require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkDuplicate,
  registerSeenInTransaction,
  prematureDeclineNote,
  isOfficialNonSocialSource,
} = require('../src/services/dedup');
const { hasNewCycleStamp } = require('../src/services/classifier');

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
const RATIONALE = 'No official 2026 Round 2 announcement, September 19 opening, or October 17 deadline was found…';
const PRIOR_NAME = 'NumFOCUS Small Development Grants — 2026 Round 2';
const INCOMING_NAME = 'NumFOCUS SDG 2026 Round 2 — CFP open (due Oct 17)';
const DECLINED_AT = '2026-08-11T15:04:00.000Z';
const ARRIVED_AT = '2026-10-02T12:00:00.000Z';

function numfocusPrior(overrides = {}) {
  return {
    id: 14294,
    status: 'declined',
    curatorAt: DECLINED_AT,
    decisionAt: '2026-08-11T15:00:00.000Z',
    rationale: RATIONALE,
    actionReason: null,
    ...overrides,
  };
}

function numfocusRow(overrides = {}) {
  const prior = numfocusPrior(overrides);
  return {
    first_seen_entry_id: prior.id,
    name: PRIOR_NAME,
    url: NUMFOCUS_URL,
    deadline: '2026-10-17',
    deadline_parsed: '2026-10-17',
    status: prior.status,
    decision_at: prior.decisionAt,
    action_reason: prior.actionReason,
    metadata: {
      curator: {
        route: 'decline',
        confidence: 'med',
        rationale: prior.rationale,
        by: 'stringer',
        at: prior.curatorAt,
      },
    },
  };
}

function numfocusSibling(overrides = {}) {
  const row = numfocusRow(overrides);
  return {
    id: row.first_seen_entry_id,
    name: row.name,
    deadline: row.deadline,
    deadline_parsed: row.deadline_parsed,
    status: row.status,
    decision_at: row.decision_at,
    action_reason: row.action_reason,
    metadata: row.metadata,
  };
}

function incomingEntry(overrides = {}) {
  return {
    sourceUrl: NUMFOCUS_URL,
    name: INCOMING_NAME,
    wire: 'oss',
    excludeEntryId: 18508,
    deadline: '2026-10-17',
    createdAt: ARRIVED_AT,
    ...overrides,
  };
}

test('prematureDeclineNote: NumFOCUS #14294 yields to #18508 after the curator decline', () => {
  const note = prematureDeclineNote(
    { createdAt: ARRIVED_AT, sourceUrl: NUMFOCUS_URL },
    numfocusPrior(),
  );
  assert.equal(note, `Re-surfaced after premature decline of #14294: "${RATIONALE}"`);
  assert.equal(hasNewCycleStamp({ operatorNotes: note }), false);
});

test('prematureDeclineNote timing: strictly after the later decline stamp', () => {
  const official = { sourceUrl: NUMFOCUS_URL };
  assert.equal(prematureDeclineNote({ ...official, createdAt: DECLINED_AT }, numfocusPrior()), null, 'equal to curator.at still blocks');
  assert.equal(prematureDeclineNote({ ...official, createdAt: '2026-08-11T14:00:00.000Z' }, numfocusPrior()), null);
  assert.equal(
    prematureDeclineNote(
      { ...official, createdAt: '2026-09-01T00:00:00.000Z' },
      numfocusPrior({ decisionAt: '2026-09-15T00:00:00.000Z' }),
    ),
    null,
    'a later re-decline still blocks a submission that landed between the stamps',
  );
  assert.equal(prematureDeclineNote({ ...official, createdAt: ARRIVED_AT }, numfocusPrior({ curatorAt: null, decisionAt: null })), null);
  assert.equal(prematureDeclineNote({ ...official, createdAt: null }, numfocusPrior()), null);
});

test('prematureDeclineNote: substantive declines keep blocking, including when they also say not found', () => {
  const incoming = { createdAt: ARRIVED_AT, sourceUrl: NUMFOCUS_URL };
  for (const actionReason of [
    'off-scope',
    'out of scope',
    'scam',
    'not funding',
    'not a grant',
    'duplicate of approved #100',
    'dupe of an approved entry',
  ]) {
    assert.equal(
      prematureDeclineNote(incoming, numfocusPrior({ actionReason, rationale: RATIONALE })),
      null,
      actionReason,
    );
  }
  assert.equal(
    prematureDeclineNote(incoming, numfocusPrior({ rationale: 'No official announcement, but this is a scam' })),
    null,
  );
});

test('prematureDeclineNote source rule: official page or a premature rationale, not a social repost with no reason', () => {
  const arrived = { createdAt: ARRIVED_AT };
  assert.equal(isOfficialNonSocialSource(NUMFOCUS_URL), true);
  assert.equal(isOfficialNonSocialSource('https://x.com/numfocus/status/1'), false);
  assert.equal(isOfficialNonSocialSource('https://t.me/numfocus/42'), false);
  assert.equal(isOfficialNonSocialSource('https://www.opportunitydesk.org/numfocus'), false);
  assert.equal(isOfficialNonSocialSource('https://bit.ly/numfocus'), false);

  assert.match(
    prematureDeclineNote({ ...arrived, sourceUrl: NUMFOCUS_URL }, numfocusPrior({ rationale: null, actionReason: null })),
    /^Re-surfaced after premature decline of #14294: "later official source"$/,
  );
  assert.equal(
    prematureDeclineNote({ ...arrived, sourceUrl: 'https://x.com/numfocus/status/1' }, numfocusPrior({ rationale: null, actionReason: null })),
    null,
    'a tweet with no premature rationale stays a duplicate',
  );
  assert.match(
    prematureDeclineNote({ ...arrived, sourceUrl: 'https://x.com/numfocus/status/1' }, numfocusPrior()),
    /^Re-surfaced after premature decline of #14294:/,
    'a premature rationale re-surfaces even from a later social post',
  );
  assert.match(
    prematureDeclineNote(
      { ...arrived, sourceUrl: 'https://x.com/numfocus/status/1' },
      numfocusPrior({ rationale: null, actionReason: 'not yet announced' }),
    ),
    /not yet announced/,
  );
  assert.equal(
    prematureDeclineNote(
      { ...arrived, sourceUrl: 'https://x.com/numfocus/status/1' },
      numfocusPrior({ rationale: 'The October 17 deadline was found', actionReason: null }),
    ),
    null,
    'was found is not not-found',
  );
});

test('prematureDeclineNote ignores approved and queued priors and quotes a clipped rationale', () => {
  const incoming = { createdAt: ARRIVED_AT, sourceUrl: NUMFOCUS_URL };
  assert.equal(prematureDeclineNote(incoming, numfocusPrior({ status: 'approved' })), null);
  assert.equal(prematureDeclineNote(incoming, numfocusPrior({ status: 'queued' })), null);
  const long = `No official announcement. ${'x'.repeat(180)}`;
  const note = prematureDeclineNote(incoming, numfocusPrior({ rationale: long }));
  assert.match(note, /^Re-surfaced after premature decline of #14294: "/);
  assert.match(note, /…"$/);
  const quoted = note.slice(note.indexOf('"') + 1, -1);
  assert.equal(quoted.length, 160);
  assert.equal(quoted.endsWith('…'), true);
});

test('checkDuplicate: NumFOCUS #18508 re-surfaces after the premature decline of #14294', async () => {
  const pool = stubPool([
    { rows: [numfocusRow()] },
    { rows: [numfocusSibling()] },
  ]);

  const result = await checkDuplicate(pool, incomingEntry());

  assert.equal(result.isDuplicate, false);
  assert.equal(result.priorCycle ?? null, null);
  assert.deepEqual(result.resurfacedDecline, { entryId: 14294, name: PRIOR_NAME });
  assert.equal(result.reason, `Re-surfaced after premature decline of #14294: "${RATIONALE}"`);
  assert.equal(hasNewCycleStamp({ priorCycle: result.priorCycle, operatorNotes: result.reason }), false);
  assert.equal(pool.calls.length, 2, 'the name layer must not re-kill the same round');
  assert.match(pool.calls[1].sql, /decision_at/);
  assert.doesNotMatch(pool.calls[1].sql, /lower\(btrim\(name\)\)/);
});

test('checkDuplicate: the same NumFOCUS name on the official page also re-surfaces', async () => {
  const pool = stubPool([
    { rows: [numfocusRow()] },
    { rows: [numfocusSibling()] },
  ]);

  const result = await checkDuplicate(pool, incomingEntry({ name: PRIOR_NAME }));

  assert.equal(result.isDuplicate, false);
  assert.match(result.reason, /^Re-surfaced after premature decline of #14294:/);
  assert.equal(pool.calls.length, 2);
});

test('checkDuplicate: a substantive decline of the same round still duplicates', async () => {
  const pool = stubPool([
    { rows: [numfocusRow({ rationale: RATIONALE, actionReason: 'off-scope, not a grant' })] },
  ]);

  const result = await checkDuplicate(pool, incomingEntry());

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchedEntryId, 14294);
  assert.equal(pool.calls.length, 1);
});

test('checkDuplicate: a submission from before the decline still duplicates', async () => {
  const pool = stubPool([
    { rows: [numfocusRow()] },
  ]);

  const result = await checkDuplicate(pool, incomingEntry({ createdAt: '2026-08-01T00:00:00.000Z' }));

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchedEntryId, 14294);
  assert.equal(pool.calls.length, 1);
});

test('checkDuplicate: a generic reprint stays a duplicate even when the prior decline was premature', async () => {
  const pool = stubPool([
    { rows: [numfocusRow()] },
  ]);

  const result = await checkDuplicate(pool, incomingEntry({ name: 'NumFOCUS Small Development Grants' }));

  assert.equal(result.isDuplicate, true);
  assert.equal(pool.calls.length, 1);
});

test('checkDuplicate: an open approved sibling of the same round still blocks the re-surface', async () => {
  const pool = stubPool([
    { rows: [numfocusRow()] },
    {
      rows: [
        numfocusSibling(),
        {
          id: 15000,
          name: 'NumFOCUS SDG 2026 Round 2',
          deadline: '2026-10-17',
          deadline_parsed: '2026-10-17',
          status: 'approved',
        },
      ],
    },
  ]);

  const result = await checkDuplicate(pool, incomingEntry());

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchedEntryId, 15000);
});

test('checkDuplicate: a queued same-round sibling still blocks the re-surface', async () => {
  const pool = stubPool([
    { rows: [numfocusRow()] },
    {
      rows: [
        numfocusSibling(),
        { id: 18000, name: INCOMING_NAME, deadline: '2026-10-17', status: 'queued' },
      ],
    },
  ]);

  const result = await checkDuplicate(pool, incomingEntry({ excludeEntryId: 18600 }));

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchedEntryId, 18000);
});

test('checkDuplicate: an earlier raw copy of the same round still blocks', async () => {
  const pool = stubPool([
    { rows: [numfocusRow()] },
    {
      rows: [
        numfocusSibling(),
        { id: 18500, name: INCOMING_NAME, deadline: '2026-10-17', status: 'raw' },
      ],
    },
  ]);

  const result = await checkDuplicate(pool, incomingEntry());

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchedEntryId, 18500);
});

test('atomic URL claim lets the NumFOCUS resubmission share the URL with the premature decline', async () => {
  const calls = [];
  const db = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('INSERT INTO seen_urls')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT su.first_seen_entry_id')) {
        const row = numfocusRow();
        return {
          rows: [{
            first_seen_entry_id: row.first_seen_entry_id,
            name: row.name,
            status: row.status,
            deadline: row.deadline,
            deadline_parsed: row.deadline_parsed,
            decision_at: row.decision_at,
            action_reason: row.action_reason,
            metadata: row.metadata,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM scan_entries') && sql.includes('deadline_parsed')) {
        return { rows: [numfocusSibling()], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO seen_names')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await registerSeenInTransaction(db, {
    id: 18508,
    sourceUrl: NUMFOCUS_URL,
    name: INCOMING_NAME,
    wire: 'oss',
    scanDate: '2026-10-02',
    deadline: '2026-10-17',
    createdAt: ARRIVED_AT,
  });

  assert.deepEqual(result, { urlConflict: false, conflictEntryId: null });
  assert.ok(calls.some(sql => sql.includes('INSERT INTO seen_names')));
  assert.ok(!calls.some(sql => sql.includes('SELECT created_at')));
});

test('atomic URL claim still conflicts when the same-round decline is substantive', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('INSERT INTO seen_urls')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT su.first_seen_entry_id')) {
        const row = numfocusRow({ actionReason: 'scam' });
        return {
          rows: [{
            first_seen_entry_id: row.first_seen_entry_id,
            name: row.name,
            status: 'declined',
            deadline: row.deadline,
            deadline_parsed: row.deadline_parsed,
            decision_at: row.decision_at,
            action_reason: 'scam',
            metadata: row.metadata,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await registerSeenInTransaction(db, {
    id: 18508,
    sourceUrl: NUMFOCUS_URL,
    name: INCOMING_NAME,
    wire: 'oss',
    scanDate: '2026-10-02',
    deadline: '2026-10-17',
    createdAt: ARRIVED_AT,
  });

  assert.deepEqual(result, { urlConflict: true, conflictEntryId: 14294 });
});
