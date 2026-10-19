require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isParallelFrontierIntake,
  normalizedFunderKey,
  parallelCallClosed,
  parallelFunderName,
  parallelProgramsMatch,
  parallelFrontierSkips,
  findExistingProgramRows,
} = require('../src/services/parallel-intake-gate');
const { normalizeProgramKey } = require('../src/services/program-identity');
const { runDailyIntake } = require('../src/jobs/daily-intake');

const NOW = new Date('2026-10-19T15:00:00.000Z');

function result(overrides = {}) {
  return {
    name: 'OpenSats General Fund',
    description: 'General support fund run by OpenSats.',
    deadline: 'Rolling',
    sourceUrl: 'https://opensats.org/apply',
    amount: null,
    ...overrides,
  };
}

test('parallel frontier intake is web-search variant P', () => {
  assert.equal(isParallelFrontierIntake('web-search', 'P'), true);
  assert.equal(isParallelFrontierIntake('web-search', 'W'), false);
  assert.equal(isParallelFrontierIntake('perplexity', 'P'), false);
  assert.equal(isParallelFrontierIntake('x-scan', 'A'), false);
});

test('funder normalization folds case and aliases', () => {
  assert.equal(normalizedFunderKey('Uniswap Foundation'), normalizedFunderKey('uniswap foundation'));
  assert.equal(normalizedFunderKey('EF'), normalizedFunderKey('Ethereum Foundation'));
});

test('a past deadline is closed and a deadline today stays open', () => {
  assert.equal(parallelCallClosed(result({ deadline: '2024-03-01' }), NOW), true);
  assert.equal(parallelCallClosed(result({ deadline: '2026-10-19' }), NOW), false);
  assert.equal(parallelCallClosed(result({ deadline: '2026-12-01' }), NOW), false);
  assert.equal(parallelCallClosed(result({ deadline: 'Rolling' }), NOW), false);
  assert.equal(parallelCallClosed(result({ deadline: 'None listed' }), NOW), false);
});

test('closed wording skips a call and closed-source does not', () => {
  assert.equal(parallelCallClosed(result({
    deadline: null,
    description: 'Applications are closed for this round.',
  }), NOW), true);
  assert.equal(parallelCallClosed(result({
    name: 'Gitcoin Grants (applications closed)',
    deadline: null,
    description: 'The round has closed.',
  }), NOW), true);
  assert.equal(parallelCallClosed(result({
    deadline: 'Closed',
    description: 'No further applications.',
  }), NOW), true);
  assert.equal(parallelCallClosed(result({
    name: 'Closed-source firmware grants',
    description: 'Funding for closed-source firmware maintainers.',
    deadline: null,
  }), NOW), false);
  assert.equal(parallelCallClosed(result({
    name: 'Closed-source firmware grants',
    description: 'Funding for closed-source firmware maintainers. Applications are closed.',
    deadline: null,
  }), NOW), true);
  assert.equal(parallelCallClosed(result({
    deadline: '2026-12-01',
    description: 'The previous round is closed. Applications are now open.',
  }), NOW), false);
  assert.equal(parallelCallClosed(result({
    deadline: null,
    description: 'The previous round closed and applications are now open.',
  }), NOW), false);
});

test('program identity matches funder plus program name and ignores the URL', () => {
  const incoming = {
    name: 'OpenSats — General Fund',
    description: 'Applications open. Run by OpenSats.',
    sourceUrl: 'https://blog.example.org/opensats-general-fund',
  };
  const existing = {
    name: 'OpenSats General Fund',
    orgName: 'OpenSats',
    canonicalName: 'OpenSats General Fund',
  };
  assert.equal(normalizeProgramKey(incoming.name), normalizeProgramKey(existing.name));
  assert.equal(parallelProgramsMatch(incoming, existing), true);
  assert.equal(parallelFunderName({ name: 'OpenSats — General Fund', description: '' }), 'OpenSats');
});

test('a different program from the same funder is not the same identity', () => {
  assert.equal(parallelProgramsMatch(
    { name: 'Ethereum Foundation Academic Grants', orgName: 'Ethereum Foundation' },
    { name: 'Ethereum Foundation Ecosystem Support Program', orgName: 'Ethereum Foundation' },
  ), false);
});

test('the same program name from a different funder is not the same identity', () => {
  assert.equal(parallelProgramsMatch(
    { name: 'Fellowship Program', orgName: 'Mozilla Foundation' },
    { name: 'Fellowship Program', orgName: 'Linux Foundation' },
  ), false);
});

test('a short funder spelling still matches the canonical program', () => {
  assert.equal(parallelProgramsMatch(
    { name: 'EF Ecosystem Support Program', description: 'Run by the Ethereum Foundation.' },
    { name: 'Ethereum Foundation Ecosystem Support Program', orgName: 'Ethereum Foundation' },
  ), true);
});

test('a later numbered round is a new program', () => {
  assert.equal(parallelProgramsMatch(
    { name: 'Uniswap Grants Round 5', orgName: 'Uniswap Foundation', sourceUrl: 'https://example.org/uniswap-round-5' },
    { name: 'Uniswap Grants Round 4', orgName: 'Uniswap Foundation' },
  ), false);
  assert.equal(parallelProgramsMatch(
    { name: 'Uniswap Grants Round 6', orgName: 'Uniswap Foundation' },
    { name: 'Uniswap Grants Round 4', orgName: 'Uniswap Foundation' },
  ), false);
});

test('a new year or cohort is a new program', () => {
  assert.equal(parallelProgramsMatch(
    { name: 'Anthropic Fellows Program (2026 cohort)', orgName: 'Anthropic', sourceUrl: 'https://example.org/fellows-2026' },
    { name: 'Anthropic Fellows Program (2025 cohort)', orgName: 'Anthropic' },
  ), false);
  assert.equal(parallelProgramsMatch(
    { name: 'Anthropic Fellows Program (Sept 2026 cohort)', orgName: 'Anthropic' },
    { name: 'Anthropic Fellows Program (July 2026 cohort)', orgName: 'Anthropic' },
  ), false);
});

test('the same round under a different URL is a duplicate', () => {
  assert.equal(parallelProgramsMatch(
    {
      name: 'Uniswap Grants — Round 4',
      orgName: 'Uniswap Foundation',
      sourceUrl: 'https://news.example.org/uniswap-round-4',
    },
    { name: 'Uniswap Grants Round 4', orgName: 'Uniswap Foundation' },
  ), true);
  assert.equal(parallelProgramsMatch(
    {
      name: 'Anthropic Fellows Program (Sept 2026 cohort)',
      orgName: 'Anthropic',
      sourceUrl: 'https://blog.example.org/anthropic-fellows-sept-2026',
    },
    { name: 'Anthropic Fellows Program (September 2026 cohort)', orgName: 'Anthropic' },
  ), true);
});

test('program lookup matches funder and program words, not the source URL', async () => {
  let seenSql = '';
  let seenParams = [];
  const pool = {
    async query(sql, params) {
      seenSql = sql;
      seenParams = params;
      return { rows: [] };
    },
  };
  await findExistingProgramRows(pool, 'crypto', { program: ['general'], funder: ['opensats'] });
  assert.match(seenSql, /ILIKE ALL/);
  assert.equal(seenSql.includes('source_url'), false);
  assert.match(seenSql, /status NOT IN \('duplicate', 'incomplete'\)/);
  assert.equal(seenParams[0], 'crypto');
  assert.deepEqual(seenParams[1], ['%general%']);
  assert.deepEqual(seenParams[2], ['%opensats%']);
});

test('parallelFrontierSkips drops a known program, a closed call, and a second copy', async () => {
  const pool = {
    async query() {
      return {
        rows: [{
          name: 'OpenSats General Fund',
          canonicalName: 'OpenSats General Fund',
          orgName: 'OpenSats',
        }],
      };
    },
  };
  const skips = await parallelFrontierSkips(pool, [
    {
      wire: 'oss',
      name: 'OpenSats General Fund',
      description: 'Same program, new page.',
      deadline: 'Rolling',
    },
    {
      wire: 'oss',
      name: 'OpenSats — General Fund',
      description: 'Second URL for the same fund.',
      deadline: 'Rolling',
    },
    {
      wire: 'oss',
      name: 'Brand New Maintainer Fund',
      description: 'Applications are closed.',
      deadline: null,
    },
    {
      wire: 'oss',
      name: 'Sovereign Tech Resilience Grants',
      description: 'New window run by the Sovereign Tech Agency.',
      deadline: '2026-12-01',
    },
  ], NOW);
  assert.deepEqual(skips, ['known_program', 'known_program', 'closed', null]);
});

test('a later round and a new cohort are kept; the same round is skipped', async () => {
  const pool = {
    async query() {
      return {
        rows: [
          {
            name: 'Uniswap Grants Round 4',
            canonicalName: 'Uniswap Grants Round 4',
            orgName: 'Uniswap Foundation',
          },
          {
            name: 'Anthropic Fellows Program (2025 cohort)',
            canonicalName: 'Anthropic Fellows Program',
            orgName: 'Anthropic',
          },
        ],
      };
    },
  };
  const skips = await parallelFrontierSkips(pool, [
    {
      wire: 'crypto',
      name: 'Uniswap Grants Round 5',
      description: 'Round 5, run by the Uniswap Foundation.',
      deadline: '2026-12-01',
    },
    {
      wire: 'crypto',
      name: 'Uniswap Grants Round 4',
      description: 'The same round on a new page, run by the Uniswap Foundation.',
      deadline: '2026-12-01',
    },
    {
      wire: 'ai',
      name: 'Anthropic Fellows Program (2026 cohort)',
      description: 'The 2026 cohort, run by Anthropic.',
      deadline: '2026-12-01',
    },
    {
      wire: 'crypto',
      name: 'Uniswap Grants Round 5',
      description: 'Second page for round 5, run by the Uniswap Foundation.',
      deadline: '2026-12-01',
    },
  ], NOW);
  assert.deepEqual(skips, [null, 'known_program', null, 'known_program']);
});

test('a failed program lookup still skips closed calls and keeps open ones', async () => {
  const pool = {
    async query() {
      throw new Error('db down');
    },
  };
  const skips = await parallelFrontierSkips(pool, [
    { wire: 'ai', name: 'OpenAI Cybersecurity Grant', description: 'Applications are closed.', deadline: null },
    { wire: 'ai', name: 'New Lab Fellowship', description: 'Applications are now open.', deadline: '2026-12-01' },
  ], NOW);
  assert.deepEqual(skips, ['closed', null]);
});

function parallelSubmission(results, variant = 'P', source = 'web-search') {
  return {
    wire: 'oss',
    promptVariant: variant,
    scanDate: '2026-10-19',
    source,
    results,
  };
}

function intakePool(existingRows, options = {}) {
  const calls = [];
  const insertedNames = [];
  const pool = {
    calls,
    insertedNames,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM seen_urls')) return { rows: [{ seeded: 1 }], rowCount: 1 };
      if (sql.includes('ILIKE ALL')) {
        if (options.lookupError) throw new Error('lookup failed');
        return { rows: existingRows, rowCount: existingRows.length };
      }
      if (sql.includes('INSERT INTO scan_entries')) {
        const width = 19;
        const count = Math.floor((params?.length || 0) / width);
        const rows = [];
        for (let i = 0; i < count; i++) {
          insertedNames.push(params[i * width]);
          rows.push({ id: 700 + i });
        }
        return { rows, rowCount: count };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

const EXISTING_OPENSATS = [{
  name: 'OpenSats General Fund',
  canonicalName: 'OpenSats General Fund',
  orgName: 'OpenSats',
}];

test('intake skips a known Parallel program and a closed call before insert', async () => {
  const pool = intakePool(EXISTING_OPENSATS);
  const summary = await runDailyIntake(pool, [parallelSubmission([
    result({
      name: 'OpenSats — General Fund',
      sourceUrl: 'https://news.example.org/opensats-general-fund-2026',
      description: 'The standing general fund, run by OpenSats.',
    }),
    result({
      name: 'Example Foundation Security Grants',
      sourceUrl: 'https://example.org/security-grants',
      description: 'Applications are closed.',
      deadline: '2024-03-01',
    }),
    result({
      name: 'Sovereign Tech Resilience Grants',
      sourceUrl: 'https://www.sovereign.tech/programs/resilience',
      description: 'New window run by the Sovereign Tech Agency.',
      deadline: '2026-12-01',
    }),
  ])], { insertOnly: true });

  assert.equal(summary.skippedParallel, 2);
  assert.equal(summary.totalIngested, 1);
  assert.deepEqual(pool.insertedNames, ['Sovereign Tech Resilience Grants']);
  const lookup = pool.calls.find(call => call.sql.includes('ILIKE ALL'));
  assert.ok(lookup);
  assert.equal(lookup.sql.includes('source_url'), false);
  assert.equal(lookup.params[0], 'oss');
});

test('intake keeps a later round and a new cohort, and skips the same round at a new URL', async () => {
  const pool = intakePool([
    {
      name: 'Uniswap Grants Round 4',
      canonicalName: 'Uniswap Grants Round 4',
      orgName: 'Uniswap Foundation',
    },
    {
      name: 'Anthropic Fellows Program (2025 cohort)',
      canonicalName: 'Anthropic Fellows Program',
      orgName: 'Anthropic',
    },
  ]);
  const summary = await runDailyIntake(pool, [parallelSubmission([
    result({
      name: 'Uniswap Grants Round 5',
      sourceUrl: 'https://example.org/uniswap-round-5',
      description: 'Round 5, run by the Uniswap Foundation.',
      deadline: '2026-12-01',
    }),
    result({
      name: 'Uniswap Grants — Round 4',
      sourceUrl: 'https://news.example.org/uniswap-round-4',
      description: 'The same round on a new page, run by the Uniswap Foundation.',
      deadline: '2026-12-01',
    }),
    result({
      name: 'Anthropic Fellows Program (2026 cohort)',
      sourceUrl: 'https://example.org/anthropic-fellows-2026',
      description: 'The 2026 cohort, run by Anthropic.',
      deadline: '2026-12-01',
    }),
  ])], { insertOnly: true });

  assert.equal(summary.skippedParallel, 1);
  assert.equal(summary.totalIngested, 2);
  assert.deepEqual(pool.insertedNames, [
    'Uniswap Grants Round 5',
    'Anthropic Fellows Program (2026 cohort)',
  ]);
});

test('a new open Parallel program is still inserted when nothing matches', async () => {
  const pool = intakePool([{
    name: 'Ethereum Foundation Academic Grants',
    canonicalName: 'Ethereum Foundation Academic Grants',
    orgName: 'Ethereum Foundation',
  }]);
  const summary = await runDailyIntake(pool, [parallelSubmission([
    result({
      name: 'Sovereign Tech Resilience Grants',
      sourceUrl: 'https://www.sovereign.tech/programs/resilience',
      description: 'New window run by the Sovereign Tech Agency.',
      deadline: '2026-12-01',
    }),
  ])], { insertOnly: true });

  assert.equal(summary.skippedParallel, 0);
  assert.equal(summary.totalIngested, 1);
  assert.deepEqual(pool.insertedNames, ['Sovereign Tech Resilience Grants']);
});

test('non-frontier submissions are not program-gated', async () => {
  const pool = intakePool(EXISTING_OPENSATS);
  const summary = await runDailyIntake(pool, [parallelSubmission([
    result({ deadline: '2024-03-01', description: 'Applications are closed.' }),
  ], 'W', 'web-search')], { insertOnly: true });

  assert.equal(summary.skippedParallel, 0);
  assert.equal(summary.totalIngested, 1);
  assert.equal(pool.calls.some(call => call.sql.includes('ILIKE ALL')), false);
});

test('a failed program lookup still drops a closed Parallel call', async () => {
  const pool = intakePool([], { lookupError: true });
  const summary = await runDailyIntake(pool, [parallelSubmission([
    result({
      name: 'Example Foundation Security Grants',
      description: 'Applications are closed.',
      deadline: null,
    }),
    result({
      name: 'Sovereign Tech Resilience Grants',
      description: 'New window run by the Sovereign Tech Agency.',
      deadline: '2026-12-01',
    }),
  ])], { insertOnly: true });

  assert.equal(summary.skippedParallel, 1);
  assert.deepEqual(pool.insertedNames, ['Sovereign Tech Resilience Grants']);
});
