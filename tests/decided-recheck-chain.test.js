require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyVerdict, resolveDuplicateChain } = require('../src/jobs/decided-recheck');
const auditFixture = require('./fixtures/semantic-dedup-audit-2026-08-11.json');

const TARGET = {
  id: 11127,
  wire: 'ai',
  name: 'Anthropic Fellows Program (Sept 2026 cohort)',
  description: 'Applications for the September cohort.',
  source_url: 'https://job-boards.greenhouse.io/anthropic/jobs/1',
  deadline: null,
};

function candidate(overrides = {}) {
  return {
    id: 8572,
    wire: 'ai',
    name: 'Anthropic Fellows Program',
    status: 'duplicate',
    source_url: 'https://alignment.anthropic.com/x',
    decided_date: '2026-06-08',
    resolve_to: 8416,
    overlap: 3,
    domain_match: true,
    squash_match: true,
    ...overrides,
  };
}

const verdict = (overrides = {}) => ({
  matched_id: 8572,
  verdict: 'same_listing',
  confidence: 0.95,
  reason: 'same program, same cohort',
  ...overrides,
});

function fakePool(
  chainRows = [{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false }],
  options = {},
) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (/WHERE id = ANY\(\$1::bigint\[\]\)/.test(sql)) {
      const candidateStatus = options.currentCandidateStatus
        || (chainRows[0]?.id === 8572 && chainRows[0]?.depth === 0 ? chainRows[0].status : 'duplicate');
      const rows = options.lockedRows || [
        {
          id: TARGET.id,
          status: options.targetStatus || 'queued',
          duplicate_of_id: null,
          name: TARGET.name,
          description: TARGET.description,
          amount: null,
          deadline: TARGET.deadline,
          source_url: TARGET.source_url,
          wire: TARGET.wire,
        },
        {
          id: 8572,
          status: candidateStatus,
          duplicate_of_id: candidateStatus === 'duplicate' ? 8416 : null,
          name: 'Anthropic Fellows Program',
          description: null,
          amount: null,
          deadline: null,
          source_url: 'https://alignment.anthropic.com/x',
          wire: 'ai',
        },
      ];
      return { rows, rowCount: rows.length };
    }
    if (/WITH RECURSIVE duplicate_chain/.test(sql)) {
      return { rows: chainRows, rowCount: chainRows.length };
    }
    if (/WHERE id = \$1\s+FOR UPDATE/.test(sql)) {
      const row = options.parentRow || {
        id: chainRows[0]?.id,
        status: chainRows[0]?.status,
        duplicate_of_id: chainRows[0]?.duplicate_of_id ?? null,
        wire: TARGET.wire,
        source_url: 'https://alignment.anthropic.com/x',
      };
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE seen_urls/.test(sql)) return { rows: [], rowCount: 1 };
    if (/UPDATE scan_entries/.test(sql)) {
      const rowCount = options.updateRowCount ?? 1;
      return { rows: rowCount ? [{ id: params?.[0] ?? 1 }] : [], rowCount };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => calls.push({ sql: 'RELEASE', params: [] }) };
  return {
    calls,
    query,
    async connect() { return client; },
  };
}

test('same_listing resolves a multi-hop duplicate chain to the terminal row atomically', async () => {
  const pool = fakePool([{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false }]);
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());

  assert.equal(out, 'duplicate');
  assert.ok(pool.calls.some(call => call.sql === 'BEGIN'));
  assert.ok(pool.calls.some(call => /WITH RECURSIVE duplicate_chain/.test(call.sql)));
  const update = pool.calls.find(call => /SET status = 'duplicate'/.test(call.sql));
  assert.equal(update.params[1], 4200);
  assert.match(update.params[2], /resolved 2 hops to canonical #4200/);
  assert.match(update.sql, /parent\.duplicate_of_id IS NULL/);
  const registryUpdate = pool.calls.find(call => /UPDATE seen_urls/.test(call.sql));
  assert.deepEqual(registryUpdate.params, [TARGET.id, 4200]);
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('candidate state changes after verdict are rejected as stale', async () => {
  const pool = fakePool(
    [{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 1, cycle: false }],
    { currentCandidateStatus: 'duplicate' },
  );
  const out = await applyVerdict(pool, TARGET, [candidate({ status: 'approved' })], verdict());

  assert.equal(out, 'stale');
  assert.equal(pool.calls.some(call => /WITH RECURSIVE duplicate_chain/.test(call.sql)), false);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});

test('self-referential resolution blocks automatic demotion', async () => {
  const pool = fakePool([
    { id: TARGET.id, status: 'queued', duplicate_of_id: null, depth: 1, cycle: false },
  ]);
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());

  assert.equal(out, 'chain-unresolved');
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
  const note = pool.calls.find(call => /duplicate_chain_error/.test(call.sql));
  assert.match(note.params[1], /cycle-to-target/);
});

test('dead-end duplicate chain blocks automatic demotion and leaves an audit note', async () => {
  const pool = fakePool([{ id: 8416, status: 'duplicate', duplicate_of_id: null, depth: 1, cycle: false }]);
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());

  assert.equal(out, 'chain-unresolved');
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
  assert.ok(pool.calls.some(call => /duplicate_chain_error/.test(call.sql)));
});

test('cycle in duplicate chain blocks automatic demotion', async () => {
  const pool = fakePool([{ id: 8572, status: 'duplicate', duplicate_of_id: 8416, depth: 2, cycle: true }]);
  const resolution = await resolveDuplicateChain(pool, 8572);
  assert.deepEqual(resolution, { id: null, status: 'duplicate', depth: 2, error: 'cycle' });
});

test('approved match is validated from current database state', async () => {
  const pool = fakePool([
    { id: 8572, status: 'approved', duplicate_of_id: null, depth: 0, cycle: false },
  ]);
  const out = await applyVerdict(pool, TARGET, [candidate({ status: 'approved', resolve_to: null })], verdict());

  assert.equal(out, 'duplicate');
  assert.ok(pool.calls.some(call => /WITH RECURSIVE duplicate_chain/.test(call.sql)));
  const update = pool.calls.find(call => /SET status = 'duplicate'/.test(call.sql));
  assert.equal(update.params[1], 8572);
});

test('low-confidence same_listing only stamps metadata', async () => {
  const pool = fakePool();
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict({ confidence: 0.5 }));

  assert.equal(out, 'same_listing');
  assert.equal(pool.calls.some(call => call.sql === 'BEGIN'), true);
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
});

test('cross-wire same_listing stays queued for operator review', async () => {
  const pool = fakePool([], {
    lockedRows: [
      {
        id: TARGET.id,
        status: 'queued', duplicate_of_id: null,
        name: TARGET.name, description: TARGET.description,
        amount: null, deadline: TARGET.deadline,
        source_url: TARGET.source_url, wire: TARGET.wire,
      },
      {
        id: 8572,
        status: 'approved', duplicate_of_id: null,
        name: 'Anthropic Fellows Program', description: null,
        amount: null, deadline: null,
        source_url: 'https://alignment.anthropic.com/x', wire: 'oss',
      },
    ],
  });
  const out = await applyVerdict(
    pool,
    TARGET,
    [candidate({ status: 'approved', resolve_to: null, wire: 'oss' })],
    verdict(),
  );

  assert.equal(out, 'cross-wire-review');
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
  const note = pool.calls.find(call => /Cross-wire semantic match blocked/.test(String(call.params?.[1])));
  assert.ok(note, 'operator note should explain the blocked mutation');
});

test('same-wire candidate resolving to a cross-wire terminal stays queued', async () => {
  const pool = fakePool(
    [{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false }],
    { parentRow: { id: 4200, status: 'approved', duplicate_of_id: null, wire: 'crypto' } },
  );
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());

  assert.equal(out, 'cross-wire-review');
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
  const note = pool.calls.find(call => /terminal #4200 \[crypto\]/.test(String(call.params?.[1])));
  assert.ok(note, 'operator note should identify the cross-wire terminal');
});

test('inverse same-wire chain also blocks a terminal on another wire', async () => {
  const cryptoTarget = { ...TARGET, wire: 'crypto' };
  const pool = fakePool(
    [{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false }],
    {
      lockedRows: [
        {
          id: cryptoTarget.id, status: 'queued', duplicate_of_id: null,
          name: cryptoTarget.name, description: cryptoTarget.description,
          amount: null, deadline: cryptoTarget.deadline,
          source_url: cryptoTarget.source_url, wire: 'crypto',
        },
        {
          id: 8572, status: 'duplicate', duplicate_of_id: 8416,
          name: 'Anthropic Fellows Program', description: null,
          amount: null, deadline: null,
          source_url: 'https://alignment.anthropic.com/x', wire: 'crypto',
        },
      ],
      parentRow: { id: 4200, status: 'approved', duplicate_of_id: null, wire: 'ai' },
    },
  );
  const out = await applyVerdict(pool, cryptoTarget, [candidate({ wire: 'crypto' })], verdict());

  assert.equal(out, 'cross-wire-review');
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
});

test('same-wire chain without valid source identity stays queued', async () => {
  const matched = candidate({ status: 'duplicate', source_url: '', resolve_to: 4200 });
  const pool = fakePool(
    [{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 1, cycle: false }],
    {
      lockedRows: [
        {
          id: TARGET.id, status: 'queued', duplicate_of_id: null,
          name: TARGET.name, description: TARGET.description,
          amount: null, deadline: TARGET.deadline,
          source_url: TARGET.source_url, wire: TARGET.wire,
        },
        {
          id: matched.id, status: 'duplicate', duplicate_of_id: 4200,
          name: matched.name, description: null,
          amount: null, deadline: null,
          source_url: '', wire: TARGET.wire,
        },
      ],
      parentRow: {
        id: 4200, status: 'approved', duplicate_of_id: null,
        wire: TARGET.wire, source_url: '',
      },
    },
  );
  const out = await applyVerdict(pool, TARGET, [matched], verdict());
  assert.equal(out, 'canonical-review');
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
});

test('automatic duplicate compare-and-set constrains the terminal wire', async () => {
  const pool = fakePool([{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false }]);
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());
  assert.equal(out, 'duplicate');
  const update = pool.calls.find(call => /SET status = 'duplicate'/.test(call.sql));
  assert.match(update.sql, /parent\.wire = \$5/);
  assert.equal(update.params[4], TARGET.wire);
});

test('all 13 audited decided-recheck cases replay through the mutation gate', async t => {
  const rows = auditFixture.rows.filter(row => row.actor === 'decided-recheck');
  assert.equal(rows.length, 13);

  for (const row of rows) {
    await t.test(`#${row.id} ${row.verdict}`, async () => {
      const target = {
        id: row.id,
        wire: row.wire,
        name: row.name,
        description: `Audited child ${row.id}`,
        source_url: row.source_url,
        deadline: null,
      };
      const candidateId = 900000 + row.id;
      const terminalId = 800000 + row.id;
      const isSafe = row.verdict === 'correct duplicate';
      const matched = candidate({
        id: candidateId,
        wire: isSafe ? row.parent_wire : row.wire,
        name: isSafe ? row.parent_name : row.name,
        status: isSafe ? 'approved' : 'duplicate',
        source_url: isSafe ? row.parent_url : row.source_url,
        resolve_to: isSafe ? null : terminalId,
      });
      const pool = fakePool(
        [{
          id: isSafe ? candidateId : terminalId,
          status: 'approved', duplicate_of_id: null,
          depth: isSafe ? 0 : 1, cycle: false,
        }],
        {
          lockedRows: [
            {
              id: target.id, status: 'queued', duplicate_of_id: null,
              name: target.name, description: target.description,
              amount: null, deadline: null,
              source_url: target.source_url, wire: target.wire,
            },
            {
              id: candidateId,
              status: isSafe ? 'approved' : 'duplicate',
              duplicate_of_id: isSafe ? null : terminalId,
              name: matched.name, description: null,
              amount: null, deadline: null,
              source_url: matched.source_url, wire: matched.wire,
            },
          ],
          parentRow: {
            id: isSafe ? candidateId : terminalId,
            status: 'approved', duplicate_of_id: null,
            wire: row.parent_wire,
            source_url: row.parent_url,
          },
        },
      );

      const reviewedVerdict = {
        matched_id: candidateId,
        verdict: 'same_listing',
        confidence: 0.99,
        reason: row.verdict,
      };
      const out = await applyVerdict(pool, target, [matched], reviewedVerdict);
      const expected = isSafe
        ? row.wire === row.parent_wire
          ? 'duplicate'
          : 'cross-wire-review'
        : row.wire === row.parent_wire
          ? 'canonical-review'
          : 'cross-wire-review';
      assert.equal(out, expected);
      assert.equal(
        pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)),
        expected === 'duplicate',
      );
    });
  }
});

test('compare-and-set loss reports stale instead of claiming a mutation', async () => {
  const pool = fakePool(
    [{ id: 8572, status: 'approved', duplicate_of_id: null, depth: 0, cycle: false }],
    { updateRowCount: 0 },
  );
  const out = await applyVerdict(pool, TARGET, [candidate({ status: 'approved' })], verdict());
  assert.equal(out, 'stale');
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});
