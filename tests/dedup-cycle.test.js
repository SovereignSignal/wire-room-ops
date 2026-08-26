require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkDuplicate,
  isNewProgramCycle,
  isSameProgramCycle,
  extractCycleMarkers,
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

test('extractCycleMarkers reads numbered, seasonal, fiscal, and call cutoffs', () => {
  assert.deepEqual(extractCycleMarkers('Wikimedia Rapid Funds Cycle 3 FY2026-27').numbered, [
    { kind: 'cycle', value: '3' },
  ]);
  assert.equal(extractCycleMarkers('R Consortium ISC Grant Program 2026-2').numbered[0].kind, 'call');
  assert.equal(extractCycleMarkers('R Consortium ISC Grant Program 2026-2').numbered[0].value, '2026-2');
  assert.deepEqual(extractCycleMarkers('FreeCAD Grant Program Q4 2026').numbered, [
    { kind: 'quarter', value: '4' },
  ]);
  assert.deepEqual(extractCycleMarkers('Stellar SCF #46').numbered, [
    { kind: 'hash', value: '46' },
  ]);
  assert.deepEqual(extractCycleMarkers('Rocket Pool GMC Round 40').numbered, [
    { kind: 'round', value: '40' },
  ]);
});

test('isNewProgramCycle matches the live corpus cutoffs, not "the program exists"', () => {
  assert.equal(
    isNewProgramCycle(
      'Wikimedia Rapid Funds Cycle 3 FY2026-27',
      'Wikimedia Rapid Grants Cycle 2 2026',
    ),
    true,
  );
  assert.equal(
    isNewProgramCycle(
      'Wikimedia Rapid Funds Cycle 3 FY2026-27',
      'Wikimedia Rapid Funds Cycle 3 FY2026-27',
    ),
    false,
  );
  assert.equal(
    isNewProgramCycle(
      'Wikimedia Rapid Funds Cycle 3 FY2026-27',
      'Wikimedia Rapid Grants Cycle 3 2026',
    ),
    false,
    'same cycle number with FY vs calendar year is still that cycle',
  );
  assert.equal(
    isNewProgramCycle('R Consortium ISC Grant Program 2026-2', 'ISC Grant Program'),
    true,
  );
  assert.equal(
    isNewProgramCycle('R Consortium ISC Grant Program 2026-2', 'ISC Grant Program 2026-2'),
    false,
  );
  assert.equal(
    isNewProgramCycle('FreeCAD Grant Program Q4 2026', 'FreeCAD Grant Program Q3 2026'),
    true,
  );
  assert.equal(
    isNewProgramCycle('Stellar SCF #46', 'Stellar Community Fund'),
    true,
  );
  assert.equal(
    isNewProgramCycle('Rocket Pool GMC Round 40', 'Rocket Pool GMC Round 39'),
    true,
  );
  assert.equal(
    isNewProgramCycle('Wikimedia Rapid Grants', 'Wikimedia Rapid Grants Cycle 2 2026'),
    false,
    'generic incoming name is a reprint, not a new cutoff',
  );
});

test('isNewProgramCycle treats a later deadline as a new cutoff when names have no cycle markers', () => {
  assert.equal(
    isNewProgramCycle('ISC Grant Program', 'ISC Grant Program', '2026-09-15', '2026-03-01'),
    true,
  );
  assert.equal(
    isNewProgramCycle('ISC Grant Program', 'ISC Grant Program', '2026-03-01', '2026-03-01'),
    false,
  );
  assert.equal(
    isSameProgramCycle('ISC Grant Program', 'ISC Grant Program', '2026-03-01', '2026-03-01'),
    true,
  );
});

test('checkDuplicate: same official URL + new cycle name reaches review and cites the prior cycle', async () => {
  const pool = stubPool([
    {
      rows: [{
        first_seen_entry_id: 15496,
        name: 'Wikimedia Rapid Grants Cycle 2 2026',
        url: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
        deadline: '2026-06-30',
      }],
    },
    { rows: [{ id: 15496, name: 'Wikimedia Rapid Grants Cycle 2 2026', deadline: '2026-06-30', status: 'approved' }] },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
    name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27',
    wire: 'oss',
  });

  assert.equal(result.isDuplicate, false);
  assert.equal(result.matchType, null);
  assert.deepEqual(result.priorCycle, {
    entryId: 15496,
    name: 'Wikimedia Rapid Grants Cycle 2 2026',
  });
  assert.match(result.reason, /New cycle of #15496/);
  assert.equal(pool.calls.length, 2, 'URL match plus sibling scan; name layer must not re-kill the new cycle');
});

test('checkDuplicate: same official URL + later deadline is not a silent duplicate', async () => {
  const pool = stubPool([
    {
      rows: [{
        first_seen_entry_id: 2092,
        name: 'ISC Grant Program',
        url: 'https://r-consortium.org/all-projects/callforproposals.html',
        deadline: '2026-03-01',
      }],
    },
    { rows: [{ id: 2092, name: 'ISC Grant Program', deadline: '2026-03-01', status: 'approved' }] },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://r-consortium.org/all-projects/callforproposals.html',
    name: 'ISC Grant Program',
    wire: 'oss',
    deadline: '2026-09-15',
  });

  assert.equal(result.isDuplicate, false);
  assert.equal(result.priorCycle.entryId, 2092);
  assert.match(result.reason, /New cycle of #2092/);
});

test('checkDuplicate: same official URL + same cycle still duplicates', async () => {
  const pool = stubPool([
    {
      rows: [{
        first_seen_entry_id: 15496,
        name: 'Wikimedia Rapid Grants Cycle 2 2026',
        url: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
        deadline: null,
      }],
    },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
    name: 'Wikimedia Rapid Grants Cycle 2 2026',
    wire: 'oss',
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'url_exact');
  assert.equal(result.matchedEntryId, 15496);
  assert.equal(result.priorCycle, undefined);
  assert.equal(pool.calls.length, 1, 'same cycle must not open the sibling escape');
});

test('checkDuplicate: telegram-style generic reprint of a known official URL still dies', async () => {
  const pool = stubPool([
    {
      rows: [{
        first_seen_entry_id: 15496,
        name: 'Wikimedia Rapid Grants Cycle 2 2026',
        url: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
        deadline: null,
      }],
    },
  ]);

  const result = await checkDuplicate(
    pool,
    {
      sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
      name: 'Wikimedia Rapid Grants',
      wire: 'oss',
    },
    180,
    { urlOnly: true },
  );

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'url_exact');
  assert.equal(pool.calls.length, 1);
});

test('checkDuplicate: a later same-cycle sibling on the official URL still blocks', async () => {
  const pool = stubPool([
    {
      rows: [{
        first_seen_entry_id: 15496,
        name: 'Wikimedia Rapid Grants Cycle 2 2026',
        url: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
        deadline: null,
      }],
    },
    {
      rows: [
        { id: 15496, name: 'Wikimedia Rapid Grants Cycle 2 2026', deadline: null, status: 'approved' },
        { id: 15775, name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27', deadline: null, status: 'queued' },
      ],
    },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
    name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27',
    wire: 'oss',
    excludeEntryId: 15780,
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'url_exact');
  assert.equal(result.matchedEntryId, 15775);
  assert.equal(pool.calls.length, 2, 'same-cycle sibling should not fall through to the name layer');
});
